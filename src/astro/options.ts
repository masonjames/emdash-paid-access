// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { LEGACY_PLUGIN_ID } from "../coexistence.js";
import { sanitizeRedirectPath } from "../utils.js";

export const TEST_FACILITATOR_URL = "https://x402.org/facilitator";

export interface PaidAccessOptions {
	/** Requires host readerProtection bindings and emdash/reader-access support. */
	readerProtection?: boolean;
	hostPayments?: boolean;
	/** Reader decision deadline in milliseconds (100–10000). */
	entitlementTimeoutMs?: number;
	/** Per-process paid-route admission limits. */
	paymentMaxConcurrent?: number;
	paymentRequestsPerMinute?: number;
	collections?: string[];
	agentRoutePrefix?: string;
	accountPath?: string;
	injectAccountRoutes?: boolean;
	facilitatorUrl?: string;
	legacyPluginId?: string;
}
export function resolveOptions(input: PaidAccessOptions = {}): Required<PaidAccessOptions> {
	const options = { entitlementTimeoutMs: 1500, paymentMaxConcurrent: 8, paymentRequestsPerMinute: 120, hostPayments: false, readerProtection: false, collections: ["posts"], agentRoutePrefix: "/agents", accountPath: "/account", injectAccountRoutes: true,
		facilitatorUrl: TEST_FACILITATOR_URL, legacyPluginId: LEGACY_PLUGIN_ID, ...input };
	for (const key of ["agentRoutePrefix", "accountPath"] as const) {
		const path = options[key];
		if (typeof path !== "string" || sanitizeRedirectPath(path, "") !== path || !path.startsWith("/") || path.endsWith("/") || path.includes("..") || /[?#%\[\]\s]/.test(path)) {
			throw new Error(`Paid Access ${key} must be an absolute path without a trailing slash, query, or '..'.`);
		}
	}
	if (!Array.isArray(options.collections) || !options.collections.length || options.collections.some(value => typeof value !== "string" || !value.trim())) {
		throw new Error("Paid Access collections must contain non-empty strings.");
	}
	for (const [key, min, max] of [["entitlementTimeoutMs", 100, 10000], ["paymentMaxConcurrent", 1, 64], ["paymentRequestsPerMinute", 1, 6000]] as const) {
		if (!Number.isInteger(options[key]) || options[key] < min || options[key] > max) throw new Error(`Paid Access ${key} must be an integer from ${min} to ${max}.`);
	}
	let facilitator: URL;
	try { facilitator = new URL(options.facilitatorUrl); }
	catch { throw new Error("Paid Access facilitatorUrl must be an absolute HTTPS URL."); }
	if (facilitator.protocol !== "https:" || facilitator.username || facilitator.password || facilitator.search || facilitator.hash) {
		throw new Error("Paid Access facilitatorUrl must use HTTPS without credentials, a query, or a fragment.");
	}
	options.facilitatorUrl = facilitator.href.replace(/\/+$/, "");
	return options;
}
