// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AccessDecision, HumanMode } from "./types.js";

export const LEGACY_PLUGIN_ID = "restrict-with-stripe";
const LEGACY_SESSION_ROUTE = "auth/session";

export type PublicPluginRouteHandler = (
	pluginId: string,
	method: string,
	path: string,
	request: Request,
) => Promise<{ success: boolean; status?: number; data?: unknown; error?: unknown }>;

let cachedProbe: Promise<boolean> | undefined;
// "Present" is cached for the life of the process. "Absent" is rechecked, because a
// plugin can be enabled without a restart.
// ponytail: up to a minute of stale "absent" after enabling the legacy plugin; restart to close it at once.
export const ABSENT_TTL_MS = 60_000;
let absentSince = 0;
/** When the current "absent" answer was probed, or 0. Callers that cache it expire with it. */
export function legacyAbsentSince(): number { return absentSince; }
let warnedAboutDowngrade = false;

export function resetCoexistenceCacheForTests(): void {
	cachedProbe = undefined;
	absentSince = 0;
	warnedAboutDowngrade = false;
}

export function probeLegacyPlugin(
	handler: PublicPluginRouteHandler,
	request: Request,
): Promise<boolean> {
	if (absentSince && Date.now() - absentSince > ABSENT_TTL_MS) { cachedProbe = undefined; absentSince = 0; }
	cachedProbe ??= handler(LEGACY_PLUGIN_ID, "GET", LEGACY_SESSION_ROUTE, request).then((result) => {
		if (result.status === 404 || (!result.success && typeof result.error === "object" && result.error !== null && "code" in result.error && result.error.code === "NOT_FOUND")) {
			absentSince = Date.now();
			return false;
		}
		if (!result.success) throw new Error("Legacy membership plugin probe failed.");
		return true;
	}).catch((error: unknown) => {
		cachedProbe = undefined;
		throw error;
	});
	return cachedProbe;
}

export async function probeLegacyPluginFromBrowser(fetcher: typeof fetch = fetch): Promise<boolean> {
	const response = await fetcher(`/_emdash/api/plugins/${LEGACY_PLUGIN_ID}/${LEGACY_SESSION_ROUTE}`, {
		headers: { "X-EmDash-Request": "1" },
	});
	if (response.status === 404) return false;
	if (!response.ok) throw new Error("Legacy membership plugin probe failed.");
	return true;
}

export function resolveHumanMode(
	configuredMode: HumanMode,
	legacyPluginPresent: boolean,
	warn: (message: string) => void = console.warn,
): { mode: HumanMode; failClosed: false } {
	if (legacyPluginPresent && configuredMode === "stripe") {
		if (!warnedAboutDowngrade) {
			warnedAboutDowngrade = true;
			warn("Paid Access downgraded humans.mode from stripe to delegate because the legacy plugin is active.");
		}
		return { mode: "delegate", failClosed: false };
	}
	return { mode: configuredMode, failClosed: false };
}

export function failClosedHumanDecision(error = "Unable to verify access."): AccessDecision {
	return {
		restricted: true,
		authenticated: false,
		hasAccess: false,
		email: null,
		requiredPlanSlugs: [],
		requiredProductIds: [],
		error,
	};
}

export function failClosedAgentResult(): { status: 503; body: null } {
	return { status: 503, body: null };
}

export function unionAccessDecisions(ours: AccessDecision, legacy: AccessDecision): AccessDecision {
	const restricted = ours.restricted || legacy.restricted;
	return {
		restricted,
		authenticated: ours.authenticated || legacy.authenticated,
		hasAccess: !restricted || (!ours.restricted || ours.hasAccess) && (!legacy.restricted || legacy.hasAccess),
		email: ours.email ?? legacy.email,
		requiredPlanSlugs: [...new Set([...ours.requiredPlanSlugs, ...legacy.requiredPlanSlugs])],
		requiredProductIds: [...new Set([...ours.requiredProductIds, ...legacy.requiredProductIds])],
		error: ours.error ?? legacy.error,
	};
}

export function legacyRulePresentation<T>(legacyPluginPresent: boolean, rule: T | null): {
	visible: boolean;
	readOnly: true;
	rule: T | null;
} {
	return { visible: legacyPluginPresent && rule !== null, readOnly: true, rule };
}
