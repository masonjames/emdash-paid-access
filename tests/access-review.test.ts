// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from "vitest";

import { accessHandler } from "../src/handlers/access.js";

function context(mode: string, policy?: string) {
	return {
		input: { collectionSlug: "posts", contentId: "one" },
		request: new Request("https://site.test/access"),
		kv: { get: async (key: string) => key === "humans_mode" ? mode : null },
		storage: {
			restrictions: { get: async () => policy ? { contentId: "one", collectionSlug: "posts", policy, createdAt: "2026-09-29" } : null },
			taxonomyRestrictions: { query: async () => ({ items: [] }) },
			sessions: { get: async () => null },
		},
	};
}

describe("human rule decisions", () => {
	it.each(["members", "members-only"])("keeps %s restricted without plan mapping", async (policy) => {
		await expect(accessHandler(context("stripe", policy))).resolves.toMatchObject({ restricted: true, hasAccess: false, error: "Required plans are not configured." });
	});
	it("fails closed for a human rule when humans are off", async () => {
		await expect(accessHandler(context("off", "members"))).resolves.toMatchObject({ restricted: true, hasAccess: false, error: "Member access is turned off for this site." });
		await expect(accessHandler(context("off"))).resolves.toMatchObject({ restricted: false, hasAccess: true });
	});
	it("returns the plugin decision in delegate mode", async () => {
		await expect(accessHandler(context("delegate", "members"))).resolves.toMatchObject({ delegated: true, restricted: true, hasAccess: false });
		await expect(accessHandler(context("delegate"))).resolves.toMatchObject({ delegated: true, restricted: false, hasAccess: true });
	});
});
