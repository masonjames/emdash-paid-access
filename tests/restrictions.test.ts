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

	it("stores per-entry policy, agent price and pass eligibility", async () => {
		const put = vi.fn();
		const ctx = {
			input: {
				collectionSlug: "posts",
				contentId: "post-1",
				slug: "paid-post",
				policy: "agents-pay",
				agentPrice: "$0.025",
				passEligible: true,
			},
			request: new Request("https://site.test/_emdash/api/plugins/paid-access/admin/restrictions", { method: "POST" }),
			kv: { get: async () => null },
			storage: {
				restrictions: { get: vi.fn(), put },
				taxonomyRestrictions: { get: vi.fn(), put: vi.fn() },
			},
		};
		await expect(restrictionsHandler(ctx)).resolves.toMatchObject({ ok: true });
		expect(put).toHaveBeenCalledWith("posts:post-1", expect.objectContaining({
			policy: "agents-pay",
			agentPrice: "$0.025",
			passEligible: true,
		}));
	});

	it("requires a valid price for agent-sale policies", async () => {
		const put = vi.fn();
		const ctx = {
			input: { collectionSlug: "posts", contentId: "post-1", policy: "members", agentPrice: "free" },
			request: new Request("https://site.test/_emdash/api/plugins/paid-access/admin/restrictions", { method: "POST" }),
			kv: { get: async () => null },
			storage: {
				restrictions: { get: vi.fn(), put },
				taxonomyRestrictions: { get: vi.fn(), put: vi.fn() },
			},
		};
		await expect(restrictionsHandler(ctx)).resolves.toEqual({
			ok: false,
			error: "agentPrice must be a dollar amount with at most six decimals.",
		});
		expect(put).not.toHaveBeenCalled();
	});

	it("stores the same policy fields on taxonomy rules", async () => {
		const put = vi.fn();
		const ctx = {
			input: {
				type: "taxonomy",
				taxonomyName: "category",
				termId: "premium",
				policy: "members-only",
				passEligible: true,
			},
			request: new Request("https://site.test/_emdash/api/plugins/paid-access/admin/restrictions", { method: "POST" }),
			kv: { get: async () => null },
			storage: {
				restrictions: { get: vi.fn(), put: vi.fn() },
				taxonomyRestrictions: { get: vi.fn(), put },
			},
		};
		await expect(restrictionsHandler(ctx)).resolves.toEqual({ ok: true });
		expect(put).toHaveBeenCalledWith("category:premium", expect.objectContaining({
			policy: "members-only",
			agentPrice: null,
			passEligible: true,
		}));
	});
});
