// Copyright 2026 Stranger Studios.
// Modified by Mason James, 2026-09-23.
// SPDX-License-Identifier: GPL-2.0-or-later

import { adminHandler, editorHandler, coexistenceReport } from "./admin/index.js";

import type { SandboxedPlugin } from "emdash/plugin";
import type { PageMetadataContribution } from "emdash";

import { accessHandler } from "./handlers/access.js";
import { agentContextHandler, entitlementHandler, offersHandler, plansHandler, receiptsHandler, recordReceiptHandler, unavailableAgentFeature } from "./handlers/agents.js";
import { logoutHandler, sendLinkHandler, sessionHandler, verifyHandler } from "./handlers/auth.js";
import { checkoutCompleteHandler, checkoutHandler } from "./handlers/checkout.js";
import { portalHandler } from "./handlers/portal.js";
import { productsHandler } from "./handlers/products.js";
import { restrictionsHandler } from "./handlers/restrictions.js";
import { loadSettings, settingsHandler } from "./handlers/settings.js";
import { getEntryRestrictions } from "./restrictions.js";
import type { RouteHandler } from "./types.js";
import { routeError } from "./utils.js";

function humansStripeOnly(handler: RouteHandler): RouteHandler {
	return async (routeCtx, ctx) => (await loadSettings(ctx)).humans.mode === "stripe"
		? handler(routeCtx, ctx) : routeError("MODULE_DISABLED", "Paid Access human module is disabled.");
}

function anyModule(handler: RouteHandler): RouteHandler {
	return async (routeCtx, ctx) => {
		const settings = await loadSettings(ctx);
		return settings.agents.mode !== "off" || settings.humans.mode !== "off"
			? handler(routeCtx, ctx) : routeError("MODULE_DISABLED", "Paid Access modules are disabled.");
	};
}

function agentsOnly(handler: RouteHandler): RouteHandler {
	return async (routeCtx, ctx) => (await loadSettings(ctx)).agents.mode !== "off"
		? handler(routeCtx, ctx) : routeError("MODULE_DISABLED", "Paid Access agent module is disabled.");
}

const plugin: SandboxedPlugin = {
	hooks: {
		"page:metadata": async ({ page }, ctx) => {
			try {
				if (page.kind !== "content" || !page.content) return null;
				const { collection, id, slug } = page.content;
				const rules = await getEntryRestrictions(ctx, collection, id, slug);
				if (!rules.length) return null;
				const settings = await loadSettings(ctx);
				const contributions: PageMetadataContribution[] = [];
				if (settings.agents.mode !== "off" && slug && !rules.some(({ policy }) => policy === "members-only")) {
					// EmDash 1.0.1 link contributions have no MIME type field.
					// EmDash only accepts absolute http(s) link hrefs, so resolve against the page URL.
					const agentPath = `${settings.agentRoutePrefix}/${encodeURIComponent(collection)}/${encodeURIComponent(slug)}.md`;
					contributions.push({ kind: "link", rel: "alternate", href: new URL(agentPath, page.url).href });
				}
				if (rules.some(({ policy }) => policy === "members" || policy === "members-only")) {
					contributions.push({
						kind: "jsonld", id: "paid-access:paywall", graph: {
							"@context": "https://schema.org", "@type": "WebPage", "@id": page.url, isAccessibleForFree: false,
							hasPart: { "@type": "WebPageElement", isAccessibleForFree: false, cssSelector: ".phb-locked" },
						}
					});
				}
				return contributions.length ? contributions : null;
			} catch (error) {
				ctx.log.error("Failed to build Paid Access metadata", error);
				return null;
			}
		},
	},
	routes: {
		admin: { methods: ["POST"], permission: "plugins:manage", handler: adminHandler },
		// Whoever may publish any post may set its rule; every other private route explicitly requires plugins:manage.
		"editor/paid-access": { methods: ["POST"], permission: "content:publish_any", handler: editorHandler },
		"coexistence/report": { methods: ["POST"], permission: "plugins:manage", handler: coexistenceReport },
		checkout: { methods: ["POST"], public: true, handler: humansStripeOnly(checkoutHandler) },
		"checkout/complete": { methods: ["POST"], public: true, handler: humansStripeOnly(checkoutCompleteHandler) },
		portal: { methods: ["POST"], public: true, handler: humansStripeOnly(portalHandler) },
		access: { methods: ["POST"], public: true, handler: accessHandler },
		plans: { methods: ["GET"], public: true, handler: humansStripeOnly(plansHandler) },
		entitlement: { methods: ["GET"], public: true, handler: agentsOnly(entitlementHandler) },
		offers: { methods: ["GET"], public: true, handler: agentsOnly(offersHandler) },
		pass: { methods: ["POST"], public: true, handler: agentsOnly(unavailableAgentFeature) },
		"agent-tokens": { methods: ["POST"], permission: "plugins:manage", handler: humansStripeOnly(unavailableAgentFeature) },
		"admin/products": { methods: ["GET"], permission: "plugins:manage", handler: humansStripeOnly(productsHandler) },
		"admin/restrictions": { methods: ["GET", "POST", "DELETE"], permission: "plugins:manage", handler: anyModule(restrictionsHandler) },
		"admin/receipts": { methods: ["GET"], permission: "plugins:manage", handler: agentsOnly(receiptsHandler) },
		"admin/settings": { methods: ["GET", "POST"], permission: "plugins:manage", handler: settingsHandler },
		"auth/send-link": { methods: ["POST"], public: true, handler: humansStripeOnly(sendLinkHandler) },
		"auth/verify": { methods: ["POST"], public: true, handler: humansStripeOnly(verifyHandler) },
		"auth/session": { methods: ["POST"], public: true, handler: humansStripeOnly(sessionHandler) },
		"auth/logout": { methods: ["POST"], public: true, handler: humansStripeOnly(logoutHandler) },
		// Phase 3c: runtime.handlePluginApiRoute("paid-access", "POST", path, request)
		// invokes private routes without a user; HTTP dispatcher authentication remains required.
		"agent/context": { methods: ["POST"], permission: "plugins:manage", handler: agentContextHandler },
		"receipts/record": { methods: ["POST"], permission: "plugins:manage", handler: recordReceiptHandler },
	},
};

export default plugin;
