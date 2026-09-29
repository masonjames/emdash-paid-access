// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from "vitest";

import { entitlementHandler, offersHandler, receiptsHandler } from "../src/handlers/agents.js";

function kvGet(key: string) {
	const values: Record<string, unknown> = {
		agents_mode: "paid",
		agents_rail: "origin-x402",
		agents_pay_to: "0x1111111111111111111111111111111111111111",
		agents_network: "eip155:84532",
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
			kv: { get: kvGet },
			storage: {
				restrictions: { get: async (key: string) => records[key] ?? null },
				taxonomyRestrictions: {
					get: async (key: string) => records[key] ?? null,
					query: vi.fn(),
				},
			},
			taxonomies: { getEntryTerms: async () => [{ taxonomy: "category", id: "premium" }] },
		};
		await expect(entitlementHandler(ctx)).resolves.toMatchObject({
			policy: "members",
			human: "denied",
			agent: "payment-required",
			status: 402,
			price: "$0.05",
		});
	});

	it("lists only purchasable offers", async () => {
		const ctx = {
			request: new Request("https://site.test/offers?limit=1"),
			kv: { get: kvGet },
			content: { get: async () => ({ status: "published", slug: "paid", data: { title: "Paid post" } }) },
			storage: {
				restrictions: { query: async () => ({ items: [
					{ id: "paid", data: { contentId: "1", collectionSlug: "posts", policy: "agents-pay", agentPrice: "$0.01", requiredPlanSlugs: ["secret"], productIds: ["prod_secret"], passEligible: true, createdAt: "2026-09-23T00:00:00.000Z" } },
				], nextCursor: "page-2" }) },
				taxonomyRestrictions: { query: async () => ({ items: [] }) },
			},
		};
		await expect(offersHandler(ctx)).resolves.toEqual({ items: [{ type: "content", collection: "posts", slug: "paid", title: "Paid post", price: "$0.01", policy: "agents-pay", network: "eip155:84532" }], nextCursor: "content:page-2" });
	});

	it("skips drafts and pages taxonomy offers without private rule fields", async () => {
		const query = vi.fn(async () => ({ items: [{ data: { taxonomyName: "tag", termId: "premium", policy: "members", agentPrice: "$0.05", productIds: ["private"], createdAt: "2026-09-29" } }], nextCursor: "more" }));
		const ctx = {
			request: new Request("https://site.test/offers?cursor=taxonomy:prior&limit=2"),
			kv: { get: kvGet },
			storage: { restrictions: { query: vi.fn() }, taxonomyRestrictions: { query } },
		};
		await expect(offersHandler(ctx)).resolves.toEqual({ items: [{ type: "taxonomy", taxonomy: "tag", termId: "premium", price: "$0.05", policy: "members", network: "eip155:84532" }], nextCursor: "taxonomy:more" });
		expect(query).toHaveBeenCalledWith({ limit: 2, cursor: "prior" });
		const draft = { ...ctx, request: new Request("https://site.test/offers"), content: { get: async () => ({ status: "draft", slug: "hidden", data: { title: "Hidden" } }) },
			storage: { restrictions: { query: async () => ({ items: [{ data: { contentId: "secret", collectionSlug: "posts", policy: "agents-pay", agentPrice: "$0.01", createdAt: "2026-09-29" } }] }) }, taxonomyRestrictions: { query: async () => ({ items: [] }) } } };
		await expect(offersHandler(draft)).resolves.toEqual({ items: [], nextCursor: null });
		await expect(offersHandler({ ...draft, content: undefined })).resolves.toEqual({ items: [], nextCursor: null });
		await expect(offersHandler({ ...draft, content: { get: async () => { throw new Error("unavailable"); } } })).resolves.toEqual({ items: [], nextCursor: null });
	});

	it("returns the receipts ledger", async () => {
		const items = [{ id: "receipt:tx", data: { transaction: "tx" } }];
		const ctx = {
			request: new Request("https://site.test/_emdash/api/plugins/paid-access/admin/receipts"),
			storage: { receipts: { query: async () => ({ items }) } },
		};
		await expect(receiptsHandler(ctx)).resolves.toEqual({ items });
	});
});
