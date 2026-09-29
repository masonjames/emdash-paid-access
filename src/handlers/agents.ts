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
	const [content, taxonomy] = await Promise.all([
		ctx.storage.restrictions.query({ limit: 200 }),
		ctx.storage.taxonomyRestrictions.query({ limit: 200 }),
	]);
	const items = [
		...content.items.map((item: { id: string; data: unknown }) => ({ id: item.id, type: "content", data: normalizeContentRestriction(item.data) })),
		...taxonomy.items.map((item: { id: string; data: unknown }) => ({ id: item.id, type: "taxonomy", data: normalizeTaxonomyRestriction(item.data) })),
	].filter((item) => item.data && ["agents-pay", "members"].includes(item.data.policy) && item.data.agentPrice);
	return { items };
}

export async function receiptsHandler(ctx: any) {
	if (ctx.request.method !== "GET") return { ok: false, error: "Method not allowed." };
	const result = await ctx.storage.receipts.query({ limit: 200 });
	return { items: result.items.filter((item: { data: unknown }) => isRecord(item.data)) };
}

export async function unavailableAgentFeature(): Promise<never> {
	throw PluginRouteError.notFound("This Paid Access feature is not available yet.");
}
