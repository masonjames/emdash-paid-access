import { afterEach, expect, it, vi } from "vitest";
import { createPaidAccess } from "../src/astro/runtime.js";
import { resolveOptions } from "../src/astro/options.js";
import { accessHandler } from "../src/handlers/access.js";
import { readerGroupHandler } from "../src/handlers/reader-group.js";
import { StripeClient } from "../src/stripe.js";
import { invoke } from "./fixtures/route.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const en = { id: "english", slug: "original", locale: "en" };
const fr = { id: "french", slug: "copied", locale: "fr" };
const resource = { collection: "posts", ...fr, revision: "v1" };
function setup(input: { rules?: Record<string, unknown>; taxonomy?: unknown; entries?: unknown; member?: boolean; owned?: string[]; migration?: boolean } = {}) {
	const calls: string[] = [];
	const unrelatedPublic = vi.fn(async () => { throw new Error("No other plugin may be called"); });
	const ctx = {
		settings: { get: async (key: string) => ({ humansMode: input.migration ? "delegate" : "stripe", humansPlans: [{ slug: "plus", name: "Plus", stripeProductId: "prod_plus", grantsVisibility: [] }, { slug: "pro", name: "Pro", stripeProductId: "prod_pro", grantsVisibility: [] }], stripeSecretKey: "sk_test_synthetic", showExcerpts: true } as Record<string, unknown>)[key] ?? null },
		storage: {
			restrictions: { get: async (key: string) => input.rules?.[key] ?? null },
			taxonomy_restrictions: { get: async () => input.taxonomy ?? null, query: async () => ({ items: [] }) },
			sessions: { get: async () => input.member ? { email: "member@example.test", expiresAt: "2999-01-01" } : null },
			customers: { get: async () => ({ stripeCustomerId: "customer" }), query: async () => ({ items: [] }) },
		},
		content: { getTranslations: async () => input.entries ?? { translationGroup: "work", translations: [en, fr] } },
		taxonomies: { getEntryTerms: async () => input.taxonomy === undefined ? [] : [{ taxonomy: "tag", id: "premium" }] },
		http: { fetch: vi.fn() }, log: { warn: vi.fn(), error: vi.fn() },
	};
	vi.spyOn(StripeClient.prototype, "customerHasProduct").mockImplementation(async (_id, products) => products.some(product => input.owned?.includes(product)));
	vi.spyOn(StripeClient.prototype, "getCustomersByEmail").mockResolvedValue({ data: [] });
	const dispatch = async (_plugin: string, _method: string, path: string, request: Request) => {
		calls.push(path);
		const body = await request.json();
		try {
			const data = path === "reader/group" ? await invoke(readerGroupHandler, { ...ctx, input: body }) : path === "access" ? await invoke(accessHandler, { ...ctx, input: body }) : { ok: true };
			return { success: true, data };
		} catch { return { success: false, error: { code: "UNAVAILABLE" } }; }
	};
	const api = createPaidAccess({ emdash: { handlePluginApiRoute: dispatch, handlePublicPluginApiRoute: unrelatedPublic } }, new Request("https://reader.test/"), input.member ? "session" : null, resolveOptions());
	return { api, calls, unrelatedPublic };
}
const members = { contentId: en.id, collectionSlug: "posts", policy: "members", requiredPlanSlugs: ["plus"] };
it("a copied translation inherits sibling restrictions through the actual handler and resolver", async () => {
	const { api, calls } = setup({ rules: { "posts:english": members } });
	expect(await api.readerProvider().decide(resource)).toBe("preview");
	expect(await api.readerProvider().decide(resource)).toBe("preview");
	expect(calls.filter(path => path === "reader/group")).toHaveLength(1);
	expect(calls.filter(path => path === "access")).toHaveLength(2);
});
it("public translations remain public and entitled readers can read the protected group", async () => {
	expect(await setup().api.readerProvider().decide(resource)).toBe("allow");
	expect(await setup({ member: true, owned: ["prod_plus"], rules: { "posts:english": members } }).api.readerProvider().decide(resource)).toBe("allow");
});
it("requires every sibling rule, preserving the strictest membership requirements", async () => {
	const rules = { "posts:english": members, "posts:french": { ...members, contentId: fr.id, policy: "members-only", requiredPlanSlugs: ["pro"] } };
	expect(await setup({ member: true, owned: ["prod_plus"], rules }).api.readerProvider().decide(resource)).toBe("preview");
	expect(await setup({ member: true, owned: ["prod_plus", "prod_pro"], rules }).api.readerProvider().decide(resource)).toBe("allow");
});
it("fails closed across translations for stored delegation until explicit migration", async () => {
	for (const member of [false, true]) {
		const { api, unrelatedPublic } = setup({ migration: true, member });
		expect(await api.readerProvider().decide(resource)).toBe("deny");
		expect(unrelatedPublic).not.toHaveBeenCalled();
	}
});
it("uses native rules without probing another installed plugin", async () => {
	const { api, unrelatedPublic } = setup({ member: true, owned: ["prod_plus"], rules: { "posts:english": members } });
	expect(await api.readerProvider().decide(resource)).toBe("allow");
	expect(unrelatedPublic).not.toHaveBeenCalled();
});
it.each([
	{ ...members, policy: "typo", requiredPlanSlugs: [] },
	{ ...members, requiredPlanSlugs: "plus" },
	{ ...members, productIds: [7] },
	{ data: null },
	{ unexpected: true },
	{ ...members, policy: null },
])("malformed present direct metadata never grants a public read: %j", async rule => {
	expect(await setup({ rules: { "posts:english": rule } }).api.readerProvider().decide(resource)).toBe("deny");
});
it("rejects malformed present slug-keyed and taxonomy records", async () => {
	expect(await setup({ rules: { "posts:original": { ...members, contentId: "original", policy: "typo" } } }).api.readerProvider().decide(resource)).toBe("deny");
	expect(await setup({ taxonomy: { taxonomyName: "tag", termId: "premium", policy: "typo" } }).api.readerProvider().decide(resource)).toBe("deny");
});
it("preserves known Paid Access records with explicit membership requirements", async () => {
	const { policy: _policy, ...oldRule } = members;
	expect(await setup({ rules: { "posts:english": { data: oldRule } } }).api.readerProvider().decide(resource)).toBe("preview");
});
it.each([null, { translationGroup: "", translations: [en, fr] }, { translationGroup: "work", translations: [en] }, { translationGroup: "work", translations: [en, { ...fr, locale: null }] }])("denies unavailable or incomplete translation-group metadata: %j", async entries => {
	expect(await setup({ entries: entries === null ? { translationGroup: "work", translations: [] } : entries }).api.readerProvider().decide(resource)).toBe("deny");
});

it("honors the configured provider deadline and fails closed", async () => {
 vi.useFakeTimers();
 const pending = new Promise<never>(() => {});
 const api = createPaidAccess({ emdash: { handlePluginApiRoute: () => pending, handlePublicPluginApiRoute: () => pending } }, new Request("https://reader.test/"), null, resolveOptions({ entitlementTimeoutMs: 250 }));
 const decision = api.readerProvider().decide(resource);
 let done = false; void decision.then(() => { done = true; });
 await vi.advanceTimersByTimeAsync(249); expect(done).toBe(false);
 await vi.advanceTimersByTimeAsync(1); expect(await decision).toBe("deny");
});
