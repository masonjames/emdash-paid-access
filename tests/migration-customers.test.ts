// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { createHash } from "node:crypto";
import type { PluginContext } from "emdash/plugin";
import { expect, it, vi } from "vitest";
import { ForeignMigratedCustomerError, findOrCreateCustomerRecord, getCustomerRecordByEmail, upsertCustomerRecord, verifyCustomerAssociation } from "../src/customers.js";
import { accessHandler } from "../src/handlers/access.js";
import { checkoutCompleteHandler, checkoutHandler } from "../src/handlers/checkout.js";
import { memberEntitlementsHandler } from "../src/handlers/entitlements.js";
import { portalHandler } from "../src/handlers/portal.js";
import { loadSettings } from "../src/handlers/settings.js";
import { StripeClient } from "../src/stripe.js";
import { invoke } from "./fixtures/route.js";

const EMAIL = "member@example.invalid";
const KEY = "sk_test_synthetic_migration_only";
const BINDING = { version: 1, accountId: "acct_fixture", environment: "test", sourceSha256: "a".repeat(64), credentialSha256: createHash("sha256").update(KEY).digest("hex") };
const RECORD = { email: EMAIL, stripeCustomerId: "cus_reviewed", migrationBinding: BINDING, createdAt: "2026-10-15", updatedAt: "2026-10-15" };

function context(options: { record?: Record<string, unknown>; settings?: Record<string, unknown>; customer?: unknown; products?: string[]; failCustomer?: boolean; checkoutCustomer?: string | null; queryOnly?: boolean; lookupEmail?: string; registry?: unknown; missingRecord?: boolean } = {}) {
	const lookupEmail = options.lookupEmail ?? EMAIL;
	const record = options.record ?? structuredClone(RECORD);
	const settings: Record<string, unknown> = { humansMode: "stripe", stripeSecretKey: KEY, stripeAccountId: "acct_fixture", stripeEnvironment: "test", humansPlans: [
		{ slug: "plus", name: "Plus", stripeProductId: "prod_plus", grantsVisibility: [] },
		{ slug: "pro", name: "Pro", stripeProductId: "prod_pro", grantsVisibility: [] },
	], ...options.settings };
	const calls: string[] = [];
	const fetch = vi.fn(async (url: string, init?: RequestInit) => {
		const parsed = new URL(url);
		calls.push(`${init?.method ?? "GET"} ${parsed.pathname}`);
		if (parsed.pathname === "/v1/customers" && options.lookupEmail) return Response.json({ data: [{ id: "cus_reviewed" }] });
		if (parsed.pathname === "/v1/customers/cus_reviewed") return Response.json(options.failCustomer ? { error: { message: "unavailable" } } : options.customer ?? { id: "cus_reviewed", email: EMAIL, livemode: false }, { status: options.failCustomer ? 500 : 200 });
		if (parsed.pathname === "/v1/checkout/sessions/cs_complete") return Response.json({ id: "cs_complete", status: "complete", payment_status: "paid", customer: options.checkoutCustomer === undefined ? "cus_reviewed" : options.checkoutCustomer, customer_details: { email: lookupEmail } });
		if (parsed.pathname === "/v1/subscriptions") {
			expect(parsed.searchParams.get("customer")).toBe("cus_reviewed");
			return Response.json({ data: (options.products ?? ["prod_plus"]).map(product => ({ status: "active", items: { data: [{ price: { product } }] } })) });
		}
		if (parsed.pathname === "/v1/invoices") return Response.json({ data: [] });
		if (parsed.pathname === "/v1/prices/price_plus") return Response.json({ id: "price_plus", type: "recurring" });
		if (parsed.pathname === "/v1/prices") return Response.json({ data: [{ id: "price_plus", active: true, type: "recurring", recurring: { interval: "month", interval_count: 1 } }] });
		if (["/v1/billing_portal/sessions", "/v1/checkout/sessions"].includes(parsed.pathname)) {
			expect(new URLSearchParams(String(init?.body)).get("customer")).toBe("cus_reviewed");
			return Response.json({ id: "cs_new", url: "https://stripe.invalid/session" });
		}
		throw new Error(`Forbidden provider path ${parsed.pathname}`); // Email search/create must never occur.
	});
	const customers = { get: vi.fn(async () => options.queryOnly || options.lookupEmail || options.missingRecord ? null : { data: record }), query: vi.fn(async (query: { where?: Record<string, unknown> }) => ({ items: !options.missingRecord && Object.entries(query.where ?? {}).every(([key, value]) => record[key] === value) ? [{ data: record }] : [] })), put: vi.fn() };
	const email = { send: vi.fn() };
	const ctx = {
		input: { collectionSlug: "posts", contentId: "one", sessionToken: "synthetic-session", planSlug: "plus", billingInterval: "monthly", email: lookupEmail, sessionId: "cs_complete" },
		request: new Request("https://site.invalid/"),
		settings: { get: async (name: string) => settings[name] ?? null },
		kv: { get: async (name: string) => name === "migration:customer-bindings:v1" ? (options.registry === undefined ? { version: 1, members: { [EMAIL]: { stripeCustomerId: RECORD.stripeCustomerId, migrationBinding: BINDING } } } : options.registry) : null },
		storage: { customers, sessions: { get: async () => ({ email: lookupEmail, expiresAt: "2999-01-01T00:00:00Z" }) },
			restrictions: { get: async () => ({ contentId: "one", collectionSlug: "posts", policy: "members", requiredPlanSlugs: ["plus"] }) },
			taxonomy_restrictions: { query: async () => ({ items: [] }) },
			auth_tokens: { query: async () => ({ items: [] }), put: vi.fn() },
		},
		email, site: { name: "Synthetic" }, http: { fetch }, log: { error: vi.fn(), warn: vi.fn() }, url: (path: string) => `https://site.invalid${path}`,
	};
	return { ctx, calls, customers, email, record, plugin: ctx as unknown as PluginContext };
}

const routes = [accessHandler, memberEntitlementsHandler, portalHandler, checkoutHandler];
const badSettings = [{ stripeAccountId: "acct_changed" }, { stripeEnvironment: "live" }, { stripeSecretKey: "sk_test_rotated" }];
for (const route of routes) {
	it.each(badSettings)(`${route.name} refuses configuration drift before any provider call: %j`, async settings => {
		const f = context({ settings });
		const result = await invoke(route, f.ctx);
		expect(result).toMatchObject(route === accessHandler ? { hasAccess: false } : { ok: false });
		expect(f.calls).toEqual([]);
		expect(f.customers.put).not.toHaveBeenCalled();
		expect(f.email.send).not.toHaveBeenCalled();
	});
	it.each([null, {}, { ...BINDING, version: 2 }, { ...BINDING, environment: "sandbox" }, { ...BINDING, sourceSha256: "bad" }])(`${route.name} never downgrades malformed bindings: %j`, async migrationBinding => {
		const f = context({ record: { ...RECORD, migrationBinding } });
		expect(await invoke(route, f.ctx)).toMatchObject(route === accessHandler ? { hasAccess: false } : { ok: false });
		expect(f.calls).toEqual([]);
		expect(f.customers.put).not.toHaveBeenCalled();
	});
	it.each([
		{ id: "cus_other", email: EMAIL, livemode: false },
		{ id: "cus_reviewed", email: EMAIL, livemode: false, deleted: true },
		{ id: "cus_reviewed", email: "other@example.invalid", livemode: false },
		{ id: "cus_reviewed", email: EMAIL, livemode: true },
		{ id: "cus_reviewed", email: EMAIL },
	])(`${route.name} refuses mismatched exact-customer evidence: %j`, async customer => {
		const f = context({ customer });
		expect(await invoke(route, f.ctx)).toMatchObject(route === accessHandler ? { hasAccess: false } : { ok: false });
		expect(f.calls).toEqual(["GET /v1/customers/cus_reviewed"]);
		expect(f.customers.put).not.toHaveBeenCalled();
	});
}

it("allows only the reviewed customer and retains partial entitlements without email search", async () => {
	const f = context();
	expect(await invoke(accessHandler, f.ctx)).toMatchObject({ authenticated: true, hasAccess: true });
	expect(await invoke(memberEntitlementsHandler, f.ctx)).toMatchObject({ planSlugs: ["plus"] });
	expect(f.customers.put).not.toHaveBeenCalled();
});

it("denies a canceled customer's access without finding another account with the same email", async () => {
	const f = context({ products: [] });
	expect(await invoke(accessHandler, f.ctx)).toMatchObject({ hasAccess: false });
	expect(await invoke(memberEntitlementsHandler, f.ctx)).toMatchObject({ planSlugs: [] });
	expect(f.calls.every(path => !path.endsWith("/customers"))).toBe(true);
});

it("never falls back after an exact-customer provider failure", async () => {
	for (const route of routes) {
		const f = context({ failCustomer: true });
		expect(await invoke(route, f.ctx)).toMatchObject(route === accessHandler ? { hasAccess: false } : { ok: false });
		expect(f.calls).toEqual(["GET /v1/customers/cus_reviewed"]);
	}
});

it("creates checkout and portal sessions only after exact-customer verification", async () => {
	for (const route of [checkoutHandler, portalHandler]) {
		const f = context();
		expect(await invoke(route, f.ctx)).toMatchObject({ ok: true });
		expect(f.calls[0]).toBe("GET /v1/customers/cus_reviewed");
		expect(f.calls.at(-1)).toBe(route === checkoutHandler ? "POST /v1/checkout/sessions" : "POST /v1/billing_portal/sessions");
		expect(f.customers.put).not.toHaveBeenCalled();
	}
});

it.each(["cus_other", null])("completion cannot overwrite the imported association with %j or send mail", async checkoutCustomer => {
	const f = context({ checkoutCustomer });
	expect(await invoke(checkoutCompleteHandler, f.ctx)).toMatchObject({ ok: false });
	expect(f.calls).toEqual(["GET /v1/checkout/sessions/cs_complete"]);
	expect(f.customers.put).not.toHaveBeenCalled();
	expect(f.email.send).not.toHaveBeenCalled();
});

it.each(badSettings)("completion's discovery GET is read-only; configuration drift blocks everything afterward: %j", async settings => {
	const f = context({ settings });
	expect(await invoke(checkoutCompleteHandler, f.ctx)).toMatchObject({ ok: false });
	expect(f.calls).toEqual(["GET /v1/checkout/sessions/cs_complete"]);
	expect(f.customers.put).not.toHaveBeenCalled();
	expect(f.email.send).not.toHaveBeenCalled();
});

it("completion preserves the binding after matching provider identity and sends only the normal magic link", async () => {
	const f = context();
	expect(await invoke(checkoutCompleteHandler, f.ctx)).toMatchObject({ ok: true });
	expect(f.calls).toEqual(["GET /v1/checkout/sessions/cs_complete", "GET /v1/customers/cus_reviewed"]);
	expect(f.customers.put).not.toHaveBeenCalled();
	expect(f.email.send).toHaveBeenCalledTimes(1);
});

it("preserves bindings through indexed reads and idempotent upsert, rejecting replacement", async () => {
	for (const queryOnly of [false, true]) {
		const f = context({ queryOnly });
		expect(await getCustomerRecordByEmail(f.plugin, EMAIL)).toEqual(RECORD);
		expect(await upsertCustomerRecord(f.plugin, EMAIL, "cus_reviewed")).toEqual(RECORD);
		await expect(upsertCustomerRecord(f.plugin, EMAIL, "cus_other")).rejects.toThrow("cannot be replaced");
		expect(f.customers.put).not.toHaveBeenCalled();
	}
});

it("does not normalize a mismatching stored migrated email into an accepted identity", async () => {
	const f = context({ record: { ...RECORD, email: "other@example.invalid" } });
	expect(await invoke(accessHandler, f.ctx)).toMatchObject({ hasAccess: false });
	expect(f.calls).toEqual([]);
});

it("find-or-create never creates or searches for a migrated record, even without caller settings", async () => {
	const f = context();
	const stripe = new StripeClient(KEY, f.ctx.http.fetch);
	await expect(findOrCreateCustomerRecord(f.plugin, stripe, EMAIL)).rejects.toThrow("configuration");
	expect(f.calls).toEqual([]);
	expect(await findOrCreateCustomerRecord(f.plugin, stripe, EMAIL, await loadSettings(f.plugin))).toMatchObject({ migrationBinding: BINDING });
	expect(f.calls).toEqual(["GET /v1/customers/cus_reviewed"]);
	const malformed = context({ record: { ...RECORD, migrationBinding: null } });
	await expect(upsertCustomerRecord(malformed.plugin, EMAIL, "cus_reviewed")).rejects.toThrow();
	expect(malformed.customers.put).not.toHaveBeenCalled();
});

for (const route of [...routes, checkoutCompleteHandler]) {
	it(`${route.name} cannot rebind a migrated customer through a different email`, async () => {
		const f = context({ lookupEmail: "changed@example.invalid" });
		const result = await invoke(route, f.ctx);
		expect(result).toMatchObject(route === accessHandler ? { hasAccess: false } : route === memberEntitlementsHandler ? { ok: true, planSlugs: [] } : { ok: false });
		expect(f.calls.every(call => call.startsWith("GET "))).toBe(true);
		expect(f.calls).not.toContain("GET /v1/customers/cus_reviewed");
		expect(f.calls).not.toContain("GET /v1/subscriptions");
		expect(f.customers.put).not.toHaveBeenCalled();
		expect(f.email.send).not.toHaveBeenCalled();
	});
}

it("upsert rejects a new email alias for a migrated customer before querying or writing", async () => {
	const f = context({ lookupEmail: "changed@example.invalid" });
	await expect(upsertCustomerRecord(f.plugin, "changed@example.invalid", "cus_reviewed")).rejects.toThrow();
	expect(f.customers.query).not.toHaveBeenCalled();
	expect(f.customers.put).not.toHaveBeenCalled();
});

for (const route of routes) {
	it.each([
		{ missingRecord: true },
		{ record: { email: EMAIL, stripeCustomerId: "cus_reviewed", createdAt: "2026-10-15" } },
		{ registry: null },
		{ registry: { version: 1, members: {} } },
		{ registry: { version: 1, members: {}, unexpected: true } },
		{ registry: { version: 1, members: { [EMAIL]: { stripeCustomerId: "cus_other", migrationBinding: BINDING } } } },
	])(`${route.name} refuses missing or altered registry/customer parity: %j`, async options => {
		const f = context(options);
		expect(await invoke(route, f.ctx)).toMatchObject(route === accessHandler ? { hasAccess: false } : { ok: false });
		expect(f.calls).toEqual([]);
		expect(f.customers.put).not.toHaveBeenCalled();
		expect(f.email.send).not.toHaveBeenCalled();
	});
}

it("a retained registry prevents upsert or find-or-create from repairing a deleted customer row", async () => {
	const f = context({ missingRecord: true });
	await expect(upsertCustomerRecord(f.plugin, EMAIL, "cus_reviewed")).rejects.toThrow("registry");
	await expect(findOrCreateCustomerRecord(f.plugin, new StripeClient(KEY, f.ctx.http.fetch), EMAIL, await loadSettings(f.plugin))).rejects.toThrow("registry");
	expect(f.calls).toEqual([]);
	expect(f.customers.put).not.toHaveBeenCalled();
});

it.each([{ missingRecord: true }, { record: { email: EMAIL, stripeCustomerId: "cus_reviewed", createdAt: "2026-10-15" } }, { registry: null }])("completion does not repair missing migration evidence after session discovery: %j", async options => {
	const f = context(options);
	expect(await invoke(checkoutCompleteHandler, f.ctx)).toMatchObject({ ok: false });
	expect(f.calls).toEqual(["GET /v1/checkout/sessions/cs_complete"]);
	expect(f.customers.put).not.toHaveBeenCalled();
	expect(f.email.send).not.toHaveBeenCalled();
});

it.each([
	{ version: 2, members: {} },
	{ version: 1, members: { [EMAIL]: { stripeCustomerId: "cus_reviewed", migrationBinding: BINDING }, "duplicate@example.invalid": { stripeCustomerId: "cus_reviewed", migrationBinding: BINDING } } },
	{ version: 1, members: { "Member@example.invalid": { stripeCustomerId: "cus_reviewed", migrationBinding: BINDING } } },
	{ version: 1, members: Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`member${index}@example.invalid`, { stripeCustomerId: `cus_${index}`, migrationBinding: BINDING }])) },
])("rejects invalid migration registry without provider reads", async registry => {
	const f = context({ registry });
	expect(await invoke(accessHandler, f.ctx)).toMatchObject({ hasAccess: false });
	expect(f.calls).toEqual([]);
});

const LEGACY_ACCOUNT = "AbCdEf0123456789AbCdEf0123456789";
function accountContext(accountId: string, configuredAccount = accountId) {
	const migrationBinding = { ...BINDING, accountId };
	return context({
		record: { ...RECORD, migrationBinding },
		registry: { version: 1, members: { [EMAIL]: { stripeCustomerId: RECORD.stripeCustomerId, migrationBinding } } },
		settings: { stripeAccountId: configuredAccount },
	});
}

it("accepts a verified legacy 32-character account identifier without weakening identity checks", async () => {
	const f = accountContext(LEGACY_ACCOUNT);
	expect(await invoke(accessHandler, f.ctx)).toMatchObject({ hasAccess: true });
	expect(f.calls).toEqual(["GET /v1/customers/cus_reviewed", "GET /v1/subscriptions"]);
	expect(f.customers.put).not.toHaveBeenCalled();
});

it("requires exact legacy account equality before requesting the bound customer", async () => {
	const f = accountContext(LEGACY_ACCOUNT, "ZbCdEf0123456789AbCdEf0123456789");
	expect(await invoke(accessHandler, f.ctx)).toMatchObject({ hasAccess: false });
	expect(f.calls).toEqual([]);
});

it.each(["", "acct_", "acct_has space", "acct_has\ncontrol", "https://stripe.invalid/account", "a".repeat(31), "a".repeat(33), "acct_has-hyphen", "acct_fixture\n", "acct_fixture\r\n", `${LEGACY_ACCOUNT}\n`, `acct_${"a".repeat(256)}`])("rejects malformed migrated account identifiers: %j", async accountId => {
	const f = accountContext(accountId);
	expect(await invoke(accessHandler, f.ctx)).toMatchObject({ hasAccess: false });
	expect(f.calls).toEqual([]);
});

it("rejects trailing-newline customer IDs and source digests before provider calls", async () => {
	for (const entry of [
		{ stripeCustomerId: "cus_reviewed\n", migrationBinding: BINDING },
		{ stripeCustomerId: "cus_reviewed", migrationBinding: { ...BINDING, sourceSha256: `${BINDING.sourceSha256}\n` } },
	]) {
		const f = context({ record: { ...RECORD, ...entry }, registry: { version: 1, members: { [EMAIL]: entry } } });
		expect(await invoke(accessHandler, f.ctx)).toMatchObject({ hasAccess: false });
		expect(f.calls).toEqual([]);
	}
});

it("normalizes historical native sandbox settings to test before checking a migrated binding", async () => {
	const f = context({ settings: { stripeEnvironment: "sandbox" } });
	expect(await invoke(accessHandler, f.ctx)).toMatchObject({ hasAccess: true });
	expect(f.calls).toEqual(["GET /v1/customers/cus_reviewed", "GET /v1/subscriptions"]);
});

for (const route of routes) {
	it(`${route.name} denies a host without the required KV interface before provider calls`, async () => {
		const f = context({ lookupEmail: "ordinary@example.invalid" });
		const { kv: _kv, ...withoutKv } = f.ctx;
		expect(await invoke(route, withoutKv)).toMatchObject(route === accessHandler ? { hasAccess: false } : { ok: false });
		expect(f.calls).toEqual([]);
		expect(f.customers.put).not.toHaveBeenCalled();
	});
}

function mixedSearch(options: { foreign?: boolean; failed?: boolean; settings?: Record<string, unknown>; registry?: unknown } = {}) {
	const f = context({ lookupEmail: "ordinary@example.invalid", settings: options.settings, registry: options.registry });
	f.ctx.http.fetch = vi.fn(async (url: string, init?: RequestInit) => {
		const parsed = new URL(url);
		f.calls.push(`${init?.method ?? "GET"} ${parsed.pathname} ${parsed.searchParams.get("customer") ?? ""}`.trim());
		if (parsed.pathname === "/v1/customers") return Response.json({ data: [{ id: options.foreign ? "cus_reviewed" : "cus_empty" }, { id: "cus_ordinary" }] });
		if (options.failed && parsed.searchParams.get("customer") === "cus_ordinary") return Response.json({ error: { message: "provider unavailable" } }, { status: 500 });
		if (parsed.pathname === "/v1/subscriptions") return Response.json({ data: parsed.searchParams.get("customer") === "cus_ordinary" ? [{ status: "active", items: { data: [{ price: { product: "prod_plus" } }] } }] : [] });
		if (parsed.pathname === "/v1/invoices") return Response.json({ data: [] });
		throw new Error("Unexpected provider request");
	});
	return f;
}

for (const route of [accessHandler, memberEntitlementsHandler]) {
	it.each([false, true])(`${route.name} preserves an ordinary member's second email-search match (foreign first: %j)`, async foreign => {
		const f = mixedSearch({ foreign });
		expect(await invoke(route, f.ctx)).toMatchObject(route === accessHandler ? { hasAccess: true } : { ok: true, planSlugs: ["plus"] });
		expect(f.calls.some(call => call.includes("cus_reviewed"))).toBe(false);
		expect(f.calls).toContain("GET /v1/subscriptions cus_ordinary");
		if (route === accessHandler) expect(f.customers.put).toHaveBeenCalledWith("ordinary@example.invalid", expect.objectContaining({ stripeCustomerId: "cus_ordinary" }));
		else expect(f.customers.put).not.toHaveBeenCalled();
	});
	it(`${route.name} does not suppress provider failure after skipping a foreign migrated identity`, async () => {
		const f = mixedSearch({ foreign: true, failed: true });
		expect(await invoke(route, f.ctx)).toMatchObject(route === accessHandler ? { hasAccess: false } : { ok: false });
		expect(f.customers.put).not.toHaveBeenCalled();
	});
	it.each([{ stripeSecretKey: "sk_test_rotated" }, { stripeAccountId: "acct_changed" }, { stripeEnvironment: "live" }])(`${route.name} cannot skip a foreign migration configuration failure: %j`, async settings => {
		const f = mixedSearch({ foreign: true, settings });
		expect(await invoke(route, f.ctx)).toMatchObject(route === accessHandler ? { hasAccess: false } : { ok: false });
		expect(f.calls).toEqual(["GET /v1/customers"]);
		expect(f.customers.put).not.toHaveBeenCalled();
	});
	it(`${route.name} does not suppress malformed registry failures in ordinary email search`, async () => {
		const f = mixedSearch({ foreign: true, registry: { version: 1, members: { [EMAIL]: { stripeCustomerId: "cus_reviewed", migrationBinding: null } } } });
		expect(await invoke(route, f.ctx)).toMatchObject(route === accessHandler ? { hasAccess: false } : { ok: false });
		expect(f.calls).toEqual([]);
	});
}

const BLOCKED_REGISTRY = { version: 1, members: { [EMAIL]: { stripeCustomerId: RECORD.stripeCustomerId, migrationBinding: BINDING, blocked: true } } };
for (const route of [...routes, checkoutCompleteHandler]) {
	it(`${route.name} refuses an explicitly blocked historical identity without provider resurrection`, async () => {
		const f = context({ registry: BLOCKED_REGISTRY });
		expect(await invoke(route, f.ctx)).toMatchObject(route === accessHandler ? { hasAccess: false } : { ok: false });
		expect(f.calls).toEqual(route === checkoutCompleteHandler ? ["GET /v1/checkout/sessions/cs_complete"] : []);
		expect(f.customers.put).not.toHaveBeenCalled();
		expect(f.email.send).not.toHaveBeenCalled();
	});
}

it("keeps retained blocked associations intact instead of creating, replacing, or repairing them", async () => {
	const f = context({ registry: BLOCKED_REGISTRY });
	await expect(upsertCustomerRecord(f.plugin, EMAIL, "cus_reviewed")).rejects.toThrow("blocked");
	await expect(upsertCustomerRecord(f.plugin, EMAIL, "cus_other")).rejects.toThrow("blocked");
	await expect(findOrCreateCustomerRecord(f.plugin, new StripeClient(KEY, f.ctx.http.fetch), EMAIL, await loadSettings(f.plugin))).rejects.toThrow("blocked");
	expect(f.calls).toEqual([]);
	expect(f.customers.put).not.toHaveBeenCalled();
});

it.each([false, null, "true", 1, undefined])("refuses non-true blocked dispositions: %j", async blocked => {
	const f = context({ registry: { version: 1, members: { [EMAIL]: { stripeCustomerId: RECORD.stripeCustomerId, migrationBinding: BINDING, blocked } } } });
	expect(await invoke(accessHandler, f.ctx)).toMatchObject({ hasAccess: false });
	expect(f.calls).toEqual([]);
});

it("valid blocked historical entries do not disable another verified live association", async () => {
	const f = context({ registry: { version: 1, members: {
		[EMAIL]: { stripeCustomerId: RECORD.stripeCustomerId, migrationBinding: BINDING },
		"blocked@example.invalid": { stripeCustomerId: "cus_blocked", migrationBinding: BINDING, blocked: true },
	} } });
	expect(await invoke(accessHandler, f.ctx)).toMatchObject({ hasAccess: true });
	expect(await invoke(memberEntitlementsHandler, f.ctx)).toMatchObject({ ok: true, planSlugs: ["plus"] });
	expect(f.calls.every(call => !call.includes("cus_blocked"))).toBe(true);
});

it.each(["cus_unregistered", "cus_reviewed", "cus_foreign"])("standalone association verification refuses a blocked email before looking up %s", async customerId => {
	const registry = { version: 1, members: {
		...BLOCKED_REGISTRY.members,
		"foreign@example.invalid": { stripeCustomerId: "cus_foreign", migrationBinding: BINDING },
	} };
	const f = context({ registry });
	const failure = await verifyCustomerAssociation(f.plugin, new StripeClient(KEY, f.ctx.http.fetch), EMAIL, customerId, await loadSettings(f.plugin)).then(() => null, (error: unknown) => error);
	expect(failure).toBeInstanceOf(Error);
	expect(failure).not.toBeInstanceOf(ForeignMigratedCustomerError);
	expect(failure).toMatchObject({ message: "Migrated customer identity is blocked pending review." });
	expect(f.customers.get).not.toHaveBeenCalled();
	expect(f.customers.query).not.toHaveBeenCalled();
	expect(f.customers.put).not.toHaveBeenCalled();
	expect(f.calls).toEqual([]);
});

it("checkout returns a sanitized refusal when email search finds another migrated identity", async () => {
	const f = context({ lookupEmail: "changed@example.invalid" });
	await expect(invoke(checkoutHandler, f.ctx)).resolves.toEqual({ ok: false, error: "Unable to verify migrated Stripe customer. Contact the site administrator." });
	expect(f.calls).toEqual(["GET /v1/prices", "GET /v1/customers"]);
	expect(f.customers.put).not.toHaveBeenCalled();
	expect(f.email.send).not.toHaveBeenCalled();
});
