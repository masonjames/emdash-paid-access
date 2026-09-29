// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { LEGACY_PLUGIN_ID } from "../coexistence.js";
import { sanitizeRedirectPath } from "../utils.js";

export interface PaidAccessOptions {
	collections?: string[];
	agentRoutePrefix?: string;
	accountPath?: string;
	injectAccountRoutes?: boolean;
	facilitatorUrl?: string;
	legacyPluginId?: string;
}
export function resolveOptions(input: PaidAccessOptions = {}): Required<PaidAccessOptions> {
	const options = { collections: ["posts"], agentRoutePrefix: "/agents", accountPath: "/account", injectAccountRoutes: true,
		facilitatorUrl: "https://x402.org/facilitator", legacyPluginId: LEGACY_PLUGIN_ID, ...input };
	for (const key of ["agentRoutePrefix", "accountPath"] as const) {
		const path = options[key];
		if (typeof path !== "string" || sanitizeRedirectPath(path, "") !== path || !path.startsWith("/") || path.endsWith("/") || path.includes("..") || /[?#%\[\]\s]/.test(path)) {
			throw new Error(`Paid Access ${key} must be an absolute path without a trailing slash, query, or '..'.`);
		}
	}
	if (!Array.isArray(options.collections) || !options.collections.length || options.collections.some(value => typeof value !== "string" || !value.trim())) {
		throw new Error("Paid Access collections must contain non-empty strings.");
	}
	return options;
}
