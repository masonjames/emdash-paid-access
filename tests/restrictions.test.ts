// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from "vitest";

import { restrictionsHandler } from "../src/handlers/restrictions.js";
import { MASONJAMES_PLANS } from "./fixtures/masonjames-plans.js";

describe("settings-defined restriction plans", () => {
	it("rejects an unknown plan instead of saving an unrestricted rule", async () => {
		const put = vi.fn();
		const ctx = {
			input: {
				collectionSlug: "posts",
				contentId: "post-1",
				requiredPlanSlugs: ["typo-plan"],
			},
			request: new Request("https://site.test/_emdash/api/plugins/paid-access/admin/restrictions", {
				method: "POST",
			}),
			kv: {
				get: async (key: string) => key === "humans_plans" ? MASONJAMES_PLANS : null,
			},
			storage: {
				restrictions: { get: vi.fn(), put },
				taxonomyRestrictions: { get: vi.fn(), put: vi.fn() },
			},
		};

		await expect(restrictionsHandler(ctx)).resolves.toEqual({
			ok: false,
			error: "requiredPlanSlugs contains an unknown plan.",
		});
		expect(put).not.toHaveBeenCalled();
	});
});
