// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type {} from "emdash/plugin-payments";
import { defineMiddleware } from "astro:middleware";
import options from "virtual:paid-access/config";
import { createPaidAccess } from "./runtime.js";

export const onRequest = defineMiddleware(async (context, next) => {
	context.locals.paidAccess = createPaidAccess(context.locals, context.request, context.cookies.get("phb_session")?.value ?? null, options);
	if (options.hostPayments && context.locals.pluginPaymentAdapter) {
		try {
			// Both the native alias and generic HTTP route need the same coexistence
			// check before any free quote can bypass the human reader provider.
			await context.locals.paidAccess.detectLegacy();
			context.locals.pluginPayments = { ...context.locals.pluginPayments, "paid-access/agent/read": { adapter: context.locals.pluginPaymentAdapter, provider: "paid-access", collections: options.collections } };
		} catch {
			// No registration means unavailable paid reads; public pages can still run.
			if (context.locals.pluginPayments) delete context.locals.pluginPayments["paid-access/agent/read"];
		}
	}
	const response = await next();
	// Child components cannot reliably set the page response headers during
	// streaming. Protect HTML at the response boundary, before any body is sent.
	if (response.headers.get("Content-Type")?.toLowerCase().includes("text/html")) {
		response.headers.set("Cache-Control", "private, no-store");
	}
	// Astro's route cache ignores Cache-Control, so a no-store response (HTML,
	// paid agent Markdown, account redirects) must opt out explicitly. Do it
	// after next(), because a later page or route hint clears set(false). A
	// disabled cache warns on any set(), so leave it alone.
	if (context.cache?.enabled && response.headers.get("Cache-Control")?.toLowerCase().includes("no-store")) context.cache.set(false);
	return response;
});
