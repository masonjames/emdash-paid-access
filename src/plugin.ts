// Copyright 2026 Stranger Studios.
// Modified by Mason James, 2026-09-23.
// SPDX-License-Identifier: GPL-2.0-or-later

import { PluginRouteError, definePlugin } from "emdash";

import { accessHandler } from "./handlers/access.js";
import { logoutHandler, sendLinkHandler, sessionHandler, verifyHandler } from "./handlers/auth.js";
import { checkoutCompleteHandler, checkoutHandler } from "./handlers/checkout.js";
import { portalHandler } from "./handlers/portal.js";
import { productsHandler } from "./handlers/products.js";
import { restrictionsHandler } from "./handlers/restrictions.js";
import { loadSettings, settingsHandler } from "./handlers/settings.js";

type Handler = (ctx: any) => Promise<unknown>;

function unavailable(): never {
	throw PluginRouteError.notFound("Paid Access module is disabled.");
}

function humansStripeOnly(handler: Handler): Handler {
	return async (ctx) => (await loadSettings(ctx)).humans.mode === "stripe" ? handler(ctx) : unavailable();
}

function anyModule(handler: Handler): Handler {
	return async (ctx) => {
		const settings = await loadSettings(ctx);
		return settings.agents.mode !== "off" || settings.humans.mode !== "off" ? handler(ctx) : unavailable();
	};
}

export function createPlugin(_options: Record<string, unknown> = {}) {
	return definePlugin({
		id: "paid-access",
		version: "0.1.0",
		capabilities: ["network:request", "email:send", "content:read"],
		allowedHosts: ["api.stripe.com", "x402.org", "api.cloudflare.com"],
		storage: {
			restrictions: { indexes: ["contentId", "collectionSlug", "slug"] },
			taxonomyRestrictions: { indexes: ["taxonomyName", "termId"] },
			customers: { indexes: ["email"] },
			authTokens: { indexes: ["email", "expiresAt"] },
			sessions: { indexes: ["email", "expiresAt"] },
		},
		routes: {
			checkout: { public: true, handler: humansStripeOnly(checkoutHandler) },
			"checkout/complete": { public: true, handler: humansStripeOnly(checkoutCompleteHandler) },
			portal: { public: true, handler: humansStripeOnly(portalHandler) },
			access: { public: true, handler: accessHandler },
			"admin/products": { handler: humansStripeOnly(productsHandler) },
			"admin/restrictions": { handler: anyModule(restrictionsHandler) },
			"admin/settings": { handler: settingsHandler },
			"auth/send-link": { public: true, handler: humansStripeOnly(sendLinkHandler) },
			"auth/verify": { public: true, handler: humansStripeOnly(verifyHandler) },
			"auth/session": { public: true, handler: humansStripeOnly(sessionHandler) },
			"auth/logout": { public: true, handler: humansStripeOnly(logoutHandler) },
		},
		admin: {
			entry: "emdash-paid-access/admin",
			pages: [
				{ path: "/settings", label: "Paid Access Settings" },
				{ path: "/rules", label: "Paid Access Rules" },
			],
			widgets: [{ id: "overview", title: "Paid Access" }],
		},
	});
}
