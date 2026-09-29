// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PluginContext } from "emdash/plugin";
import type { RouteContext } from "../types.js";


import { getEntryRestrictions, highestAgentPrice, normalizeAgentPrice, normalizeContentRestriction, normalizeTaxonomyRestriction } from "../restrictions.js";
import { resolveAccess } from "../resolver.js";
import type { ReceiptRecord } from "../types.js";
import { isRecord, routeError } from "../utils.js";
import { loadSettings } from "./settings.js";

function readEntry(input: unknown): { collectionSlug: string; contentId: string; slug: string | null } {
	const body = isRecord(input) ? input : {};
	return {
		collectionSlug: typeof body.collection === "string" ? body.collection.trim() : "",
		contentId: typeof body.contentId === "string" ? body.contentId.trim() : "",
		slug: typeof body.slug === "string" ? body.slug : null,
	};
}

export async function entitlementHandler(routeCtx: RouteContext, ctx: PluginContext) {
	const entry = readEntry(routeCtx.input);
	if (!entry.collectionSlug || !entry.contentId) return routeError("BAD_REQUEST", "collection and contentId are required.");
	try {
		const [settings, rules] = await Promise.all([
			loadSettings(ctx),
			getEntryRestrictions(ctx, entry.collectionSlug, entry.contentId, entry.slug),
		]);
		const result = resolveAccess({
			policies: rules.map((rule) => rule.policy),
			audience: "agent",
			agentsMode: settings.agents.mode,
			freeByDefault: settings.agents.freeByDefault,
		});
		return { ...result, price: highestAgentPrice(rules) };
	} catch {
		return routeError("UNAVAILABLE", "Unable to resolve agent entitlement.");
	}
}

export async function offersHandler(routeCtx: RouteContext, ctx: PluginContext) {
	const input = isRecord(routeCtx.input) ? routeCtx.input : {};
	const requestedLimit = Number(input.limit ?? 50);
	const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : 50;
	const cursor = typeof input.cursor === "string" ? input.cursor : "";
	const taxonomyPage = cursor.startsWith("taxonomy:");
	const settings = await loadSettings(ctx);
	const items: Array<Record<string, string>> = [];
	if (!taxonomyPage) {
		const content = await ctx.storage.restrictions.query({ limit, ...(cursor.startsWith("content:") ? { cursor: cursor.slice(8) } : {}) });
		const listed = new Set<string>();
		for (const item of content.items as Array<{ data: unknown }>) {
			const rule = normalizeContentRestriction(item.data);
			if (!rule || !rule.agentPrice || !["agents-pay", "members"].includes(rule.policy) || !ctx.content) continue;
			try {
				const entry = await ctx.content.get(rule.collectionSlug, rule.contentId);
				if (!entry || entry.status !== "published" || !entry.slug || listed.has(`${rule.collectionSlug}:${entry.id}`)) continue;
				// List what the agent route will actually sell, at the price it will charge.
				const rules = await getEntryRestrictions(ctx, rule.collectionSlug, entry.id, entry.slug);
				const access = resolveAccess({ policies: rules.map(r => r.policy), audience: "agent", agentsMode: settings.agents.mode, freeByDefault: settings.agents.freeByDefault });
				const price = highestAgentPrice(rules);
				if (access.agent !== "payment-required" || !price) continue;
				listed.add(`${rule.collectionSlug}:${entry.id}`);
				items.push({
					type: "content", collection: rule.collectionSlug, slug: entry.slug,
					title: typeof entry.data.title === "string" ? entry.data.title : rule.title ?? "",
					price, policy: access.policy, network: settings.agents.network,
					url: `${settings.agentRoutePrefix}/${encodeURIComponent(rule.collectionSlug)}/${encodeURIComponent(entry.slug)}.md`,
				});
			} catch { /* Unavailable content is not a public offer. */ }
		}
		if (content.cursor) return { items, nextCursor: `content:${content.cursor}` };
		if (content.items.length >= limit) return { items, nextCursor: "taxonomy:" };
	}
	const taxonomy = await ctx.storage.taxonomy_restrictions.query({
		limit: limit - items.length || limit,
		...(taxonomyPage && cursor.slice(9) ? { cursor: cursor.slice(9) } : {})
	});
	for (const item of taxonomy.items as Array<{ data: unknown }>) {
		const rule = normalizeTaxonomyRestriction(item.data);
		if (rule?.agentPrice && ["agents-pay", "members"].includes(rule.policy)) {
			items.push({
				type: "taxonomy", taxonomy: rule.taxonomyName, termId: rule.termId,
				price: rule.agentPrice, policy: rule.policy, network: settings.agents.network
			});
		}
	}
	return { items, nextCursor: taxonomy.cursor ? `taxonomy:${taxonomy.cursor}` : null };
}

export async function receiptsHandler(routeCtx: RouteContext, ctx: PluginContext) {
	if (routeCtx.request.method !== "GET") return { ok: false, error: "Method not allowed." };
	const result = await ctx.storage.receipts.query({ limit: 200 });
	return { items: result.items.filter((item: { data: unknown }) => isRecord(item.data)) };
}

export async function unavailableAgentFeature(_routeCtx: RouteContext, _ctx: PluginContext) {
	return routeError("UNAVAILABLE", "This Paid Access feature is not available yet.");
}

export async function agentContextHandler(routeCtx: RouteContext, ctx: PluginContext) {
	const input = isRecord(routeCtx.input) ? routeCtx.input : {};
	if (typeof input.collection !== "string" || !input.collection.trim() || typeof input.contentId !== "string" || !input.contentId.trim() ||
		(input.slug != null && typeof input.slug !== "string")) return routeError("BAD_REQUEST", "collection and contentId are required; slug must be a string.");
	try {
		const [settings, rules] = await Promise.all([loadSettings(ctx), getEntryRestrictions(ctx, input.collection, input.contentId, input.slug as string | null | undefined)]);
		const canonicalUrl = await ctx.content?.getPublicUrl?.(input.collection, input.contentId).catch(() => null) ?? null;
		return { canonicalUrl, rules: rules.map(({ policy, agentPrice }) => ({ policy, agentPrice })), agents: settings.agents, price: highestAgentPrice(rules) };
	} catch {
		return routeError("UNAVAILABLE", "Unable to resolve agent context.");
	}
}

export async function recordReceiptHandler(routeCtx: RouteContext, ctx: PluginContext) {
	const value = routeCtx.input;
	if (!isRecord(value) || !["entryId", "collectionSlug", "slug", "payer", "amount", "network", "transaction", "createdAt"].every(
		(key) => typeof value[key] === "string" && value[key].length > 0 && value[key].length <= 2048,
	) || !["origin-x402", "gateway"].includes(String(value.rail)) ||
		!/^0x[0-9a-fA-F]{40}$/.test(String(value.payer)) || !/^0x[0-9a-fA-F]{64}$/.test(String(value.transaction)) ||
		!normalizeAgentPrice(value.amount) || !["eip155:84532", "eip155:8453"].includes(String(value.network)) ||
		!Number.isFinite(Date.parse(String(value.createdAt)))) return routeError("BAD_REQUEST", "Invalid receipt.");
	const { entryId, collectionSlug, slug, rail, payer, amount, network, transaction, createdAt } = value as unknown as ReceiptRecord;
	const receipt: ReceiptRecord = { entryId, collectionSlug, slug, rail, payer, amount, network, transaction, createdAt };
	const result = await ctx.storage.receipts.compareAndSet(`receipt:${transaction}`, null, receipt);
	return result.applied ? { ok: true } : { ok: true, duplicate: true };
}

export async function plansHandler(_routeCtx: RouteContext, ctx: PluginContext) {
	const settings = await loadSettings(ctx);
	return {
		plans: (await ctx.kv?.get("state:legacyPluginPresent") === true ? [] : settings.humans.plans).map(({ slug, name, description, monthlyLabel, yearlyLabel, trialLabel }) =>
			({ slug, name, description, monthlyLabel, yearlyLabel, trialLabel }))
	};
}
