// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { invoke } from "./fixtures/route.js";

import { describe, expect, it, vi } from "vitest";

import { restrictionsHandler } from "../src/handlers/restrictions.js";
import { MASONJAMES_PLANS } from "./fixtures/masonjames-plans.js";

describe("settings-defined restriction plans", () => {
	it("preserves omitted fields on content and taxonomy updates", async () => {
		const saved = new Map<string, Record<string, unknown>>();
		const collection = {
			get: async (key: string) => saved.get(key) ?? null,
			put: async (key: string, value: Record<string, unknown>) => { saved.set(key, value); },
		};
		const ctx = {
			input: { collectionSlug: "posts", contentId: "one", policy: "members-only", requiredPlanSlugs: ["default-product"], productIds: ["prod_1"], title: "Original", slug: "original", passEligible: true },
			request: new Request("https://site.test/restrictions", { method: "POST" }),
			settings: { get: async (key: string) => key === "humansPlans" ? MASONJAMES_PLANS : null },
			storage: { restrictions: collection, taxonomy_restrictions: collection },
		};
		await invoke(restrictionsHandler, ctx);
		await invoke(restrictionsHandler, { ...ctx, input: { collectionSlug: "posts", contentId: "one" } });
		expect(saved.get("posts:one")).toMatchObject({ policy: "members-only", requiredPlanSlugs: ["default-product"], productIds: ["prod_1"], title: "Original", slug: "original", passEligible: true });
		await invoke(restrictionsHandler, { ...ctx, input: { type: "taxonomy", taxonomyName: "tag", termId: "one", policy: "members-only", productIds: ["prod_2"], passEligible: true } });
		await invoke(restrictionsHandler, { ...ctx, input: { type: "taxonomy", taxonomyName: "tag", termId: "one" } });
		expect(saved.get("tag:one")).toMatchObject({ policy: "members-only", productIds: ["prod_2"], passEligible: true });
	});

	it("allows a member policy without a price when agents are off", async () => {
		const put = vi.fn();
		await expect(invoke(restrictionsHandler, { input: { collectionSlug: "posts", contentId: "one", policy: "members" },
			request: new Request("https://site.test/restrictions", { method: "POST" }), settings: { get: async () => null },
			storage: { restrictions: { get: async () => null, put }, taxonomy_restrictions: { get: async () => null } } })).resolves.toMatchObject({ ok: true });
		expect(put).toHaveBeenCalledOnce();
	});

	it("requires a price for an agent-sale rule when agents are paid", async () => {
		const put = vi.fn();
		await expect(invoke(restrictionsHandler, { input: { collectionSlug: "posts", contentId: "one", policy: "members" },
			request: new Request("https://site.test/restrictions", { method: "POST" }),
			settings: { get: async (key: string) => key === "agentsMode" ? "paid" : null },
			storage: { restrictions: { get: async () => null, put } } })).resolves.toMatchObject({ ok: false, error: "A valid agentPrice is required for a policy sold to agents." });
		expect(put).not.toHaveBeenCalled();
	});
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
			settings: {
				get: async (key: string) => key === "humansPlans" ? MASONJAMES_PLANS : null,
			},
			storage: {
				restrictions: { get: vi.fn(), put },
				taxonomy_restrictions: { get: vi.fn(), put: vi.fn() },
			},
		};

		await expect(invoke(restrictionsHandler, ctx)).resolves.toEqual({
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
			settings: { get: async () => null },
			storage: {
				restrictions: { get: vi.fn(), put },
				taxonomy_restrictions: { get: vi.fn(), put: vi.fn() },
			},
		};
		await expect(invoke(restrictionsHandler, ctx)).resolves.toMatchObject({ ok: true });
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
			settings: { get: async () => null },
			storage: {
				restrictions: { get: vi.fn(), put },
				taxonomy_restrictions: { get: vi.fn(), put: vi.fn() },
			},
		};
		await expect(invoke(restrictionsHandler, ctx)).resolves.toEqual({
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
			settings: { get: async () => null },
			storage: {
				restrictions: { get: vi.fn(), put: vi.fn() },
				taxonomy_restrictions: { get: vi.fn(), put },
			},
		};
		await expect(invoke(restrictionsHandler, ctx)).resolves.toEqual({ ok: true });
		expect(put).toHaveBeenCalledWith("category:premium", expect.objectContaining({
			policy: "members-only",
			agentPrice: null,
			passEligible: true,
		}));
	});
});
