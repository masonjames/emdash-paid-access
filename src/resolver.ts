// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AccessPolicy, AgentMode } from "./types.js";

export const CONTENT_SIGNAL = "ai-train=no, search=yes, ai-input=yes";

export type ResolverInput = {
	policies: AccessPolicy[];
	audience: "human" | "agent";
	agentsMode: AgentMode;
	humanAuthorized?: boolean;
	agentAuthorized?: boolean;
	error?: boolean;
	/** Serve entries with no rule to agents as free Markdown. Off unless the site opts in. */
	freeByDefault?: boolean;
};

export type ResolverResult = {
	policy: AccessPolicy;
	human: "granted" | "denied" | "error";
	agent: "granted" | "payment-required" | "subscriber-only" | "disabled" | "error";
	status: number;
	headers: Record<string, string>;
};

const POLICY_WEIGHT: Record<AccessPolicy, number> = {
	public: 0,
	"agents-pay": 1,
	members: 2,
	"members-only": 3,
};

export function resolveAccess(input: ResolverInput): ResolverResult {
	const policy = input.policies.reduce<AccessPolicy>(
		(strongest, candidate) => POLICY_WEIGHT[candidate] > POLICY_WEIGHT[strongest] ? candidate : strongest,
		"public",
	);
	const humanRestricted = policy === "members" || policy === "members-only";
	const human = input.error ? "error" : humanRestricted && !input.humanAuthorized ? "denied" : "granted";

	let agent: ResolverResult["agent"];
	if (input.error) agent = "error";
	else if (input.agentsMode === "off") agent = "disabled";
	// Entries without a rule are opt-in: another plugin or the theme may restrict them.
	else if (input.policies.length === 0 && !input.freeByDefault) agent = "disabled";
	else if (policy === "public" || input.agentAuthorized) agent = "granted";
	else if (policy === "members-only" || input.agentsMode === "tokens-only") agent = "subscriber-only";
	else agent = "payment-required";

	const status = input.audience === "human"
		? 200
		: ({ granted: 200, "payment-required": 402, "subscriber-only": 403, disabled: 404, error: 503 } as const)[agent];
	const headers: Record<string, string> = input.audience === "agent" && status === 200
		? { "Cache-Control": "private, no-store", "Content-Signal": CONTENT_SIGNAL }
		: {};
	return { policy, human, agent, status, headers };
}
