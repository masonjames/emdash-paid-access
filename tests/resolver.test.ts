// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from "vitest";

import { CONTENT_SIGNAL, resolveAccess } from "../src/resolver.js";
import type { AccessPolicy } from "../src/types.js";

describe("paid access resolver", () => {
	it.each([
		["public", "granted", "granted", 200],
		["agents-pay", "granted", "payment-required", 402],
		["members", "denied", "payment-required", 402],
		["members-only", "denied", "subscriber-only", 403],
	] as const)("resolves %s policy", (policy, human, agent, status) => {
		expect(resolveAccess({ policies: [policy], audience: "agent", agentsMode: "paid" })).toEqual({
			policy,
			human,
			agent,
			status,
			headers: status === 200
				? { "Cache-Control": "private, no-store", "Content-Signal": CONTENT_SIGNAL }
				: {},
		});
	});

	it("takes the union by selecting the strictest policy", () => {
		const policies: AccessPolicy[] = ["agents-pay", "members-only", "public"];
		expect(resolveAccess({ policies, audience: "agent", agentsMode: "paid" }).policy).toBe("members-only");
	});

	it("fails closed and keeps human pages at 200", () => {
		expect(resolveAccess({ policies: ["members"], audience: "agent", agentsMode: "paid", error: true })).toMatchObject({ agent: "error", status: 503 });
		expect(resolveAccess({ policies: ["members"], audience: "human", agentsMode: "paid", error: true })).toMatchObject({ human: "error", status: 200 });
	});

	it("404s agents when the module is off", () => {
		expect(resolveAccess({ policies: ["public"], audience: "agent", agentsMode: "off" })).toMatchObject({ agent: "disabled", status: 404 });
	});
});

it("keeps entries without a rule away from agents unless the site opts in", () => {
	expect(resolveAccess({ policies: [], audience: "agent", agentsMode: "paid" })).toMatchObject({ agent: "disabled", status: 404 });
	expect(resolveAccess({ policies: [], audience: "agent", agentsMode: "paid", freeByDefault: true })).toMatchObject({ agent: "granted", status: 200 });
	expect(resolveAccess({ policies: ["public"], audience: "agent", agentsMode: "paid" })).toMatchObject({ agent: "granted", status: 200 });
	expect(resolveAccess({ policies: [], audience: "human", agentsMode: "paid" })).toMatchObject({ human: "granted", status: 200 });
});
