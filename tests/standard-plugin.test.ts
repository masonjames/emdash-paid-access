// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PluginContext } from "emdash/plugin";
import { describe, expect, it, vi } from "vitest";
import plugin from "../src/plugin.js";
import { invoke } from "./fixtures/route.js";
import { MASONJAMES_PLANS } from "./fixtures/masonjames-plans.js";

function context(settings: Record<string, unknown> = {}, policy = "members", taxonomyPolicy?: string) {
	const rule = { contentId: "1", collectionSlug: "posts", policy, agentPrice: "$0.01", productIds: ["private"] };
	return {
		settings: { get: async (key: string) => settings[key] ?? null },
		storage: {
			restrictions: { get: async () => rule },
			taxonomy_restrictions: { get: async () => ({ taxonomyName: "tag", termId: "premium", policy: taxonomyPolicy, agentPrice: "$0.05" }) },
		},
		taxonomies: { getEntryTerms: async () => taxonomyPolicy ? [{ taxonomy: "tag", id: "premium" }] : [] },
		log: { error: vi.fn() },
	};
}
function route(name: string) {
	const entry = plugin.routes![name];
	if (typeof entry === "function") throw new Error("Routes must declare methods");
	return entry;
}
const page = { kind: "content" as const, url: "https://site.test/blog/post/", path: "/blog/post/", locale: null, pageType: "post", title: null, description: null, canonical: null, image: null, content: { collection: "posts", id: "1", slug: "post" } };
async function metadata(ctx: object, value = page) {
	const hook = plugin.hooks!["page:metadata"]!;
	return (typeof hook === "function" ? hook : hook.handler)({ page: value }, ctx as PluginContext);
}

describe("standard plugin companion seams", () => {
	it("declares portable methods and keeps companion routes private", () => {
		for (const name of Object.keys(plugin.routes!)) expect(route(name).methods?.length).toBeGreaterThan(0);
		for (const name of ["access", "auth/session", "auth/logout", "portal", "auth/verify", "checkout/complete", "checkout", "auth/send-link"]) {
			expect(route(name)).toMatchObject({ methods: ["POST"], public: true });
		}
		for (const name of ["agent/context", "receipts/record", "admin/settings", "admin", "editor/paid-access", "coexistence/report"]) expect(route(name).public).not.toBe(true);
	});
	it("returns private context including unioned rules and the highest price", async () => {
		const ctx = context({ agentsMode: "paid", agentsNetwork: "eip155:84532" }, "agents-pay", "members-only");
		await expect(invoke(route("agent/context").handler, { ...ctx, input: { collection: "posts", contentId: "1", slug: "post" } })).resolves.toEqual({
			canonicalUrl: null,
			rules: [{ policy: "agents-pay", agentPrice: "$0.01" }, { policy: "agents-pay", agentPrice: "$0.01" }, { policy: "members-only", agentPrice: "$0.05" }],
			agents: { mode: "paid", rail: "origin-x402", payTo: "", network: "eip155:84532", edgeTrust: "none", freeByDefault: false }, price: "$0.05",
		});
		await expect(invoke(route("agent/context").handler, { ...ctx, input: {} })).resolves.toMatchObject({ ok: false, error: { code: "BAD_REQUEST" } });
		await expect(invoke(route("agent/context").handler, { ...ctx, input: { collection: "posts", contentId: "1" }, taxonomies: { getEntryTerms: async () => { throw Error("unavailable"); } } })).resolves.toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
	});
	it("records only valid receipts and uses compare-and-set for concurrent duplicates", async () => {
		const records = new Map<string, unknown>();
		const compareAndSet = vi.fn(async (key: string, revision: null, value: unknown) => {
			expect(revision).toBeNull();
			if (records.has(key)) return { applied: false };
			records.set(key, value); return { applied: true, revision: "1" };
		});
		const receipt = { entryId: "1", collectionSlug: "posts", slug: "post", rail: "origin-x402", payer: `0x${"1".repeat(40)}`, amount: "$0.01", network: "eip155:84532", transaction: `0x${"2".repeat(64)}`, createdAt: "2026-09-29T12:00:00.000Z" };
		const ctx = { input: receipt, storage: { receipts: { compareAndSet } } };
		expect(await Promise.all([invoke(route("receipts/record").handler, ctx), invoke(route("receipts/record").handler, ctx)])).toEqual([{ ok: true }, { ok: true, duplicate: true }]);
		expect(records.get(`receipt:${receipt.transaction}`)).toEqual(receipt);
		for (const invalid of [{}, { ...receipt, amount: "-1" }, { ...receipt, transaction: "bad" }, { ...receipt, payer: "bad" }, { ...receipt, createdAt: "bad" }, { ...receipt, rail: "other" }, { ...receipt, network: "eip155:1" }]) {
			await expect(invoke(route("receipts/record").handler, { ...ctx, input: invalid })).resolves.toMatchObject({ ok: false, error: { code: "BAD_REQUEST" } });
		}
		expect(compareAndSet).toHaveBeenCalledTimes(2);
	});
	it("exposes only plan display fields in Stripe mode", async () => {
		const ctx = context({ humansMode: "stripe", humansPlans: MASONJAMES_PLANS, stripeSecretKey: "sk_test_private" });
		const result = await invoke(route("plans").handler, ctx);
		expect(result).toEqual({ plans: MASONJAMES_PLANS.map(({ slug, name, description, monthlyLabel, yearlyLabel, trialLabel }) => ({ slug, name, description, monthlyLabel, yearlyLabel, trialLabel })) });
		expect(JSON.stringify(result)).not.toMatch(/stripe|visibility|productId|sk_test/i);
		for (const humansMode of ["off", "delegate"]) await expect(invoke(route("plans").handler, context({ humansMode }))).resolves.toMatchObject({ error: { code: "MODULE_DISABLED" } });
	});
	it("keeps the widget available with modules off", async () => {
		await expect(invoke(route("admin").handler, { ...context(), input: { type: "page_load", page: "widget:overview" } })).resolves.toMatchObject({ blocks: [{ type: "empty", title: "Paid Access is off" }] });
	});
});

describe("discovery metadata", () => {
	it("advertises Markdown and marks member content as paywalled", async () => {
		expect(await metadata(context({ agentsMode: "paid", agentRoutePrefix: "/read" }))).toEqual([
			{ kind: "link", rel: "alternate", href: "https://site.test/read/posts/post.md" },
			{ kind: "jsonld", id: "paid-access:paywall", graph: { "@context": "https://schema.org", "@type": "WebPage", "@id": page.url, isAccessibleForFree: false, hasPart: { "@type": "WebPageElement", isAccessibleForFree: false, cssSelector: ".phb-locked" } } },
		]);
	});
	it("suppresses links for members-only taxonomy rules and agents off", async () => {
		for (const ctx of [context({ agentsMode: "paid" }, "agents-pay", "members-only"), context()]) {
			const result = await metadata(ctx);
			expect(result).toHaveLength(1); expect(result).toMatchObject([{ kind: "jsonld" }]);
		}
	});
	it("supports tokens-only discovery without marking agent-only content as member locked", async () => {
		expect(await metadata(context({ agentsMode: "tokens-only" }, "agents-pay"))).toEqual([{ kind: "link", rel: "alternate", href: "https://site.test/agents/posts/post.md" }]);
	});
	it("returns null for non-content, no rules, no contributions, and errors", async () => {
		const ctx = context({}, "public");
		expect(await metadata(ctx)).toBeNull();
		expect(await metadata(ctx, { ...page, kind: "custom" } as typeof page)).toBeNull();
		expect(await metadata({ ...ctx, storage: { ...ctx.storage, restrictions: { get: async () => null } } })).toBeNull();
		expect(await metadata({ ...ctx, settings: { get: async () => { throw Error("unavailable"); } } })).toBeNull();
		expect(ctx.log.error).toHaveBeenCalledOnce();
	});
});

it("resolves canonical URLs with a null fallback and suppresses coexisting plans", async () => {
	const ctx = context({ agentsMode: "paid", humansMode: "stripe", humansPlans: MASONJAMES_PLANS });
	const getPublicUrl = vi.fn(async () => "https://site.test/blog/post/");
	const input = { collection: "posts", contentId: "1", slug: "post" };
	expect(await invoke(route("agent/context").handler, { ...ctx, input, content: { getPublicUrl } })).toMatchObject({ canonicalUrl: "https://site.test/blog/post/" });
	expect(getPublicUrl).toHaveBeenCalledWith("posts", "1");
	getPublicUrl.mockRejectedValueOnce(new Error("unavailable"));
	expect(await invoke(route("agent/context").handler, { ...ctx, input, content: { getPublicUrl } })).toMatchObject({ canonicalUrl: null });
	expect(await invoke(route("plans").handler, { ...ctx, kv: { get: async () => true } })).toEqual({ plans: [] });
});
