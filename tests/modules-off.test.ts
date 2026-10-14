// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { invoke } from "./fixtures/route.js";

import { describe, expect, it } from "vitest";

import { accessHandler } from "../src/handlers/access.js";
import plugin from "../src/plugin.js";

function context() {
	return {
		input: { contentId: "post-1", collectionSlug: "posts" },
		request: new Request("https://site.test/_emdash/api/plugins/paid-access/access"),
		settings: {
			get: async () => null,
			set: async () => undefined,
			delete: async () => undefined,
		},
		storage: { restrictions: { get: async () => null }, taxonomy_restrictions: { query: async () => ({ items: [] }) } },
	};
}

describe("both modules off", () => {
	it("reports an unrestricted entry as open while modules are off", async () => {
		await expect(invoke(accessHandler, context())).resolves.toMatchObject({ restricted: false, hasAccess: true });
	});

	it("keeps settings available and returns MODULE_DISABLED from operational routes", async () => {

		await expect(invoke(plugin.routes["admin/settings"].handler, context())).resolves.toMatchObject({
			agents: { mode: "off" },
			humans: { mode: "off" },
		});
		for (const routeName of Object.keys(plugin.routes).filter((name) => !["access", "auth/logout", "admin/settings", "admin", "editor/paid-access", "agent/context", "receipts/record", "entitlements", "reader/group"].includes(name))) {
			await expect(invoke(plugin.routes[routeName].handler, context())).resolves.toMatchObject({ ok: false, error: { code: "MODULE_DISABLED" } });
		}
		// The companion must still learn the mode, so entitlements answers with nothing to grant.
		await expect(invoke(plugin.routes.entitlements.handler, context())).resolves.toEqual({ ok: true, humanMode: "off", authenticated: false, planSlugs: [] });
	});
});

it.each(["off", "migration-required", "delegate"])("revokes native sessions even when membership mode is %s", async humansMode => {
 const deleted: string[] = [];
 const ctx = { ...context(), input: { sessionToken: "native-session" }, settings: { get: async (key: string) => key === "humansMode" ? humansMode : null }, storage: { sessions: { delete: async (id: string) => { deleted.push(id); } } } };
 await expect(invoke(plugin.routes["auth/logout"].handler, ctx)).resolves.toEqual({ ok: true });
 expect(deleted).toEqual(["aadb1f87a13328af74ebd0ebad6e1714dd0b89f205d0175ed15cda0ae74b6a1a"]);
});
