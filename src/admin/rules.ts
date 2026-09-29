// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { Block, BlockResponse, TableBlock } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash/plugin";
import { loadSettings } from "../handlers/settings.js";
import { restrictionsHandler } from "../handlers/restrictions.js";
import { normalizeContentRestriction, normalizeTaxonomyRestriction } from "../restrictions.js";
import type { RouteContext } from "../types.js";
import { isRecord } from "../utils.js";
import { AGENTS_PAY_WARNING, AdminInputError, allRows, banner, confirmButton, context, form, interaction, loadMore, request, resultToast, ruleFields, ruleHelp, ruleInput, str, summary } from "./shared.js";

export async function rulesPage(ctx: PluginContext, cursor?: string, taxonomy?: string, extra: Block[] = [], taxonomyCursor?: string): Promise<BlockResponse> {
	const s = await loadSettings(ctx);
	const all = (await allRows(ctx.storage.restrictions)).flatMap(row => { const r = normalizeContentRestriction(row.data); return r ? [r] : []; });
	const content = await ctx.storage.restrictions.query({ limit: 25, ...(cursor ? { cursor } : {}) });
	const taxRules = await ctx.storage.taxonomy_restrictions.query({ limit: 25, ...(taxonomyCursor ? { cursor: taxonomyCursor } : {}) });
	const taxonomies = await ctx.taxonomies!.getAll();
	const selected = taxonomies.find(t => t.name === taxonomy);
	const terms = selected ? await ctx.taxonomies!.getTerms(selected.name) : [];
	const termLabels = new Map<string, string>();
	for (const row of taxRules.items) {
		const r = normalizeTaxonomyRestriction(row.data);
		if (r && !termLabels.has(r.taxonomyName)) {
			for (const term of await ctx.taxonomies!.getTerms(r.taxonomyName)) termLabels.set(`${r.taxonomyName}:${term.id}`, term.label);
			termLabels.set(r.taxonomyName, "loaded");
		}
	}
	const columns: TableBlock["columns"] = [{ key: "post", label: "Post", format: "element" }, { key: "people", label: "People" }, { key: "agents", label: "AI agents" }, { key: "plans", label: "Plans" }, { key: "updated", label: "Updated", format: "relative_time" }, { key: "actions", label: "Actions", format: "element" }];
	const plans = (slugs: string[] = []) => slugs.map(slug => s.humans.plans.find(p => p.slug === slug)?.name ?? `Removed plan (${slug})`).join(", ");
	return { blocks: [
		{ type: "header", text: "Rules" }, context("Rules decide who pays for what. Set most rules from the Paid access panel beside each post; use this page to review them and to cover a whole category or tag."),
		{ type: "stats", items: [{ label: "Posts with rules", value: all.length }, { label: "Sold to AI agents", value: all.filter(r => r.policy === "agents-pay" || r.policy === "members").length }, { label: "Members only", value: all.filter(r => r.policy === "members" || r.policy === "members-only").length }] },
		...extra,
		...((all.some(r => r.policy === "agents-pay") || taxRules.items.some(row => normalizeTaxonomyRestriction(row.data)?.policy === "agents-pay")) && !extra.some(b => b.type === "banner" && b.description === AGENTS_PAY_WARNING) ? [banner(AGENTS_PAY_WARNING, "alert")] : []),
		...(!all.length && !taxRules.items.length ? [{ type: "empty" as const, title: "No rules yet", description: "Open any post and use the Paid access panel to choose who pays." }] : []),
		{ type: "header", text: "Posts" },
		{ type: "table", block_id: "rules:posts", page_action_id: "rules:more", columns, rows: content.items.flatMap(row => {
			const r = normalizeContentRestriction(row.data); if (!r) return [];
			return [{ post: { type: "link", label: [r.title || r.contentId, r.slug].filter(Boolean).join(" · "), target: { kind: "content", collection: r.collectionSlug, id: r.contentId } }, ...summary(r), plans: plans(r.requiredPlanSlugs), updated: r.updatedAt, actions: { type: "menu", action_id: "rules:confirm-remove", label: "Actions", items: [{ label: "Remove rule", value: JSON.stringify({ collectionSlug: r.collectionSlug, contentId: r.contentId, slug: r.slug }) }] } }];
		}) }, ...loadMore("rules:more", content.cursor),
		{ type: "header", text: "Categories and tags" },
		{ type: "table", block_id: "rules:taxonomy", page_action_id: "rules:taxonomy:more", columns: columns.map(c => c.key === "post" ? { key: "post", label: "Term", format: "text" } : c), rows: taxRules.items.flatMap(row => {
			const r = normalizeTaxonomyRestriction(row.data); if (!r) return [];
			return [{ post: `${taxonomies.find(t => t.name === r.taxonomyName)?.labelSingular || r.taxonomyName}: ${termLabels.get(`${r.taxonomyName}:${r.termId}`) || r.termId}`, ...summary(r), plans: plans(r.requiredPlanSlugs), updated: r.updatedAt, actions: { type: "menu", action_id: "rules:confirm-remove", label: "Actions", items: [{ label: "Remove rule", value: JSON.stringify({ type: "taxonomy", taxonomyName: r.taxonomyName, termId: r.termId }) }] } }];
		}) }, ...loadMore("rules:taxonomy:more", taxRules.cursor),
		{ type: "header", text: "Add a rule for a category or tag" },
		...(taxonomies.length ? [form("rules:taxonomy:choose", "Choose taxonomy", [{ type: "radio", action_id: "taxonomy", label: "Taxonomy", options: taxonomies.map(t => ({ value: t.name, label: t.label })), ...(selected ? { initial_value: selected.name } : {}) }])] : [context("Add a category or tag taxonomy to your site, then return here to make a rule.")]),
		...(selected && terms.length ? [context(`Choose a term in ${selected.label}.`), form(`rules:taxonomy:save:${selected.name}`, "Save rule", [{ type: "combobox", action_id: "term", label: "Term", options: terms.map(t => ({ value: t.id, label: t.label })) }, ...ruleFields(s)]), ...ruleHelp(s)] : selected ? [context(`Add a term under ${selected.label}, then choose this taxonomy again.`)] : []),
	] };
}
export async function rulesInteraction(route: RouteContext, ctx: PluginContext): Promise<BlockResponse> {
	const i = interaction(route);
	if (i.type === "block_action" && i.action === "rules:more") return rulesPage(ctx, str(i.value));
	if (i.type === "block_action" && i.action === "rules:taxonomy:more") return rulesPage(ctx, undefined, undefined, [], str(i.value));
	if (i.type === "form_submit" && i.action === "rules:taxonomy:choose") return rulesPage(ctx, undefined, str(i.values.taxonomy));
	if (i.type === "block_action" && i.action === "rules:confirm-remove") return rulesPage(ctx, undefined, undefined, [{ type: "actions", elements: [confirmButton("rules:remove", "Remove", "Remove this rule?", "Other rules, and other plugins, still apply.", i.value)] }]);
	let result: unknown;
	let taxonomy: string | undefined;
	let extra: Block[] = [];
	try {
		if (i.type === "block_action" && i.action === "rules:remove") {
			const input: unknown = JSON.parse(str(i.value));
			if (!isRecord(input)) throw new AdminInputError("Choose a rule from the table and try Remove again.");
			result = await restrictionsHandler(request(route, input, "DELETE"), ctx);
		} else if (i.type === "form_submit" && i.action.startsWith("rules:taxonomy:save:")) {
			taxonomy = i.action.slice("rules:taxonomy:save:".length);
			const terms = await ctx.taxonomies!.getTerms(taxonomy);
			if (!terms.some(t => t.id === i.values.term)) throw new AdminInputError("Choose a term in this taxonomy, then save again.");
			const settings = await loadSettings(ctx);
			const input = ruleInput(i.values, settings.humans.mode === "delegate");
			result = await restrictionsHandler(request(route, { ...input, type: "taxonomy", taxonomyName: taxonomy, termId: i.values.term }), ctx);
			extra = ruleHelp(settings, input.policy).filter(b => b.type === "banner");
		} else throw new AdminInputError("This action is unavailable. Reload Rules and try again.");
	} catch (error) {
		result = { ok: false, error: error instanceof AdminInputError ? error.message : "Choose a rule from the table and try again." };
	}
	return { ...(await rulesPage(ctx, undefined, taxonomy, extra)), toast: resultToast(result, i.action === "rules:remove" ? "Rule removed." : "Rule saved.") };
}
