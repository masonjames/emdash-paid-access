// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { APIRoute } from "astro";
import { callPublicPlugin } from "../runtime.js";
type Offers = { items: Array<Record<string, string>>; nextCursor: string | null };
export const prerender = false;
export const GET: APIRoute = async ({ locals, url, request }) => {
	const result = await callPublicPlugin<Offers>(locals, "offers", { limit: url.searchParams.get("limit"), cursor: url.searchParams.get("cursor") }, "paid-access", request);
	if (!result.ok) return new Response(null, { status: result.code === "MODULE_DISABLED" ? 404 : 503, headers: { "Cache-Control": "private, no-store" } });
	// Absolute links, so an agent can buy straight from the list.
	for (const item of result.data.items ?? []) if (item.url) item.url = new URL(item.url, url).href;
	return Response.json(result.data, { headers: { "Cache-Control": "public, max-age=300" } });
};
