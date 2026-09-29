// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from "vitest";

import { accessHandler } from "../src/handlers/access.js";
import { createPlugin } from "../src/plugin.js";

function context() {
	return {
		input: { contentId: "post-1", collectionSlug: "posts" },
		request: new Request("https://site.test/_emdash/api/plugins/paid-access/access"),
		kv: {
			get: async () => null,
			set: async () => undefined,
			delete: async () => undefined,
		},
		storage: { restrictions: { get: async () => null }, taxonomyRestrictions: { query: async () => ({ items: [] }) } },
	};
}

describe("both modules off", () => {
	it("reports an unrestricted entry as open while modules are off", async () => {
		await expect(accessHandler(context())).resolves.toMatchObject({ restricted: false, hasAccess: true });
	});

	it("keeps settings available and returns 404 from operational routes", async () => {
		const plugin = createPlugin() as any;
		await expect(plugin.routes["admin/settings"].handler(context())).resolves.toMatchObject({
			agents: { mode: "off" },
			humans: { mode: "off" },
		});
		for (const routeName of Object.keys(plugin.routes).filter((name) => !["access", "admin/settings"].includes(name))) {
			await expect(plugin.routes[routeName].handler(context())).rejects.toMatchObject({ status: 404 });
		}
	});
});
