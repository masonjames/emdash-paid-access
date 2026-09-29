// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	failClosedAgentResult,
	failClosedHumanDecision,
	legacyRulePresentation,
	probeLegacyPlugin,
	resetCoexistenceCacheForTests,
	resolveHumanMode,
	unionAccessDecisions,
} from "../src/coexistence.js";
import type { AccessDecision } from "../src/types.js";

const open: AccessDecision = {
	restricted: false,
	authenticated: false,
	hasAccess: true,
	email: null,
	requiredPlanSlugs: [],
	requiredProductIds: [],
};

beforeEach(resetCoexistenceCacheForTests);

describe("section 7 coexistence matrix", () => {
	it("uses the configured human mode when the legacy plugin is absent", () => {
		expect(resolveHumanMode("stripe", false).mode).toBe("stripe");
	});

	it("delegates human decisions when the legacy plugin is present and delegate is configured", () => {
		expect(resolveHumanMode("delegate", true).mode).toBe("delegate");
	});

	it("downgrades forced Stripe mode to delegate and warns once per process", () => {
		const warn = vi.fn();
		expect(resolveHumanMode("stripe", true, warn).mode).toBe("delegate");
		expect(resolveHumanMode("stripe", true, warn).mode).toBe("delegate");
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("takes the union when either plugin restricts an entry", () => {
		const legacy = { ...open, restricted: true, hasAccess: false, requiredPlanSlugs: ["members"] };
		expect(unionAccessDecisions(open, legacy)).toMatchObject({
			restricted: true,
			hasAccess: false,
			requiredPlanSlugs: ["members"],
		});
	});

	it("fails closed for probe, Stripe, or facilitator errors", () => {
		expect(failClosedHumanDecision()).toMatchObject({ restricted: true, hasAccess: false });
		expect(failClosedAgentResult()).toEqual({ status: 503, body: null });
	});

	it("presents a coexisting editor rule read-only", () => {
		expect(legacyRulePresentation(true, { requiredPlanSlugs: ["members"] })).toEqual({
			visible: true,
			readOnly: true,
			rule: { requiredPlanSlugs: ["members"] },
		});
	});
});

it("probes on first use and caches the result", async () => {
	const handler = vi.fn(async () => ({ success: true, status: 200 }));
	const request = new Request("https://site.test/");
	await expect(probeLegacyPlugin(handler, request)).resolves.toBe(true);
	await expect(probeLegacyPlugin(handler, request)).resolves.toBe(true);
	expect(handler).toHaveBeenCalledTimes(1);
});

it("retries after a failed probe", async () => {
	const handler = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ success: true, status: 200 });
	const request = new Request("https://site.test/");
	await expect(probeLegacyPlugin(handler, request)).rejects.toThrow("offline");
	await expect(probeLegacyPlugin(handler, request)).resolves.toBe(true);
	expect(handler).toHaveBeenCalledTimes(2);
});
