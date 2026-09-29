// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { Block, BlockResponse } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash/plugin";
import { restrictionsHandler } from "../handlers/restrictions.js";
import { loadSettings } from "../handlers/settings.js";
import { getEntryRestrictions, normalizeContentRestriction } from "../restrictions.js";
import type { RouteContext } from "../types.js";
import { AdminInputError, banner, confirmButton, context, failure, form, interaction, request, resultToast, ruleFields, ruleHelp, ruleInput, summary } from "./shared.js";

export async function editorPanel(route: RouteContext, ctx: PluginContext): Promise<BlockResponse> {
	const identity = route.ui?.entry;
	if (!identity || !ctx.content) return failure("Save this post first, then reopen Paid access.");
	const entry = await ctx.content.get(identity.collection, identity.id);
	if (!entry) return failure("This post couldn't be found. Reload the editor and try again.");
	const i = interaction(route);
	let toast: BlockResponse["toast"];
	if (i.type === "form_submit" && i.action === "editor:save") {
		try {
			const result = await restrictionsHandler(request(route, { ...ruleInput(i.values), collectionSlug: identity.collection, contentId: identity.id, slug: entry.slug, title: typeof entry.data.title === "string" ? entry.data.title : null }), ctx);
			toast = resultToast(result, "Saved. Readers see the change on their next visit.");
		} catch (error) {
			toast = { type: "error", message: error instanceof AdminInputError ? error.message : "Couldn't save. Check the fields and try again." };
		}
	} else if (i.type === "block_action" && i.action === "editor:remove") {
		toast = resultToast(await restrictionsHandler(request(route, { collectionSlug: identity.collection, contentId: identity.id, slug: entry.slug }, "DELETE"), ctx), "Rule removed.");
	} else if (i.type !== "panel_load") return failure("This action is unavailable. Reload the editor and try again.");
	const s = await loadSettings(ctx);
	const rules = await getEntryRestrictions(ctx, identity.collection, identity.id, entry.slug);
	const direct = rules.find(r => "contentId" in r && r.contentId === identity.id) ?? rules.find(r => "contentId" in r);
	const inherited = rules.filter(r => "taxonomyName" in r);
	const status = summary(direct ?? { policy: "public" });
	const blocks: Block[] = [{ type: "fields", fields: [{ label: "People", value: status.people }, { label: "AI agents", value: s.agents.mode === "off" ? "Off" : status.agents }] }];
	if (inherited.length) {
		const [terms, taxonomies] = await Promise.all([ctx.taxonomies!.getEntryTerms(identity.collection, identity.id), ctx.taxonomies!.getAll()]);
		for (const r of inherited) {
			const term = terms.find(t => t.taxonomy === r.taxonomyName && t.id === r.termId);
			const taxonomy = taxonomies.find(t => t.name === r.taxonomyName);
			const label = summary(r);
			blocks.push(context(`Also covered by ${taxonomy?.labelSingular || r.taxonomyName}: ${term?.label || r.termId} → People: ${label.people} · AI agents: ${label.agents}`));
		}
	}
	const legacy = entry.slug && entry.slug !== identity.id ? normalizeContentRestriction(await ctx.storage.restrictions.get(`${identity.collection}:${entry.slug}`)) : null;
	if (legacy) blocks.push(banner("An older Paid Access rule also covers this post. Remove the rule here to clear both saved versions before choosing new access.", "alert"));
	if (await ctx.kv.get("state:legacyPluginPresent") === true) blocks.push(context("Restrict With Stripe may also restrict this post. Review its rule in the Restrict panel; this panel cannot read that plugin’s rules."));
	blocks.push(form("editor:save", "Save", ruleFields(s, direct)), ...ruleHelp(s, rules.some(r => r.policy === "agents-pay") ? "agents-pay" : direct?.policy));
	if (s.agents.mode === "off") blocks.push(banner("AI agent sales are off for this site. Turn them on in Paid Access → Settings."));
	if (s.humans.mode === "off" && rules.some(r => r.policy === "members" || r.policy === "members-only")) blocks.push(banner("Member access is off, so people can't unlock this post. Turn on Members in Paid Access → Settings.", "alert"));
	if (entry.status === "published" && entry.slug && s.agents.mode === "paid" && rules.some(r => r.policy === "agents-pay" || r.policy === "members") && !rules.some(r => r.policy === "members-only")) blocks.push(context(`Agents can buy it at ${s.agentRoutePrefix}/${encodeURIComponent(identity.collection)}/${encodeURIComponent(entry.slug)}.md`));
	if (direct) blocks.push({ type: "actions", elements: [confirmButton("editor:remove", "Remove rule", "Remove this rule?", "The post becomes free for everyone.")] });
	return { blocks, ...(toast ? { toast } : {}) };
}
