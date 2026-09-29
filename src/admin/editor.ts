// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { Block, BlockResponse, FormField } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash/plugin";
import { restrictionsHandler } from "../handlers/restrictions.js";
import { loadSettings } from "../handlers/settings.js";
import { getEntryRestrictions, normalizeContentRestriction } from "../restrictions.js";
import type { AccessPolicy, PaidAccessSettings, RouteContext } from "../types.js";
import { AGENTS_PAY_WARNING, answers, banner, confirmButton, context, failure, interaction, request, resultToast, str, summary } from "./shared.js";

// The panel auto-saves each answer instead of using a Block Kit form: EmDash
// 1.0.1 renders editor panels inside the entry editor's own <form>, so a nested
// panel form submits the editor instead of the plugin. Radios dispatch on
// change and the price field on blur, outside any form.

type People = "anyone" | "members";
type Agents = "free" | "pay" | "subscribers";
type State = { people: People; agents: Agents };

const PEOPLE_OPTIONS = [{ value: "anyone", label: "Anyone" }, { value: "members", label: "Members only" }];
const AGENT_LABELS: Record<Agents, string> = {
	free: "Free — they read it as Markdown",
	pay: "Pay per read (x402, USDC)",
	subscribers: "Only readers' agents with a subscriber token",
};
// Offering only the combinations that exist means an editor can't pick an invalid one.
const AGENT_OPTIONS: Record<People, Agents[]> = { anyone: ["free", "pay"], members: ["pay", "subscribers"] };

function policyFor({ people, agents }: State): AccessPolicy {
	if (people === "anyone") return agents === "pay" ? "agents-pay" : "public";
	return agents === "pay" ? "members" : "members-only";
}

// Switching who reads free keeps "pay" when agents already pay, and otherwise
// picks the one choice the new audience allows.
function withPeople(current: State, people: People): State {
	if (current.agents === "pay") return { people, agents: "pay" };
	return { people, agents: people === "anyone" ? "free" : "subscribers" };
}

const radio = (action_id: string, label: string, options: Array<{ value: string; label: string }>, initial_value: string): Block =>
	({ type: "actions", elements: [{ type: "radio", action_id, label, options, initial_value }] });

export async function editorPanel(route: RouteContext, ctx: PluginContext): Promise<BlockResponse> {
	const identity = route.ui?.entry;
	if (!identity || !ctx.content) return failure("Save this post first, then reopen Paid access.");
	const entry = await ctx.content.get(identity.collection, identity.id);
	if (!entry) return failure("This post couldn't be found. Reload the editor and try again.");
	const settings = await loadSettings(ctx);
	const target = { collectionSlug: identity.collection, contentId: identity.id, slug: entry.slug, title: typeof entry.data.title === "string" ? entry.data.title : null };
	const directRule = async () => {
		const rules = await getEntryRestrictions(ctx, identity.collection, identity.id, entry.slug);
		return { rules, direct: rules.find(r => "contentId" in r && r.contentId === identity.id) ?? rules.find(r => "contentId" in r) };
	};

	const i = interaction(route);
	let toast: BlockResponse["toast"];
	let pending: State | null = null;
	const save = async (state: State, extra: Record<string, unknown> = {}) => {
		const result = await restrictionsHandler(request(route, { ...target, ...extra, policy: policyFor(state) }), ctx);
		toast = resultToast(result, "Saved. Readers see the change on their next visit.");
	};

	if (i.type === "block_action") try {
		const { direct } = await directRule();
		const current: State = answers(direct?.policy ?? "public") as State;
		const price = direct?.agentPrice ?? null;
		if (i.action === "editor:people" && settings.humans.mode !== "delegate" && (i.value === "anyone" || i.value === "members")) {
			const next = withPeople(current, i.value);
			if (next.agents === "pay" && !price && settings.agents.mode !== "off") pending = next;
			else await save(next);
		} else if (i.action === "editor:agents" && (i.value === "free" || i.value === "pay" || i.value === "subscribers") && AGENT_OPTIONS[current.people].includes(i.value)) {
			const next: State = { people: current.people, agents: i.value as Agents };
			// Choosing "pay" before there's a price shows the price field; the price saves the rule.
			if (next.agents === "pay" && !price && settings.agents.mode !== "off") {
				pending = next;
				toast = { type: "info", message: "Enter a price per read. It saves when you leave the field." };
			} else await save(next);
		} else if (i.action.startsWith("editor:price:")) {
			const people = i.action.slice("editor:price:".length) === "members" ? "members" : "anyone";
			const value = str(i.value).trim();
			if (!value) pending = { people, agents: "pay" };
			else {
				await save({ people, agents: "pay" }, { agentPrice: value });
				if (toast?.type === "error") pending = { people, agents: "pay" };
			}
		} else if (i.action === "editor:plans") {
			const plans = Array.isArray(i.value) ? i.value.filter((v): v is string => typeof v === "string") : [];
			await save(current, { requiredPlanSlugs: plans });
		} else if (i.action === "editor:remove") {
			toast = resultToast(await restrictionsHandler(request(route, target, "DELETE"), ctx), "Rule removed. The post is free for everyone.");
		} else return failure("This action is unavailable. Reload the editor and try again.");
	} catch {
		toast = { type: "error", message: "Couldn't save. Try again." };
	} else if (i.type !== "panel_load") return failure("This action is unavailable. Reload the editor and try again.");

	const { rules, direct } = await directRule();
	return { blocks: await render(ctx, settings, identity, entry, rules, direct, pending), ...(toast ? { toast } : {}) };
}

async function render(
	ctx: PluginContext,
	s: PaidAccessSettings,
	identity: { collection: string; id: string },
	entry: { slug: string | null; status: string },
	rules: Awaited<ReturnType<typeof getEntryRestrictions>>,
	direct: Awaited<ReturnType<typeof getEntryRestrictions>>[number] | undefined,
	pending: State | null,
): Promise<Block[]> {
	const saved = summary(direct ?? { policy: "public" });
	const state: State = pending ?? answers(direct?.policy ?? "public") as State;
	const blocks: Block[] = [{ type: "fields", fields: [{ label: "People", value: saved.people }, { label: "AI agents", value: s.agents.mode === "off" ? "Off" : saved.agents }] }];

	const inherited = rules.filter(r => "taxonomyName" in r);
	if (inherited.length && ctx.taxonomies) {
		const [terms, taxonomies] = await Promise.all([ctx.taxonomies.getEntryTerms(identity.collection, identity.id), ctx.taxonomies.getAll()]);
		for (const r of inherited) {
			const term = terms.find(t => t.taxonomy === r.taxonomyName && t.id === r.termId);
			const taxonomy = taxonomies.find(t => t.name === r.taxonomyName);
			const label = summary(r);
			blocks.push(context(`Also covered by ${taxonomy?.labelSingular || r.taxonomyName}: ${term?.label || r.termId} → People: ${label.people} · AI agents: ${label.agents}`));
		}
	}
	const legacy = entry.slug && entry.slug !== identity.id ? normalizeContentRestriction(await ctx.storage.restrictions.get(`${identity.collection}:${entry.slug}`)) : null;
	if (legacy) blocks.push(banner("An older Paid Access rule also covers this post. Remove the rule here to clear both saved versions before choosing new access.", "alert"));
	const delegated = s.humans.mode === "delegate";
	if (!delegated && await ctx.kv.get("state:legacyPluginPresent") === true) blocks.push(context("Restrict With Stripe may also restrict this post. Review its rule in the Restrict panel; this panel can't read that plugin's rules."));

	if (delegated) blocks.push(context("Restrict With Stripe decides who can read this post on your site. Here you choose what AI agents pay."));
	else blocks.push(radio("editor:people", "Who can read it for free?", PEOPLE_OPTIONS, state.people));
	blocks.push(radio("editor:agents", "What about AI agents?", AGENT_OPTIONS[state.people].map(value => ({ value, label: AGENT_LABELS[value] })), state.agents));
	if (state.agents === "pay") {
		const price: FormField = { type: "text_input", action_id: `editor:price:${state.people}`, label: "Price per read (USD)", initial_value: direct?.agentPrice ?? "", placeholder: "$0.05" };
		blocks.push({ type: "actions", elements: [price] }, context("Agents pay this in USDC before they get the full post, up to six decimals. It saves when you leave the field."));
	}
	if (state.people === "members" && s.humans.mode === "stripe") {
		blocks.push(s.humans.plans.length
			? { type: "actions", elements: [{ type: "checkbox", action_id: "editor:plans", label: "Plans that include it", options: s.humans.plans.map(p => ({ value: p.slug, label: p.name })), initial_value: direct?.requiredPlanSlugs ?? [] }] }
			: context("Add a plan under Paid Access → Settings → Members first."));
	}
	blocks.push(context("Changes save as you make them."));

	const policy = direct?.policy;
	if (policy === "agents-pay" && !delegated) blocks.push(banner(AGENTS_PAY_WARNING, "alert"));
	if (s.agents.mode === "off") blocks.push(banner("AI agent sales are off for this site. Turn them on in Paid Access → Settings."));
	if (s.humans.mode === "off" && rules.some(r => r.policy === "members" || r.policy === "members-only")) blocks.push(banner("Member access is off, so people can't unlock this post. Turn on Members in Paid Access → Settings.", "alert"));
	if (entry.status === "published" && entry.slug && s.agents.mode === "paid" && rules.some(r => r.policy === "agents-pay" || r.policy === "members") && !rules.some(r => r.policy === "members-only")) {
		blocks.push(context(`Agents can buy it at ${s.agentRoutePrefix}/${encodeURIComponent(identity.collection)}/${encodeURIComponent(entry.slug)}.md`));
	}
	if (direct) blocks.push({ type: "actions", elements: [confirmButton("editor:remove", "Remove rule", "Remove this rule?", "The post becomes free for everyone.")] });
	return blocks;
}
