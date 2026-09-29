// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { Block, BlockResponse, FormField } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash/plugin";
import { restrictionsHandler } from "../handlers/restrictions.js";
import { loadSettings } from "../handlers/settings.js";
import { getEntryRestrictions, normalizeContentRestriction } from "../restrictions.js";
import type { AccessPolicy, PaidAccessSettings, RouteContext } from "../types.js";
import { AGENTS_PAY_WARNING, banner, confirmButton, context, failure, interaction, request, str, summary } from "./shared.js";

// The panel auto-saves each answer instead of using a Block Kit form: EmDash
// 1.0.1 renders editor panels inside the entry editor's own <form>, so a nested
// panel form submits the editor instead of the plugin. Radios dispatch on
// change and the price field on blur, outside any form.
//
// Block Kit sends only an action's id and value, so each id also carries the
// choices on screen and the rule's storage revision: a stale action is refused
// instead of overwriting a newer save, and "Pay per read" waits for its price.

type People = "anyone" | "members";
type Agents = "none" | "free" | "pay";
type State = { people: People; agents: Agents };

const AGENT_OPTIONS: Record<People, Agents[]> = { anyone: ["none", "free", "pay"], members: ["pay", "none"] };
const SALE: AccessPolicy[] = ["agents-pay", "members"];
const STATES: Record<AccessPolicy, State> = {
	public: { people: "anyone", agents: "free" },
	"agents-pay": { people: "anyone", agents: "pay" },
	members: { people: "members", agents: "pay" },
	"members-only": { people: "members", agents: "none" },
};

// "Anyone" with agents not offered is no rule at all.
function policyOf({ people, agents }: State): AccessPolicy | null {
	if (people === "anyone") return agents === "free" ? "public" : agents === "pay" ? "agents-pay" : null;
	return agents === "pay" ? "members" : "members-only";
}

const actionId = (kind: string, s: State, rev: string) => `editor:${kind}|${s.people}|${s.agents}|${rev}`;
function parseAction(id: string) {
	const [head = "", people, agents, rev = ""] = id.split("|");
	if (!head.startsWith("editor:") || (people !== "anyone" && people !== "members") || !AGENT_OPTIONS[people].includes(agents as Agents)) return null;
	return { kind: head.slice("editor:".length), seen: { people, agents: agents as Agents } as State, rev };
}
const radio = (block: string, epoch: string, action_id: string, label: string, options: Array<{ value: string; label: string }>, initial_value: string): Block =>
	({ type: "actions", block_id: `${block}/${epoch}`, elements: [{ type: "radio", action_id, label, options, initial_value }] });

export async function editorPanel(route: RouteContext, ctx: PluginContext): Promise<BlockResponse> {
	const identity = route.ui?.entry;
	if (!identity || !ctx.content) return failure("Save this post first, then reopen Paid access.");
	const entry = await ctx.content.get(identity.collection, identity.id);
	if (!entry) return failure("This post couldn't be found. Reload the editor and try again.");
	const settings = await loadSettings(ctx);
	const key = `${identity.collection}:${identity.id}`;
	const target = { collectionSlug: identity.collection, contentId: identity.id, slug: entry.slug, title: typeof entry.data.title === "string" ? entry.data.title : null };
	const load = async () => {
		const [rules, versioned] = await Promise.all([getEntryRestrictions(ctx, identity.collection, identity.id, entry.slug), ctx.storage.restrictions.getVersioned(key)]);
		// A legacy slug-keyed rule stands in until a rule is saved under the ID.
		const direct = rules.find(r => "contentId" in r && r.contentId === identity.id) ?? rules.find(r => "contentId" in r);
		return { rules, direct, rev: versioned?.revision ?? "" };
	};

	const i = interaction(route);
	let toast: BlockResponse["toast"];
	let pending: State | null = null;
	const stale = () => { toast = { type: "error", message: "This post's access changed since the panel loaded. Check the choices and try again." }; };
	const saved = (result: unknown, message: string): "ok" | "stale" | "error" => {
		const r = result as { ok?: boolean; error?: string; stale?: boolean };
		if (r.stale) {
			stale();
			return "stale";
		}
		toast = r.ok === false ? { type: "error", message: r.error || "Couldn't save. Try again." } : { type: "success", message };
		return r.ok === false ? "error" : "ok";
	};

	if (i.type === "block_action") try {
		const parsed = parseAction(i.action);
		const { direct, rev } = await load();
		if (!parsed || parsed.kind === "") return failure("This action is unavailable. Reload the editor and try again.");
		if (parsed.rev !== rev) stale();
		else {
			const { kind, seen } = parsed;
			const storedPrice = direct && SALE.includes(direct.policy) ? direct.agentPrice : null;
			// Applies the choices on screen, or holds "Pay per read" until it has a price.
			const apply = async (next: State, extra: Record<string, unknown> = {}) => {
				const policy = policyOf(next);
				if (!policy) return saved(await restrictionsHandler(request(route, { ...target, expectedRevision: rev }, "DELETE"), ctx), "Saved. AI agents aren't offered this post.");
				const price = next.agents === "pay" ? (extra.agentPrice as string | undefined) ?? storedPrice : null;
				if (next.agents === "pay" && !price && settings.agents.mode !== "off") {
					pending = next;
					toast ??= { type: "info", message: "Enter a price per read. It saves when you leave the field." };
					return "pending";
				}
				return saved(await restrictionsHandler(request(route, { ...target, ...extra, policy, agentPrice: price, expectedRevision: rev }), ctx), "Saved. Readers see the change on their next visit.");
			};
			const value = str(i.value);
			if (kind === "people" && settings.humans.mode !== "delegate" && (value === "anyone" || value === "members")) {
				// Keep the agents choice when the new audience allows it.
				await apply({ people: value, agents: AGENT_OPTIONS[value].includes(seen.agents) ? seen.agents : "none" });
			} else if (kind === "agents" && AGENT_OPTIONS[seen.people].includes(value as Agents)) {
				await apply({ people: seen.people, agents: value as Agents });
			} else if (kind === "price" && seen.agents === "pay") {
				const price = value.trim();
				// A rejected price keeps the field open; a stale one shows what's saved.
				if (price) { if (await apply(seen, { agentPrice: price }) === "error") pending = seen; }
				else if (storedPrice) toast = { type: "error", message: "Enter a price per read, or choose another option for AI agents." };
				else pending = seen;
			} else if (kind === "plans") {
				await apply(seen, { requiredPlanSlugs: Array.isArray(i.value) ? i.value.filter((v): v is string => typeof v === "string") : [] });
			} else if (kind === "remove") {
				saved(await restrictionsHandler(request(route, { ...target, expectedRevision: rev }, "DELETE"), ctx), "Rule removed.");
			} else return failure("This action is unavailable. Reload the editor and try again.");
		}
	} catch {
		toast = { type: "error", message: "Couldn't save. Try again." };
	} else if (i.type !== "panel_load") return failure("This action is unavailable. Reload the editor and try again.");

	const { rules, direct, rev } = await load();
	// After a refused save, remount the controls so they show what's saved.
	const epoch = toast?.type === "error" ? crypto.randomUUID() : "0";
	return { blocks: await render(ctx, settings, identity, entry, rules, direct, rev, pending, epoch), ...(toast ? { toast } : {}) };
}

async function render(
	ctx: PluginContext,
	s: PaidAccessSettings,
	identity: { collection: string; id: string },
	entry: { slug: string | null; status: string },
	rules: Awaited<ReturnType<typeof getEntryRestrictions>>,
	direct: Awaited<ReturnType<typeof getEntryRestrictions>>[number] | undefined,
	rev: string,
	pending: State | null,
	epoch: string,
): Promise<Block[]> {
	const delegated = s.humans.mode === "delegate";
	const state: State = pending ?? (direct ? STATES[direct.policy] : { people: "anyone", agents: "none" });
	const noneLabel = state.people === "members" ? "Not sold to agents" : s.agents.freeByDefault ? "Site default: free Markdown" : "Not offered";
	const agentsLabels: Record<Agents, string> = { none: noneLabel, free: "Free — they read it as Markdown", pay: "Pay per read (x402, USDC)" };
	const savedAgents = s.agents.mode === "off" ? "Off" : direct ? summary(direct).agents : s.agents.freeByDefault ? "Free (site default)" : "Not offered";
	const blocks: Block[] = [{ type: "fields", fields: [{ label: "People", value: direct ? summary(direct).people : "Anyone" }, { label: "AI agents", value: savedAgents }] }];

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
	if (!delegated && await ctx.kv.get("state:legacyPluginPresent") === true) blocks.push(context("Restrict With Stripe may also restrict this post. Review its rule in the Restrict panel; this panel can't read that plugin's rules."));

	if (delegated) blocks.push(context("Restrict With Stripe decides who can read this post on your site. Here you choose what AI agents get."));
	else blocks.push(radio("editor:people", epoch, actionId("people", state, rev), "Who can read it for free?", [{ value: "anyone", label: "Anyone" }, { value: "members", label: "Members only" }], state.people));
	blocks.push(radio("editor:agents", epoch, actionId("agents", state, rev), "What about AI agents?", AGENT_OPTIONS[state.people].map(value => ({ value, label: agentsLabels[value] })), state.agents));
	if (state.agents === "pay") {
		const price: FormField = { type: "text_input", action_id: actionId("price", state, rev), label: "Price per read (USD)", initial_value: direct && SALE.includes(direct.policy) ? direct.agentPrice ?? "" : "", placeholder: "$0.05" };
		blocks.push({ type: "actions", block_id: `editor:price/${epoch}`, elements: [price] }, context("Agents pay this in USDC before they get the full post, up to six decimals. It saves when you leave the field."));
	}
	if (state.people === "members" && s.humans.mode === "stripe") {
		blocks.push(s.humans.plans.length
			? { type: "actions", block_id: `editor:plans/${epoch}`, elements: [{ type: "checkbox", action_id: actionId("plans", state, rev), label: "Plans that include it", options: s.humans.plans.map(p => ({ value: p.slug, label: p.name })), initial_value: direct?.requiredPlanSlugs ?? [] }] }
			: context("Add a plan under Paid Access → Settings → Members first."));
	}
	blocks.push(context("Changes save as you make them."));

	const policy = direct?.policy;
	if (policy === "agents-pay" && !delegated) blocks.push(banner(AGENTS_PAY_WARNING, "alert"));
	if (policy === "public" && delegated) blocks.push(banner("Free Markdown includes the whole post. If Restrict With Stripe limits this post to members, choose Pay per read or Not offered.", "alert"));
	if (s.agents.mode === "off") blocks.push(banner("AI agent sales are off for this site. Turn them on in Paid Access → Settings."));
	if (s.humans.mode === "off" && rules.some(r => r.policy === "members" || r.policy === "members-only")) blocks.push(banner("Member access is off, so people can't unlock this post. Turn on Members in Paid Access → Settings.", "alert"));
	if (entry.status === "published" && entry.slug && s.agents.mode === "paid" && rules.some(r => SALE.includes(r.policy)) && !rules.some(r => r.policy === "members-only")) {
		blocks.push(context(`Agents can buy it at ${s.agentRoutePrefix}/${encodeURIComponent(identity.collection)}/${encodeURIComponent(entry.slug)}.md`));
	}
	if (direct) blocks.push({ type: "actions", block_id: `editor:remove/${epoch}`, elements: [confirmButton(actionId("remove", state, rev), "Remove rule", "Remove this rule?", "Category and tag rules, and other plugins, still apply.")] });
	return blocks;
}
