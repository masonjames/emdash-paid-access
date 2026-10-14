// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { APIRoute } from "astro";
import { getCollectionInfo, getEmDashEntry } from "emdash";
import type { PortableTextBlock } from "emdash/client";
import options from "virtual:paid-access/config";
import { serveAgentEntry } from "../../agent.js";
import type { AgentSettings, ContentRestrictionRecord } from "../../types.js";
import { callPlugin } from "../runtime.js";

export const prerender = false;
// The post's public URL from its collection's pattern, when that only needs the slug.
async function collectionUrl(collection: string, slug: string, site: URL | undefined): Promise<string | null> {
	const pattern = (await getCollectionInfo(collection).catch(() => null))?.urlPattern;
	if (!pattern || !site) return null;
	const path = pattern.replace("{slug}", encodeURIComponent(slug));
	return /[{}]/.test(path) ? null : new URL(path, site).href;
}
const empty = (status: number) => new Response(null, { status, headers: { "Cache-Control": "private, no-store" } });
export const GET: APIRoute = async ({ params, locals, request, site }) => {
	if (!params.collection || !options.collections.includes(params.collection) || !params.slug) return empty(404);
	try {
		if (options.hostPayments) {
			const metadata = await (locals.paidAccess?.trustedPolicyMetadata ?? (<T>(run: () => T) => run()))(() => getEmDashEntry(params.collection!, params.slug!));
			if (!metadata.entry || metadata.isPreview || metadata.entry.data.status !== "published" || !locals.emdash) return empty(404);
			if (!locals.emdash.handlePublicPaidPluginRoute) return empty(503);
			const url = new URL(request.url);
			url.searchParams.set("collection", params.collection);
			url.searchParams.set("contentId", String(metadata.entry.data.id ?? metadata.entry.id));
			return locals.emdash.handlePublicPaidPluginRoute("paid-access", "agent/read", new Request(url, { method: request.method, headers: request.headers }), locals.pluginPayments?.["paid-access/agent/read"]);
		}
		const { entry, isPreview } = await (locals.paidAccess?.trustedContent ?? (<T>(run: () => T) => run()))(() => getEmDashEntry<string, { id?: string; status?: string; title?: string; content?: PortableTextBlock[] }>(params.collection!, params.slug!));
		// getEmDashEntry can serve preview drafts; agent endpoints must never do so.
		if (!entry || isPreview || entry.data.status !== "published") return empty(404);
		const id = entry.data.id ?? entry.id;
		// The core must know whether Restrict With Stripe is active before it may serve anything free.
		await locals.paidAccess.detectLegacy();
		const result = await (locals.paidAccess?.trustedContent ?? (<T>(run: () => T) => run()))(() => callPlugin<{ rules: ContentRestrictionRecord[]; agents: AgentSettings; canonicalUrl: string | null }>(locals, "agent/context", { collection: params.collection, contentId: id, slug: params.slug, ...(options.readerProtection ? { readerProtection: true } : {}) }, request));
		if (!result.ok) {
			console.error(`[paid-access] agent/context failed: ${result.code}`);
			return empty(503);
		}
		const fallback = new URL(request.url); fallback.pathname = fallback.pathname.replace(/\.md$/, ""); fallback.search = "";
		// The collection's pattern carries the site's own URL shape (such as a trailing slash).
		const canonicalUrl = await collectionUrl(params.collection, params.slug, site) ?? result.data.canonicalUrl ?? fallback.href;
		return await serveAgentEntry({ request,
			entry: { id, collectionSlug: params.collection, slug: params.slug, title: entry.data.title ?? "", content: entry.data.content ?? [], canonicalUrl },
			rules: result.data.rules, settings: result.data.agents, enforcer: locals.x402, facilitatorUrl: options.facilitatorUrl,
			receipts: { async put(_id, receipt) { const stored = await callPlugin(locals, "receipts/record", receipt, request); if (!stored.ok) throw new Error(`Receipt storage failed: ${stored.code}`); } },
			log: console, offersUrl: new URL(`${options.agentRoutePrefix}/offers.json`, site ?? request.url).href,
		});
	} catch (error) {
		console.error("[paid-access] agent route failed", error);
		return empty(503);
	}
};
// HEAD never settles a payment: strip x402 payment headers so a signed HEAD
// can't be charged for a response that carries no body.
export const HEAD: APIRoute = async context => {
	const headers = new Headers(context.request.headers);
	headers.delete("payment-signature");
	headers.delete("x-payment");
	const request = new Request(context.request.url, { method: "GET", headers });
	const response = await GET({ ...context, request });
	return new Response(null, { status: response.status, headers: response.headers });
};
