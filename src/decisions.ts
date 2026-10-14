// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AccessDecision } from "./types.js";

export type PublicPluginRouteHandler = (
	pluginId: string,
	method: string,
	path: string,
	request: Request,
) => Promise<{ success: boolean; status?: number; data?: unknown; error?: unknown }>;

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

export function unionAccessDecisions(left: AccessDecision, right: AccessDecision): AccessDecision {
	const restricted = left.restricted || right.restricted;
	return {
		restricted,
		authenticated: left.authenticated || right.authenticated,
		hasAccess: !restricted || (!left.restricted || left.hasAccess) && (!right.restricted || right.hasAccess),
		email: left.email ?? right.email,
		requiredPlanSlugs: [...new Set([...left.requiredPlanSlugs, ...right.requiredPlanSlugs])],
		requiredProductIds: [...new Set([...left.requiredProductIds, ...right.requiredProductIds])],
		error: left.error ?? right.error,
	};
}
