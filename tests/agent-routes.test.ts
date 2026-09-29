// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { invoke } from "./fixtures/route.js";

import { describe, expect, it, vi } from "vitest";

import { entitlementHandler, offersHandler, receiptsHandler } from "../src/handlers/agents.js";

function kvGet(key: string) {
	const values: Record<string, unknown> = {
		agentsMode: "paid",
		agentsRail: "origin-x402",
		agentsPayTo: "0x1111111111111111111111111111111111111111",
		agentsNetwork: "eip155:84532",
	};
	return Promise.resolve(values[key] ?? null);
}

describe("agent plugin routes", () => {
	it("unions entry and taxonomy policies and chooses the highest price", async () => {
		const records: Record<string, unknown> = {
			"posts:post-1": {
				contentId: "post-1",
				collectionSlug: "posts",
				policy: "agents-pay",
				agentPrice: "$0.01",
				createdAt: "2026-09-23T00:00:00.000Z",
			},
			"category:premium": {
				taxonomyName: "category",
				termId: "premium",
				policy: "members",
				agentPrice: "$0.05",
				createdAt: "2026-09-23T00:00:00.000Z",
			},
		};
		const ctx = {
			request: new Request("https://site.test/_emdash/api/plugins/paid-access/entitlement?collection=posts&contentId=post-1"),
			settings: { get: kvGet },
			storage: {
				restrictions: { get: async (key: string) => records[key] ?? null },
				taxonomy_restrictions: {
					get: async (key: string) => records[key] ?? null,
					query: vi.fn(),
				},
			},
			taxonomies: { getEntryTerms: async () => [{ taxonomy: "category", id: "premium" }] },
		};
		await expect(invoke(entitlementHandler, ctx)).resolves.toMatchObject({
			policy: "members",
			human: "denied",
			agent: "payment-required",
			status: 402,
			price: "$0.05",
		});
	});

	const paidRule = { contentId: "1", collectionSlug: "posts", policy: "agents-pay", agentPrice: "$0.01", requiredPlanSlugs: ["secret"], productIds: ["prod_secret"], passEligible: true, createdAt: "2026-09-23T00:00:00.000Z" };
	it("lists only purchasable offers", async () => {
		const ctx = {
			request: new Request("https://site.test/offers?limit=1"),
			settings: { get: kvGet },
			content: { get: async () => ({ id: "1", status: "published", slug: "paid", data: { title: "Paid post" } }) },
			storage: {
				restrictions: { query: async () => ({ items: [{ id: "posts:1", data: paidRule }], cursor: "page-2" }), get: async (key: string) => key === "posts:1" ? paidRule : null },
				taxonomy_restrictions: { query: async () => ({ items: [] }) },
			},
		};
		await expect(invoke(offersHandler, ctx)).resolves.toEqual({ items: [{ type: "content", collection: "posts", slug: "paid", title: "Paid post", price: "$0.01", policy: "agents-pay", network: "eip155:84532", url: "/agents/posts/paid.md" }], nextCursor: "content:page-2" });
	});

	it("lists what the agent route sells, once, at the price it charges", async () => {
		const offers = (inherited: unknown, get = kvGet) => invoke(offersHandler, {
			request: new Request("https://site.test/offers"), settings: { get },
			content: { get: async () => ({ id: "1", status: "published", slug: "paid", data: { title: "Paid post" } }) },
			taxonomies: { getEntryTerms: async () => [{ taxonomy: "tag", id: "t" }] },
			storage: {
				// A legacy slug-keyed copy of the same rule must not list the post twice.
				restrictions: { query: async () => ({ items: [{ id: "posts:1", data: paidRule }, { id: "posts:paid", data: { ...paidRule, contentId: "paid" } }] }), get: async (key: string) => key === "posts:1" ? paidRule : null },
				taxonomy_restrictions: { query: async () => ({ items: [] }), get: async () => inherited },
			},
		}) as Promise<{ items: Array<Record<string, string>> }>;
		const tag = (policy: string, agentPrice: string | null) => ({ taxonomyName: "tag", termId: "t", policy, agentPrice, createdAt: "2026-09-29" });
		expect((await offers(tag("members-only", null))).items).toEqual([]);
		expect((await offers(tag("members", "$0.05"))).items).toEqual([expect.objectContaining({ price: "$0.05", policy: "members" })]);
		// Tokens-only mode sells nothing.
		expect((await offers(tag("members", "$0.05"), async (key: string) => key === "agentsMode" ? "tokens-only" : kvGet(key))).items).toEqual([]);
	});

	it("skips drafts and pages taxonomy offers without private rule fields", async () => {
		const query = vi.fn(async () => ({ items: [{ data: { taxonomyName: "tag", termId: "premium", policy: "members", agentPrice: "$0.05", productIds: ["private"], createdAt: "2026-09-29" } }], cursor: "more" }));
		const ctx = {
			request: new Request("https://site.test/offers?cursor=taxonomy:prior&limit=2"),
			settings: { get: kvGet },
			storage: { restrictions: { query: vi.fn() }, taxonomy_restrictions: { query } },
		};
		await expect(invoke(offersHandler, ctx)).resolves.toEqual({ items: [{ type: "taxonomy", taxonomy: "tag", termId: "premium", price: "$0.05", policy: "members", network: "eip155:84532" }], nextCursor: "taxonomy:more" });
		expect(query).toHaveBeenCalledWith({ limit: 2, cursor: "prior" });
		const draft = { ...ctx, request: new Request("https://site.test/offers"), content: { get: async () => ({ status: "draft", slug: "hidden", data: { title: "Hidden" } }) },
			storage: { restrictions: { query: async () => ({ items: [{ data: { contentId: "secret", collectionSlug: "posts", policy: "agents-pay", agentPrice: "$0.01", createdAt: "2026-09-29" } }] }) }, taxonomy_restrictions: { query: async () => ({ items: [] }) } } };
		await expect(invoke(offersHandler, draft)).resolves.toEqual({ items: [], nextCursor: null });
		await expect(invoke(offersHandler, { ...draft, content: undefined })).resolves.toEqual({ items: [], nextCursor: null });
		await expect(invoke(offersHandler, { ...draft, content: { get: async () => { throw new Error("unavailable"); } } })).resolves.toEqual({ items: [], nextCursor: null });
	});

	it("returns the receipts ledger", async () => {
		const items = [{ id: "receipt:tx", data: { transaction: "tx" } }];
		const ctx = {
			request: new Request("https://site.test/_emdash/api/plugins/paid-access/admin/receipts"),
			storage: { receipts: { query: async () => ({ items }) } },
		};
		await expect(invoke(receiptsHandler, ctx)).resolves.toEqual({ items });
	});
});
