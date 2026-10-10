// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { invoke } from "./fixtures/route.js";

import { afterEach, describe, expect, it, vi } from "vitest";

import { accessHandler } from "../src/handlers/access.js";
import { StripeClient } from "../src/stripe.js";

afterEach(() => { vi.restoreAllMocks(); });

function context(mode: string, policy?: string) {
	return {
		input: { collectionSlug: "posts", contentId: "one" },
		request: new Request("https://site.test/access"),
		settings: { get: async (key: string) => key === "humansMode" ? mode : null },
		storage: {
			restrictions: { get: async () => policy ? { contentId: "one", collectionSlug: "posts", policy, createdAt: "2026-09-29" } : null },
			taxonomy_restrictions: { query: async () => ({ items: [] }) },
			sessions: { get: async () => null },
		},
	};
}

const PLANS = [{ slug: "plus", name: "Plus", stripeProductId: "prod_plus", grantsVisibility: [] }];
function callerContext(mode: string, requiredPlanSlugs: string[]) {
	const base = context(mode);
	return { ...base, input: { ...base.input, requiredPlanSlugs }, settings: { get: async (key: string) => key === "humansMode" ? mode : key === "humansPlans" ? PLANS : null } };
}
// A signed-in member whose Stripe customer owns prod_plus, optionally behind a stored members rule.
function memberContext(requiredPlanSlugs: string[], rulePlanSlugs?: string[]) {
	const base = callerContext("stripe", requiredPlanSlugs);
	vi.spyOn(StripeClient.prototype, "getCustomersByEmail").mockResolvedValue({ data: [] });
	const owns = vi.spyOn(StripeClient.prototype, "customerHasProduct").mockImplementation(async (_customerId, productIds) => productIds.includes("prod_plus"));
	return { owns, ctx: {
		...base,
		input: { ...base.input, sessionToken: "member-session" },
		settings: { get: async (key: string) => key === "humansMode" ? "stripe" : key === "humansPlans" ? PLANS : key === "stripeSecretKey" ? "sk_test_fake" : null },
		http: { fetch: vi.fn() },
		storage: {
			...base.storage,
			restrictions: { get: async () => rulePlanSlugs ? { contentId: "one", collectionSlug: "posts", policy: "members", requiredPlanSlugs: rulePlanSlugs, createdAt: "2026-09-29" } : null },
			sessions: { get: async () => ({ email: "member@example.com", expiresAt: "2999-01-01T00:00:00.000Z" }) },
			customers: { get: async () => ({ stripeCustomerId: "cus_member", createdAt: "2026-09-29" }), query: async () => ({ items: [] }) },
		},
	} };
}

describe("human rule decisions", () => {
	it.each(["members", "members-only"])("keeps %s restricted without plan mapping", async (policy) => {
		await expect(invoke(accessHandler, context("stripe", policy))).resolves.toMatchObject({ restricted: true, hasAccess: false, error: "Required plans are not configured." });
	});
	it("fails closed for a human rule when humans are off", async () => {
		await expect(invoke(accessHandler, context("off", "members"))).resolves.toMatchObject({ restricted: true, hasAccess: false, error: "Member access is turned off for this site." });
		await expect(invoke(accessHandler, context("off"))).resolves.toMatchObject({ restricted: false, hasAccess: true });
	});
	it("returns the plugin decision in delegate mode", async () => {
		await expect(invoke(accessHandler, context("delegate", "members"))).resolves.toMatchObject({ delegated: true, restricted: true, hasAccess: false });
		await expect(invoke(accessHandler, context("delegate"))).resolves.toMatchObject({ delegated: true, restricted: false, hasAccess: true });
	});
	it("fails closed when a caller requires an unknown plan in stripe mode", async () => {
		await expect(invoke(accessHandler, callerContext("stripe", ["removed"]))).resolves.toMatchObject({ restricted: true, hasAccess: false, requiredPlanSlugs: ["removed"], error: "Required plans are not configured." });
	});
	it("fails closed when any caller plan is unknown, even beside a configured one", async () => {
		await expect(invoke(accessHandler, callerContext("stripe", ["plus", "removed"]))).resolves.toMatchObject({ restricted: true, hasAccess: false, requiredPlanSlugs: ["plus", "removed"], requiredProductIds: ["prod_plus"], error: "Required plans are not configured." });
	});
	it("passes caller plan slugs through unfiltered in delegate and off modes", async () => {
		await expect(invoke(accessHandler, callerContext("delegate", ["removed"]))).resolves.toMatchObject({ delegated: true, restricted: true, hasAccess: false, requiredPlanSlugs: ["removed"] });
		await expect(invoke(accessHandler, callerContext("delegate", ["plus", "removed"]))).resolves.toMatchObject({ delegated: true, restricted: true, hasAccess: false, requiredPlanSlugs: ["plus", "removed"], requiredProductIds: ["prod_plus"] });
		await expect(invoke(accessHandler, callerContext("off", ["removed"]))).resolves.toMatchObject({ restricted: true, hasAccess: false, requiredPlanSlugs: ["removed"], error: "Member access is turned off for this site." });
	});
	it("denies a signed-in member who owns a configured plan when the caller also requires an unknown one", async () => {
		await expect(invoke(accessHandler, memberContext(["plus"]).ctx)).resolves.toMatchObject({ authenticated: true, hasAccess: true });
		const { ctx, owns } = memberContext(["plus", "removed"]);
		owns.mockClear();
		await expect(invoke(accessHandler, ctx)).resolves.toMatchObject({ restricted: true, authenticated: true, hasAccess: false, error: "Required plans are not configured." });
		expect(owns).not.toHaveBeenCalled();
	});
	it("fails closed when an unknown caller plan is combined with a stored rule", async () => {
		await expect(invoke(accessHandler, memberContext([], ["plus"]).ctx)).resolves.toMatchObject({ authenticated: true, hasAccess: true });
		await expect(invoke(accessHandler, memberContext(["removed"], ["plus"]).ctx)).resolves.toMatchObject({ restricted: true, authenticated: true, hasAccess: false, requiredPlanSlugs: ["plus", "removed"], error: "Required plans are not configured." });
	});
});

it("uses the trusted coexistence report to delegate forced Stripe before querying membership", async () => {
	const ctx = { ...context("stripe", "members"), kv: { get: async () => true } };
	await expect(invoke(accessHandler, ctx)).resolves.toMatchObject({ humanMode: "stripe", delegated: true, restricted: true, hasAccess: false, showExcerpts: true });
});
