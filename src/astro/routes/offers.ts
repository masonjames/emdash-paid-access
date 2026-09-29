// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { APIRoute } from "astro";
import { callPublicPlugin } from "../runtime.js";
export const prerender = false;
export const GET: APIRoute = async ({ locals, url, request }) => {
	const result = await callPublicPlugin(locals, "offers", { limit: url.searchParams.get("limit"), cursor: url.searchParams.get("cursor") }, "paid-access", request);
	if (!result.ok) return new Response(null, { status: result.code === "MODULE_DISABLED" ? 404 : 503, headers: { "Cache-Control": "private, no-store" } });
	return Response.json(result.data, { headers: { "Cache-Control": "public, max-age=300" } });
};
