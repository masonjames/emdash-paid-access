// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { Block, BlockResponse, FormField } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash/plugin";
import { agentsNeverFree, loadSettings } from "../handlers/settings.js";
import { getEntryRestrictions, highestAgentPrice, normalizeAgentPrice, normalizeContentRestriction, priceFromInput } from "../restrictions.js";
import { resolveAccess } from "../resolver.js";
import type { AccessPolicy, ContentRestrictionRecord, RouteContext } from "../types.js";
import { nowIso } from "../utils.js";
import { AGENTS_PAY_WARNING, banner, context, failure, interaction, link, str } from "./shared.js";

const labels: Record<AccessPolicy, string> = {
	public: "Public — free machine-readable copy",
	"agents-pay": "Public page + paid machine-readable copy",
	"members-only": "Members only — machine-readable read not offered",
	members: "Members or paid read",
};
class ValidationError extends Error {}

const paidPolicies = ["agents-pay", "members"];
const memberPolicies = ["members-only", "members"];
const legacyMessage = "An older rule needs migration before editing. Ask the site maintainer to consolidate this entry’s slug and ID rules in one database transaction, preserving the strongest policy.";
const delegatedMessage = "This entry also has a Paid Access membership rule. Editing here could change website access. Ask the site maintainer to review it under Advanced rules before changing the machine-readable copy.";

export async function editorPanel(route: RouteContext, ctx: PluginContext): Promise<BlockResponse> {
	const identity = route.ui?.entry;
	if (!identity || !ctx.content) return failure("Save this post first, then reopen Paid access.");
	const entry = await ctx.content.get(identity.collection, identity.id);
	if (!entry) return failure("This post couldn't be found. Reload the editor and try again.");
	const settings = await loadSettings(ctx);
	const delegated = settings.humans.mode === "delegate";
	const neverFree = await agentsNeverFree(ctx, settings);
	const key = `${identity.collection}:${identity.id}`;
	const legacyKey = entry.slug && entry.slug !== identity.id ? `${identity.collection}:${entry.slug}` : null;
	const load = async () => {
		const [version, legacy, rules] = await Promise.all([
			ctx.storage.restrictions.getVersioned(key),
			legacyKey ? ctx.storage.restrictions.getVersioned(legacyKey) : null,
			getEntryRestrictions(ctx, identity.collection, identity.id, entry.slug),
		]);
		const own = version ? normalizeContentRestriction(version.value) : null;
		if (version && (!own || own.collectionSlug !== identity.collection || own.contentId !== identity.id)) throw new Error("Invalid entry rule");
		const oldRule = legacy ? normalizeContentRestriction(legacy.value) : null;
		if (legacy && !oldRule) throw new Error("Invalid legacy rule");
		return { version, own, legacy, rules: [...(own ? [own] : []), ...(oldRule ? [oldRule] : []), ...rules.filter(r => "taxonomyName" in r)] };
	};
	let stored = await load();
	const editingBlocked = () => stored.legacy ? legacyMessage : delegated && stored.own &&
		(memberPolicies.includes(stored.own.policy) || (stored.own.requiredPlanSlugs?.length ?? 0) > 0 || (stored.own.productIds?.length ?? 0) > 0) ? delegatedMessage : null;
	const options = [
		{ value: "defaults", label: "Use defaults" },
		...(!delegated && !neverFree ? [{ value: "public", label: labels.public }] : []),
		...(settings.agents.mode === "paid" ? [{ value: "agents-pay", label: delegated ? "Paid machine-readable copy" : labels["agents-pay"] }] : []),
		...(!delegated && settings.humans.mode === "stripe" && settings.humans.plans.some(p => p.stripeProductId) && !neverFree ? [
			{ value: "members-only", label: labels["members-only"] },
			...(settings.agents.mode === "paid" ? [{ value: "members", label: labels.members }] : []),
		] : []),
	];
	const i = interaction(route);
	const submittedBlock = typeof route.input === "object" && route.input !== null && "block_id" in route.input ? str(route.input.block_id) : "";
	const freshId = () => `editor:policy/${encodeURIComponent(stored.version?.revision ?? "")}/${crypto.randomUUID()}`;
	let blockId = freshId();
	let toast: BlockResponse["toast"];
	let typed: Record<string, unknown> | undefined;
	if (i.type === "form_submit" && i.action === "editor:save") {
		const match = /^editor:policy\/([^/]*)\/[^/]+$/.exec(submittedBlock);
		const revision = match ? decodeURIComponent(match[1]) : undefined;
		const stale = () => {
			toast = { type: "error", message: "Access changed since this form loaded. Current stored values have been reloaded; review them and save again." };
		};
		const blocked = editingBlocked();
		if (blocked) toast = { type: "error", message: blocked };
		else if (revision === undefined) toast = { type: "error", message: "Reload this panel before saving." };
		else if (revision !== (stored.version?.revision ?? "")) stale();
		else {
			// Keep the mounted native form (and typed values) on validation/write failure.
			blockId = submittedBlock;
			typed = i.values;
			try {
				const preset = str(i.values.preset);
				if (!options.some(option => option.value === preset)) throw new ValidationError("Choose an available access preset. Provider settings may have changed.");
				for (const name of ["plans_members", "plans_members-only"]) {
					const value = i.values[name];
					if (value !== undefined && (!Array.isArray(value) || !value.every(v => typeof v === "string" && settings.humans.mode === "stripe" && !neverFree && settings.humans.plans.some(p => p.slug === v && p.stripeProductId)))) throw new ValidationError("Choose only currently supported membership plans.");
				}
				if (memberPolicies.includes(preset) && (!Array.isArray(i.values[`plans_${preset}`]) || !(i.values[`plans_${preset}`] as unknown[]).length)) throw new ValidationError("Choose at least one membership plan.");
				const agentPrice = paidPolicies.includes(preset) ? normalizeAgentPrice(priceFromInput(i.values[`price_${preset}`])) : null;
				if (paidPolicies.includes(preset) && !agentPrice) throw new ValidationError("Enter a positive price such as $0.05, with at most six decimals.");
				let applied: boolean;
				if (preset === "defaults") {
					// One authoritative key only. Never use the legacy multi-key DELETE handler.
					applied = revision ? (await ctx.storage.restrictions.compareAndDelete(key, revision)).applied : !(await ctx.storage.restrictions.getVersioned(key));
				} else {
					const record: ContentRestrictionRecord = {
						collectionSlug: identity.collection, contentId: identity.id, slug: entry.slug,
						title: typeof entry.data.title === "string" ? entry.data.title : null,
						policy: preset as AccessPolicy, agentPrice,
						requiredPlanSlugs: memberPolicies.includes(preset) ? [...new Set((i.values[`plans_${preset}`] ?? []) as string[])] : [],
						productIds: [], passEligible: false, source: "manual",
						createdAt: stored.own?.createdAt ?? nowIso(), updatedAt: nowIso(),
					};
					applied = (await ctx.storage.restrictions.compareAndSet(key, revision || null, record)).applied;
				}
				stored = await load();
				typed = undefined;
				blockId = freshId();
				if (!applied) stale();
				else toast = { type: "success", message: "Policy saved. Cache activation is pending verification." };
			} catch (error) {
				// Only our validation messages are safe to display; storage errors may contain secrets.
				const message = error instanceof ValidationError ? error.message : "Save could not be confirmed. Your values are retained; reload before retrying if the write may have completed.";
				toast = { type: "error", message };
			}
		}
	} else if (i.type !== "panel_load") return failure("This action is unavailable. Reload the editor and try again.");

	const { own, rules } = stored;
	const effective = resolveAccess({ policies: rules.map(r => r.policy), audience: "agent", agentsMode: settings.agents.mode, freeByDefault: settings.agents.freeByDefault && !neverFree });
	const machine = neverFree && effective.policy === "public" ? "Not offered (free reads disabled)"
		: effective.agent === "granted" ? "Free copy" : effective.agent === "payment-required" ? `Paid copy · ${highestAgentPrice(rules) ?? "price missing"} per read` : "Not offered";
	const blocks: Block[] = [
		{ type: "fields", fields: [
			{ label: "Website access", value: delegated ? "Controlled by Restrict With Stripe" : memberPolicies.includes(effective.policy) ? "Members only" : "Public" },
			{ label: "Configured machine-readable read", value: machine },
		] },
		context("Stored policy · cache activation unverified."),
	];
	const details: Block[] = [
		{ type: "fields", fields: [{ label: "Strongest entry/category policy", value: rules.length ? labels[effective.policy] : "Site defaults (no entry or taxonomy rule)" }] },
		context(`Public preview: excerpts ${settings.showExcerpts ? "enabled" : "disabled"}. The site controls which fields stay public; that field list is unverified here.`),
		context("Other restrictions, including translated entries, may block the configured read."),
	];
	for (const rule of rules.filter(r => "taxonomyName" in r)) {
		details.push(context(`Inherited from ${rule.taxonomyName}:${rule.termId}: ${labels[rule.policy]}. The strongest rule wins; an entry preset cannot weaken it.`));
	}
	if (delegated) blocks.push(context("Restrict With Stripe controls website access. Choose a paid copy or use inherited defaults here. A separate Not offered override is unavailable."));
	else if (neverFree) blocks.push(context("Restrict With Stripe is active. Review its rule in the Restrict panel; free machine-readable reads are disabled."));
	const blocked = editingBlocked();
	if (blocked) return { blocks: [...blocks, banner(blocked, "alert"), { type: "accordion", label: "Policy details", blocks: details }, { type: "actions", elements: [link("Advanced rules", "/rules")] }], ...(toast ? { toast } : {}) };
	const preset = typed ? str(typed.preset) : own?.policy ?? "defaults";
	const fields: FormField[] = [{ type: "radio", action_id: "preset", label: delegated ? "Machine-readable copy" : "Access", options, ...(options.some(o => o.value === preset) ? { initial_value: preset } : {}) }];
	for (const option of options) {
		if (paidPolicies.includes(option.value)) fields.push({ type: "text_input", action_id: `price_${option.value}`, label: "Price per read (USD)", placeholder: "$0.05", initial_value: typed ? str(typed[`price_${option.value}`]) : own?.agentPrice ?? "", condition: { field: "preset", eq: option.value } });
		if (memberPolicies.includes(option.value) && settings.humans.plans.length) fields.push({ type: "checkbox", action_id: `plans_${option.value}`, label: "Membership plans (choose at least one)", options: settings.humans.plans.filter(p => p.stripeProductId).map(p => ({ value: p.slug, label: p.name })), initial_value: (typed && Array.isArray(typed[`plans_${option.value}`]) ? (typed[`plans_${option.value}`] as unknown[]).filter((v): v is string => typeof v === "string") : own?.requiredPlanSlugs ?? []).filter(v => settings.humans.plans.some(p => p.slug === v && p.stripeProductId)), condition: { field: "preset", eq: option.value } });
	}
	blocks.push({ type: "form", block_id: blockId, fields, submit: { action_id: "editor:save", label: "Save access" } });
	if (own && !options.some(o => o.value === own.policy)) blocks.push(banner("The stored preset is unavailable with the current provider settings. It remains in force until you explicitly choose and save an available option.", "alert"));
	details.push(context(delegated ? "Use defaults removes only this entry’s paid-copy rule; inherited rules still apply." : "Use defaults inherits site/category rules. Public explicitly offers a free copy."));
	if (effective.policy === "agents-pay") blocks.push(banner(delegated ? "If the website page is public, its HTML can be read without buying this copy." : AGENTS_PAY_WARNING, "alert"));
	if (settings.humans.mode === "off" && memberPolicies.includes(effective.policy)) blocks.push(banner("Member access is off; the stored member restriction cannot be unlocked.", "alert"));
	details.push(context("Host payment setup is unverified here. Missing configuration keeps paid reads unavailable. See Settings."));
	blocks.push({ type: "accordion", label: "Policy details", blocks: details }, { type: "actions", elements: [link("Settings", "/settings"), link("Advanced rules", "/rules")] });
	return { blocks, ...(toast ? { toast } : {}) };
}
