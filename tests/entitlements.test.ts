// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { expect, it, vi } from "vitest";

import { memberEntitlementsHandler } from "../src/handlers/entitlements.js";
import { StripeClient } from "../src/stripe.js";
import { invoke } from "./fixtures/route.js";

const PLANS = [
	{ slug: "free", name: "Free", stripeProductId: null, grantsVisibility: [] },
	{ slug: "plus", name: "Plus", stripeProductId: "prod_plus", grantsVisibility: [] },
	{ slug: "pro", name: "Pro", stripeProductId: "prod_pro", grantsVisibility: [] },
	{ slug: "team", name: "Team", stripeProductId: "prod_team", grantsVisibility: [] },
];
const subscription = (product: string, status = "active") => ({ status, items: { data: [{ price: { product } }] } });
const invoice = (product: string, extra: Record<string, unknown> = {}) => ({ subscription: null, ...extra, lines: { data: [{ price: { product } }] } });

// Stripe answers per customer and records every request, so tests can count passes.
function stripeFake(owned: Record<string, { subscriptions?: unknown[]; invoices?: unknown[] }>, customers: string[] = [], fail?: string) {
	const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
		if (fail && url.includes(fail)) return Response.json({ error: { message: "Stripe is unavailable." } }, { status: 500 });
		const { pathname, searchParams } = new URL(url);
		if (pathname === "/v1/customers") return Response.json({ data: customers.map(id => ({ id })) });
		const customer = owned[searchParams.get("customer") ?? ""] ?? {};
		return Response.json({ data: (pathname === "/v1/subscriptions" ? customer.subscriptions : customer.invoices) ?? [] });
	});
	const paths = () => fetch.mock.calls.map(([url]) => {
		const { pathname, searchParams } = new URL(url);
		return `${pathname.slice(4)} ${searchParams.get("customer") ?? searchParams.get("email")}`;
	});
	return { fetch, paths };
}

function context(options: { mode?: string; sessionToken?: string | null; stripeSecretKey?: string | null; localCustomer?: string | null; legacyPresent?: boolean; fetch?: typeof fetch } = {}) {
	const { mode = "stripe", sessionToken = "member-session", stripeSecretKey = "sk_test_fake", localCustomer = "cus_local", legacyPresent = false } = options;
	const settings: Record<string, unknown> = { humansMode: mode, humansPlans: PLANS, stripeSecretKey };
	const sessions = { get: vi.fn(async () => ({ email: "member@example.com", expiresAt: "2999-01-01T00:00:00.000Z", createdAt: "2026-10-10T00:00:00.000Z" })), delete: vi.fn() };
	const customers = {
		get: vi.fn(async () => localCustomer ? { stripeCustomerId: localCustomer, createdAt: "2026-10-10T00:00:00.000Z" } : null),
		query: vi.fn(async () => ({ items: [] })), put: vi.fn(),
	};
	const fetchFn = options.fetch ?? vi.fn();
	return { sessions, customers, fetch: fetchFn, ctx: {
		input: { sessionToken }, request: new Request("https://site.test/entitlements", { method: "POST" }),
		settings: { get: async (key: string) => settings[key] ?? null },
		kv: { get: async (key: string) => key === "state:legacyPluginPresent" ? legacyPresent : null },
		storage: { sessions, customers }, http: { fetch: fetchFn }, log: { warn: vi.fn(), error: vi.fn() },
	} };
}

it("returns owned plan slugs with one Stripe pass per customer", async () => {
	const stripe = stripeFake({ cus_local: { subscriptions: [subscription("prod_plus")] }, cus_other: { invoices: [invoice("prod_pro")] } }, ["cus_local", "cus_other"]);
	const { ctx, customers } = context({ fetch: stripe.fetch });
	await expect(invoke(memberEntitlementsHandler, ctx)).resolves.toEqual({ ok: true, humanMode: "stripe", authenticated: true, planSlugs: ["plus", "pro"] });
	expect(stripe.paths()).toEqual(["subscriptions cus_local", "invoices cus_local", "customers member@example.com", "subscriptions cus_other", "invoices cus_other"]);
	expect(customers.put).not.toHaveBeenCalled();
});

it("skips the email search when the stored customer owns every configured product", async () => {
	const all = stripeFake({ cus_local: { subscriptions: [subscription("prod_plus"), subscription("prod_pro")], invoices: [invoice("prod_team")] } }, ["cus_other"]);
	await expect(invoke(memberEntitlementsHandler, context({ fetch: all.fetch }).ctx)).resolves.toEqual({ ok: true, humanMode: "stripe", authenticated: true, planSlugs: ["plus", "pro", "team"] });
	expect(all.paths()).toEqual(["subscriptions cus_local", "invoices cus_local"]);
});

it("treats a Stripe list without a data array as malformed, not empty", async () => {
	for (const malformed of ["/v1/subscriptions", "/v1/invoices"]) {
		const fetch = vi.fn(async (url: string, _init?: RequestInit) => Response.json(new URL(url).pathname === malformed ? {} : { data: [] }));
		await expect(new StripeClient("sk_test_fake", fetch).customerProducts("cus_local")).rejects.toThrow("malformed");
		await expect(invoke(memberEntitlementsHandler, context({ fetch }).ctx)).resolves.toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
	}
});

it("reads every owned product instead of stopping at the first match", async () => {
	const stripe = stripeFake({ cus_local: {
		subscriptions: [subscription("prod_plus"), subscription("prod_team", "canceled"), subscription("prod_pro", "trialing")],
		invoices: [invoice("prod_free_standing"), invoice("prod_team", { subscription: "sub_1" }), invoice("prod_team", { metadata: { phbIgnore: "1" } })],
	} });
	const client = new StripeClient("sk_test_fake", stripe.fetch);
	expect(await client.customerProducts("cus_local")).toEqual(new Set(["prod_plus", "prod_pro", "prod_free_standing"]));
	expect(stripe.paths()).toEqual(["subscriptions cus_local", "invoices cus_local"]);
	expect(stripe.fetch.mock.calls.map(([url]) => new URL(url).searchParams.get("limit"))).toEqual(["100", "100"]);
	// customerHasProduct makes the same requests but stops at its first match.
	stripe.fetch.mockClear();
	expect(await client.customerHasProduct("cus_local", ["prod_plus"])).toBe(true);
	expect(stripe.paths()).toEqual(["subscriptions cus_local"]);
	expect(await client.customerHasProduct("cus_local", ["prod_free_standing"])).toBe(true);
	expect(await client.customerHasProduct("cus_local", ["prod_team"])).toBe(false);
	expect(await client.customerProducts("")).toEqual(new Set());
});

it("returns no plans without a Stripe key or session", async () => {
	const anonymous = context({ sessionToken: null });
	await expect(invoke(memberEntitlementsHandler, anonymous.ctx)).resolves.toEqual({ ok: true, humanMode: "stripe", authenticated: false, planSlugs: [] });
	expect(anonymous.sessions.get).not.toHaveBeenCalled();
	const keyless = context({ stripeSecretKey: null });
	await expect(invoke(memberEntitlementsHandler, keyless.ctx)).resolves.toEqual({ ok: true, humanMode: "stripe", authenticated: true, planSlugs: [] });
	expect(anonymous.fetch).not.toHaveBeenCalled();
	expect(keyless.fetch).not.toHaveBeenCalled();
});

it("reports the human mode without reading the session or calling Stripe outside stripe mode", async () => {
	for (const mode of ["off", "delegate"]) {
		const { ctx, sessions, fetch } = context({ mode });
		await expect(invoke(memberEntitlementsHandler, ctx)).resolves.toEqual({ ok: true, humanMode: mode, authenticated: false, planSlugs: [] });
		expect(sessions.get).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	}
});

it("treats forced stripe as delegate when the legacy plugin is reported present", async () => {
	const { ctx, sessions, fetch } = context({ legacyPresent: true });
	await expect(invoke(memberEntitlementsHandler, ctx)).resolves.toEqual({ ok: true, humanMode: "delegate", authenticated: false, planSlugs: [] });
	expect(sessions.get).not.toHaveBeenCalled();
	expect(fetch).not.toHaveBeenCalled();
});

it("is not ok when Stripe fails", async () => {
	const search = stripeFake({}, [], "/v1/customers");
	const searchFailed = await invoke(memberEntitlementsHandler, context({ localCustomer: null, fetch: search.fetch }).ctx);
	expect(searchFailed).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
	expect(searchFailed).not.toHaveProperty("planSlugs");
	const pass = stripeFake({ cus_local: { subscriptions: [subscription("prod_plus")] } }, ["cus_other"], "invoices?customer=cus_other");
	await expect(invoke(memberEntitlementsHandler, context({ fetch: pass.fetch }).ctx)).resolves.toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
	// A failed check of the stored customer is not swallowed: the route fails closed without searching.
	const stored = stripeFake({ cus_other: { subscriptions: [subscription("prod_pro")] } }, ["cus_other"], "customer=cus_local");
	await expect(invoke(memberEntitlementsHandler, context({ fetch: stored.fetch }).ctx)).resolves.toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
	expect(stored.paths()).toEqual(["subscriptions cus_local"]);
});
