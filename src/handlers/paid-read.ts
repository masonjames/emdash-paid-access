// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later
import { pluginResponse } from "emdash/plugin";
import type { PluginContext } from "emdash/plugin";
import type { PortableTextBlock } from "emdash/client";
import { renderAgentMarkdown } from "../agent.js";
import { CONTENT_SIGNAL } from "../resolver.js";
import type { RouteContext } from "../types.js";
import { isRecord } from "../utils.js";
import { agentContextHandler, recordReceiptHandler } from "./agents.js";
import { resolveAccess } from "../resolver.js";

export async function paidReadQuote(route: RouteContext, ctx: PluginContext) {
	const input = isRecord(route.input) ? route.input : {};
	if (typeof input.collection !== "string" || typeof input.contentId !== "string") throw new Error("Entry identity required");
	const entry = await ctx.content?.get(input.collection, input.contentId);
	if (!entry || entry.status !== "published") return { status: 404 as const };
	const result = await agentContextHandler({ ...route, input: { ...input, slug: entry.slug, readerProtection: true } }, ctx);
	if (!("rules" in result) || !result.agents || result.agents.rail !== "origin-x402") throw new Error("Agent policy unavailable");
	const access = resolveAccess({ policies: result.rules.map(rule => rule.policy), audience: "agent", agentsMode: result.agents.mode, freeByDefault: result.agents.freeByDefault });
	if (access.agent !== "granted" && access.agent !== "payment-required") return { status: access.agent === "subscriber-only" ? 403 as const : 404 as const };
	const price = access.agent === "granted" ? null : result.price;
	if (access.agent === "payment-required" && !price) throw new Error("Entry has no price");
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ rules: result.rules, agents: result.agents })));
	const policy = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
	return { price, resource: `${input.collection}:${entry.id}`, policy, description: "Article Markdown" };
}

export async function paidReadHandler(route: RouteContext, ctx: PluginContext) {
	if (!route.payment || !["verified", "free"].includes(route.payment.state)) throw new Error("Host payment context required");
	const current = await paidReadQuote(route, ctx);
	if ("status" in current) return pluginResponse({ status: current.status });
	if (JSON.stringify(current) !== JSON.stringify(route.payment.quote)) throw new Error("Policy changed");
	const input = route.input as { collection: string; contentId: string };
	const entry = await ctx.content!.get(input.collection, input.contentId);
	if (!entry || entry.status !== "published") throw new Error("Entry unavailable");
	const fallback = new URL(route.request.url); fallback.search = ""; fallback.pathname = fallback.pathname.replace(/\.md$/, "");
	const canonicalUrl = await ctx.content?.getPublicUrl?.(input.collection, input.contentId) ?? fallback.href;
	const body = renderAgentMarkdown({ id: entry.id, collectionSlug: input.collection, slug: entry.slug ?? input.contentId, title: typeof entry.data.title === "string" ? entry.data.title : "", canonicalUrl, content: (entry.data.content ?? []) as PortableTextBlock[] }, current.price ?? "$0");
	return pluginResponse({ body: { kind: "text", value: body }, headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Signal": CONTENT_SIGNAL } });
}

export async function paidReadReceipt(route: RouteContext, ctx: PluginContext) {
	const payment = route.payment;
	if (payment?.state !== "confirmed" || !payment.transaction) throw new Error("Confirmed host receipt required");
	const input = route.input as { collection: string; contentId: string };
	const entry = await ctx.content?.get(input.collection, input.contentId);
	const result = await recordReceiptHandler({ ...route, input: { entryId: input.contentId, collectionSlug: input.collection, slug: entry?.slug ?? input.contentId, payer: payment.payer, amount: payment.quote.price, network: payment.network, transaction: payment.transaction, createdAt: new Date().toISOString(), rail: "origin-x402" } }, ctx);
	if (!("ok" in result) || result.ok !== true) throw new Error("Plugin receipt storage failed");
	return result;
}
