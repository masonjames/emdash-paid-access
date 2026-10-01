// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { Block, BlockResponse, FormField } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash/plugin";
import { restrictionsHandler } from "../handlers/restrictions.js";
import { loadSettings } from "../handlers/settings.js";
import { getEntryRestrictions, normalizeAgentPrice, normalizeContentRestriction, priceFromInput } from "../restrictions.js";
import type { AccessPolicy, ContentRestrictionRecord, PaidAccessSettings, RouteContext } from "../types.js";
import { AGENTS_PAY_WARNING, banner, confirmButton, context, failure, interaction, request, str, summary } from "./shared.js";

// The panel auto-saves each answer instead of using a Block Kit form: EmDash
// 1.0.1 renders editor panels inside the entry editor's own <form>, so a nested
// panel form submits the editor instead of the plugin. Radios dispatch on
// change and the price field on blur, outside any form.
//
// Block Kit sends only an action's id and value, so each id carries revisions:
// the stored rules', and a per-post panel generation every action claims. A
// stale action is refused instead of overwriting a newer one, even when the
// newer one saved nothing. Every choice is read from storage and saved at once,
// except "Pay per read" without a price, which the id carries until the price
// arrives.
// ponytail: the changing ids remount the controls after each save, so keyboard
// focus leaves them; fixing that needs Block Kit to echo panel state apart
// from React keys. Plugin storage has no multi-key transactions, so the claim,
// the rule write and a legacy-plus-ID removal are separate compare-and-sets: an
// action stalled for seconds between them can still land after a newer one.

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

type Stored = {
	rules: Awaited<ReturnType<typeof getEntryRestrictions>>;
	own: ContentRestrictionRecord | null;
	legacy: ContentRestrictionRecord | null;
	rev: string;
};
type Saved = "ok" | "stale" | "error";

export async function editorPanel(route: RouteContext, ctx: PluginContext): Promise<BlockResponse> {
	const identity = route.ui?.entry;
	if (!identity || !ctx.content) return failure("Save this post first, then reopen Paid access.");
	const entry = await ctx.content.get(identity.collection, identity.id);
	if (!entry) return failure("This post couldn't be found. Reload the editor and try again.");
	const settings = await loadSettings(ctx);
	const target = { collectionSlug: identity.collection, contentId: identity.id, slug: entry.slug, title: typeof entry.data.title === "string" ? entry.data.title : null };
	const legacyKey = entry.slug && entry.slug !== identity.id ? `${identity.collection}:${entry.slug}` : null;
	const generationKey = `editor-generation:${identity.collection}:${identity.id}`;
	// Rules and revisions come from the same reads, so a panel never pairs one rule with another's revision.
	const load = async (): Promise<Stored> => {
		const [rules, generation, own, legacy] = await Promise.all([
			getEntryRestrictions(ctx, identity.collection, identity.id, entry.slug),
			ctx.kv.getVersioned(generationKey),
			ctx.storage.restrictions.getVersioned(`${identity.collection}:${identity.id}`),
			legacyKey ? ctx.storage.restrictions.getVersioned(legacyKey) : null,
		]);
		const direct = { own: own ? normalizeContentRestriction(own.value) : null, legacy: legacy ? normalizeContentRestriction(legacy.value) : null };
		return { rules: [...[direct.own, direct.legacy].filter(r => r !== null), ...rules.filter(r => "taxonomyName" in r)], ...direct,
			rev: `${generation?.revision ?? ""}~${own?.revision ?? ""}~${legacy?.revision ?? ""}` };
	};

	const i = interaction(route);
	let toast: BlockResponse["toast"];
	let pendingPay = false;
	if (i.type === "block_action") try {
		const [head = "", rev, pending] = i.action.split("|");
		const kind = head.startsWith("editor:") ? head.slice("editor:".length) : "";
		const stored = await load();
		const current: State = stored.own ? STATES[stored.own.policy] : { people: "anyone", agents: "none" };
		const shown: State = pending === "pay" ? { ...current, agents: "pay" } : current;
		const price = stored.own && SALE.includes(stored.own.policy) ? stored.own.agentPrice : null;
		const value = str(i.value);
		const typed = (kind === "price" ? str(priceFromInput(value)) : value).trim();
		// Everything that needs no write is settled before the action claims the panel,
		// so an unchanged blur or a refused value can't refuse the next click.
		const valid = kind === "people" ? settings.humans.mode !== "delegate" && (value === "anyone" || value === "members")
			: kind === "agents" ? AGENT_OPTIONS[current.people].includes(value as Agents)
			: kind === "price" ? shown.agents === "pay"
			: kind === "plans" ? current.people === "members"
			: kind === "remove";
		if (!valid || rev === undefined) return failure("This action is unavailable. Reload the editor and try again.");
		const [generationRev = "", ownRev = "", legacyRev = ""] = rev.split("~");
		const stale = () => { toast = { type: "error", message: "This post's access changed since the panel loaded. Check the choices and try again." }; };
		const unchanged = kind === "price" ? typed === (price ?? "") : kind === "people" ? value === shown.people : kind === "agents" && value === shown.agents;
		if (rev !== stored.rev) stale();
		else if (unchanged) pendingPay = shown.agents === "pay" && current.agents !== "pay";
		else if (stored.legacy && kind !== "remove") toast = { type: "error", message: "Remove the older rule first, then choose new access." };
		else if (kind === "price" && !normalizeAgentPrice(typed)) {
			toast = { type: "error", message: typed ? "Enter a price like $0.05, with at most six decimals." : "Enter a price per read, or choose another option for AI agents." };
			pendingPay = current.agents !== "pay";
		}
		// Claiming the generation orders this panel's actions: an older one loses.
		else if (!(await ctx.kv.compareAndSet(generationKey, generationRev || null, Date.now())).applied) stale();
		else {
			const done = (result: unknown, message: string): Saved => {
				const r = result as { ok?: boolean; error?: string; stale?: boolean };
				if (r.stale) {
					stale();
					return "stale";
				}
				toast = r.ok === false ? { type: "error", message: r.error || "Couldn't save. Try again." } : { type: "success", message };
				return r.ok === false ? "error" : "ok";
			};
			const remove = async () => done(await restrictionsHandler(request(route, { ...target, expectedRevision: ownRev, expectedLegacyRevision: legacyRev }, "DELETE"), ctx), "Rule removed. Site defaults and category or tag rules still apply.");
			const save = async (next: State, extra: Record<string, unknown> = {}) => {
				const policy = policyOf(next);
				if (!policy) return remove();
				return done(await restrictionsHandler(request(route, { ...target, ...extra, policy, agentPrice: next.agents === "pay" ? extra.agentPrice ?? price : null, expectedRevision: ownRev }), ctx), "Saved. Readers see the change on their next visit.");
			};
			// Pay without a price waits for one; everything else saves at once.
			const needsPrice = (next: State) => next.agents === "pay" && !price && settings.agents.mode !== "off";
			const askForPrice = () => {
				pendingPay = true;
				toast ??= { type: "info", message: "Enter a price per read. It saves when you leave the field." };
			};
			if (kind === "people" && (value === "anyone" || value === "members")) {
				const next: State = { people: value, agents: shown.agents === "pay" ? "pay" : AGENT_OPTIONS[value].includes(current.agents) ? current.agents : "none" };
				const plans = value === "anyone" ? { requiredPlanSlugs: [] } : {};
				if (needsPrice(next)) {
					// Save the audience now, so no later action can undo it; the price saves Pay.
					if (await save({ people: value, agents: "none" }, plans) === "ok") askForPrice();
				} else await save(next, plans);
			} else if (kind === "agents") {
				const next: State = { people: current.people, agents: value as Agents };
				if (needsPrice(next)) askForPrice();
				else await save(next);
			} else if (kind === "price") {
				await save({ people: current.people, agents: "pay" }, { agentPrice: typed });
			} else if (kind === "plans") {
				const plans = Array.isArray(i.value) ? i.value.filter((v): v is string => typeof v === "string") : [];
				if (await save(current, { requiredPlanSlugs: plans }) === "ok") pendingPay = shown.agents === "pay" && current.agents !== "pay";
			} else await remove();
		}
	} catch {
		toast = { type: "error", message: "Couldn't save. Try again." };
	} else if (i.type !== "panel_load") return failure("This action is unavailable. Reload the editor and try again.");

	const stored = await load();
	// After a refused save, remount the controls so they show what's saved.
	const epoch = toast?.type === "error" ? crypto.randomUUID() : "0";
	return { blocks: await render(ctx, settings, identity, entry, stored, pendingPay, epoch), ...(toast ? { toast } : {}) };
}

async function render(
	ctx: PluginContext,
	s: PaidAccessSettings,
	identity: { collection: string; id: string },
	entry: { slug: string | null; status: string },
	{ rules, own, legacy, rev }: Stored,
	pendingPay: boolean,
	epoch: string,
): Promise<Block[]> {
	const delegated = s.humans.mode === "delegate";
	const direct = own ?? legacy;
	const current: State = own ? STATES[own.policy] : { people: "anyone", agents: "none" };
	const state: State = pendingPay ? { ...current, agents: "pay" } : current;
	const id = (kind: string) => `editor:${kind}|${rev}|${pendingPay ? "pay" : ""}`;
	const radio = (kind: string, label: string, options: Array<{ value: string; label: string }>, initial_value: string): Block =>
		({ type: "actions", block_id: `editor:${kind}/${epoch}`, elements: [{ type: "radio", action_id: id(kind), label, options, initial_value }] });

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
	const remove: Block = { type: "actions", block_id: `editor:remove/${epoch}`, elements: [confirmButton(id("remove"), "Remove rule", "Remove this rule?", "Category and tag rules, and other plugins, still apply.")] };
	// An older slug-keyed rule must go before new choices, so nothing edits around it.
	if (legacy) return [...blocks, banner("An older Paid Access rule also covers this post. Remove the rule here to clear both saved versions, then choose new access.", "alert"), remove];
	if (!delegated && await ctx.kv.get("state:legacyPluginPresent") === true) blocks.push(context("Restrict With Stripe may also restrict this post. Review its rule in the Restrict panel; this panel can't read that plugin's rules."));

	if (delegated) blocks.push(context("Restrict With Stripe decides who can read this post on your site. Here you choose what AI agents get."));
	else blocks.push(radio("people", "Who can read it for free?", [{ value: "anyone", label: "Anyone" }, { value: "members", label: "Members only" }], state.people));
	blocks.push(radio("agents", "What about AI agents?", AGENT_OPTIONS[state.people].map(value => ({ value, label: agentsLabels[value] })), state.agents));
	if (state.agents === "pay") {
		const price: FormField = { type: "text_input", action_id: id("price"), label: "Price per read (USD)", initial_value: own && SALE.includes(own.policy) ? own.agentPrice ?? "" : "", placeholder: "$0.05" };
		blocks.push({ type: "actions", block_id: `editor:price/${epoch}`, elements: [price] }, context("Agents pay this in USDC before they get the full post, up to six decimals. It saves when you leave the field."));
	}
	if (state.people === "members" && s.humans.mode === "stripe") {
		blocks.push(s.humans.plans.length
			? { type: "actions", block_id: `editor:plans/${epoch}`, elements: [{ type: "checkbox", action_id: id("plans"), label: "Plans that include it", options: s.humans.plans.map(p => ({ value: p.slug, label: p.name })), initial_value: own?.requiredPlanSlugs ?? [] }] }
			: context("Add a plan under Paid Access → Settings → Members first."));
	}
	blocks.push(context("Changes save as you make them."));

	const policy = own?.policy;
	if (policy === "agents-pay" && !delegated) blocks.push(banner(AGENTS_PAY_WARNING, "alert"));
	if (policy === "public" && delegated) blocks.push(banner("Free Markdown includes the whole post. If Restrict With Stripe limits this post to members, choose Pay per read or Not offered.", "alert"));
	if (s.agents.mode === "off") blocks.push(banner("AI agent sales are off for this site. Turn them on in Paid Access → Settings."));
	if (s.humans.mode === "off" && rules.some(r => r.policy === "members" || r.policy === "members-only")) blocks.push(banner("Member access is off, so people can't unlock this post. Turn on Members in Paid Access → Settings.", "alert"));
	if (entry.status === "published" && entry.slug && s.agents.mode === "paid" && rules.some(r => SALE.includes(r.policy)) && !rules.some(r => r.policy === "members-only")) {
		blocks.push(context(`Agents can buy it at ${s.agentRoutePrefix}/${encodeURIComponent(identity.collection)}/${encodeURIComponent(entry.slug)}.md`));
	}
	if (own) blocks.push(remove);
	return blocks;
}
