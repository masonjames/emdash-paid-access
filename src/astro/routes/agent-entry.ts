// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { APIRoute } from "astro";
import { getEmDashEntry } from "emdash";
import type { PortableTextBlock } from "emdash/client";
import options from "virtual:paid-access/config";
import { serveAgentEntry } from "../../agent.js";
import type { AgentSettings, ContentRestrictionRecord } from "../../types.js";
import { callPlugin } from "../runtime.js";

export const prerender = false;
const empty = (status: number) => new Response(null, { status, headers: { "Cache-Control": "private, no-store" } });
export const GET: APIRoute = async ({ params, locals, request }) => {
	if (!params.collection || !options.collections.includes(params.collection) || !params.slug) return empty(404);
	try {
		const { entry, isPreview } = await getEmDashEntry<string, { id?: string; status?: string; title?: string; content?: PortableTextBlock[] }>(params.collection, params.slug);
		// getEmDashEntry can serve preview drafts; agent endpoints must never do so.
		if (!entry || isPreview || entry.data.status !== "published") return empty(404);
		const id = entry.data.id ?? entry.id;
		const result = await callPlugin<{ rules: ContentRestrictionRecord[]; agents: AgentSettings; canonicalUrl: string | null }>(locals, "agent/context", { collection: params.collection, contentId: id, slug: params.slug }, request);
		if (!result.ok) return empty(503);
		const canonical = new URL(request.url); canonical.pathname = canonical.pathname.replace(/\.md$/, ""); canonical.search = "";
		return await serveAgentEntry({ request,
			entry: { id, collectionSlug: params.collection, slug: params.slug, title: entry.data.title ?? "", content: entry.data.content ?? [], canonicalUrl: result.data.canonicalUrl ?? canonical.href },
			rules: result.data.rules, settings: result.data.agents, enforcer: locals.x402,
			receipts: { async put(_id, receipt) { const stored = await callPlugin(locals, "receipts/record", receipt, request); if (!stored.ok) throw new Error(`Receipt storage failed: ${stored.code}`); } },
			log: console,
		});
	} catch { return empty(503); }
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
