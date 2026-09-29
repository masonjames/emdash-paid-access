// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { PluginRouteError } from "emdash";

import { getEntryRestrictions, highestAgentPrice, normalizeContentRestriction, normalizeTaxonomyRestriction } from "../restrictions.js";
import { resolveAccess } from "../resolver.js";
import type { AccessPolicy } from "../types.js";
import { isRecord } from "../utils.js";
import { loadSettings } from "./settings.js";

function readEntry(url: URL): { collectionSlug: string; contentId: string; slug: string | null } {
	return {
		collectionSlug: (url.searchParams.get("collection") || "").trim(),
		contentId: (url.searchParams.get("contentId") || "").trim(),
		slug: url.searchParams.get("slug"),
	};
}

export async function entitlementHandler(ctx: any) {
	const entry = readEntry(new URL(ctx.request.url));
	if (!entry.collectionSlug || !entry.contentId) throw PluginRouteError.badRequest("collection and contentId are required.");
	try {
		const [settings, rules] = await Promise.all([
			loadSettings(ctx),
			getEntryRestrictions(ctx, entry.collectionSlug, entry.contentId, entry.slug),
		]);
		const result = resolveAccess({
			policies: rules.map((rule) => rule.policy),
			audience: "agent",
			agentsMode: settings.agents.mode,
		});
		return { ...result, price: highestAgentPrice(rules) };
	} catch {
		throw new PluginRouteError("SERVICE_UNAVAILABLE", "Unable to resolve agent entitlement.", 503);
	}
}

export async function offersHandler(ctx: any) {
	const url = new URL(ctx.request.url);
	const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
	const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : 50;
	const cursor = url.searchParams.get("cursor") ?? "";
	const taxonomyPage = cursor.startsWith("taxonomy:");
	const settings = await loadSettings(ctx);
	const items: Array<Record<string, string>> = [];
	if (!taxonomyPage) {
		const content = await ctx.storage.restrictions.query({ limit, ...(cursor.startsWith("content:") ? { cursor: cursor.slice(8) } : {}) });
		for (const item of content.items as Array<{ data: unknown }>) {
			const rule = normalizeContentRestriction(item.data);
			if (!rule || !rule.agentPrice || !["agents-pay", "members"].includes(rule.policy) || !ctx.content) continue;
			try {
				const entry = await ctx.content.get(rule.collectionSlug, rule.contentId);
				if (!entry || entry.status !== "published" || !entry.slug) continue;
				items.push({ type: "content", collection: rule.collectionSlug, slug: entry.slug,
					title: typeof entry.data.title === "string" ? entry.data.title : rule.title ?? "",
					price: rule.agentPrice, policy: rule.policy, network: settings.agents.network });
			} catch { /* Unavailable content is not a public offer. */ }
		}
		if (content.nextCursor) return { items, nextCursor: `content:${content.nextCursor}` };
		if (content.items.length >= limit) return { items, nextCursor: "taxonomy:" };
	}
	const taxonomy = await ctx.storage.taxonomyRestrictions.query({ limit: limit - items.length || limit,
		...(taxonomyPage && cursor.slice(9) ? { cursor: cursor.slice(9) } : {}) });
	for (const item of taxonomy.items as Array<{ data: unknown }>) {
		const rule = normalizeTaxonomyRestriction(item.data);
		if (rule?.agentPrice && ["agents-pay", "members"].includes(rule.policy)) {
			items.push({ type: "taxonomy", taxonomy: rule.taxonomyName, termId: rule.termId,
				price: rule.agentPrice, policy: rule.policy, network: settings.agents.network });
		}
	}
	return { items, nextCursor: taxonomy.nextCursor ? `taxonomy:${taxonomy.nextCursor}` : null };
}

export async function receiptsHandler(ctx: any) {
	if (ctx.request.method !== "GET") return { ok: false, error: "Method not allowed." };
	const result = await ctx.storage.receipts.query({ limit: 200 });
	return { items: result.items.filter((item: { data: unknown }) => isRecord(item.data)) };
}

export async function unavailableAgentFeature(): Promise<never> {
	throw PluginRouteError.notFound("This Paid Access feature is not available yet.");
}
