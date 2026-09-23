// Copyright 2026 Stranger Studios.
// Modified by Mason James, 2026-09-23.
// SPDX-License-Identifier: GPL-2.0-or-later

export function paidAccess() {
	return {
		id: "paid-access",
		version: "0.1.0",
		entrypoint: "emdash-paid-access/plugin",
		adminEntry: "emdash-paid-access/admin",
		options: {},
		capabilities: ["network:request", "email:send", "content:read"],
		allowedHosts: ["api.stripe.com", "x402.org", "api.cloudflare.com"],
		storage: {
			restrictions: { indexes: ["contentId", "collectionSlug", "slug"] },
			taxonomyRestrictions: { indexes: ["taxonomyName", "termId"] },
			customers: { indexes: ["email"] },
			authTokens: { indexes: ["email", "expiresAt"] },
			sessions: { indexes: ["email", "expiresAt"] },
		},
		adminPages: [
			{ path: "/settings", label: "Paid Access Settings" },
			{ path: "/rules", label: "Paid Access Rules" },
		],
		adminWidgets: [{ id: "overview", title: "Paid Access" }],
	};
}

export default paidAccess;
