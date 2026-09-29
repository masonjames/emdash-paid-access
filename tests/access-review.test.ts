// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { invoke } from "./fixtures/route.js";

import { describe, expect, it } from "vitest";

import { accessHandler } from "../src/handlers/access.js";

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
});

it("uses the trusted coexistence report to delegate forced Stripe before querying membership", async () => {
	const ctx = { ...context("stripe", "members"), kv: { get: async () => true } };
	await expect(invoke(accessHandler, ctx)).resolves.toMatchObject({ humanMode: "stripe", delegated: true, restricted: true, hasAccess: false, showExcerpts: true });
});
