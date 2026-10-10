// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later
import { beforeEach, expect, it, vi } from "vitest";
const runtimeCall = vi.hoisted(() => vi.fn(async (_id: string, _method: string, _path: string, _req: Request) => ({ success: true, data: { ok: true, via: "runtime" } })));
vi.mock("emdash/middleware", () => ({ withEmDashRuntime: async (run: (runtime: { handlePluginApiRoute: typeof runtimeCall }) => unknown) => run({ handlePluginApiRoute: runtimeCall }) }));
import { callPlugin, callPublicPlugin, createPaidAccess, resetRuntimeForTests, type HumanDecision } from "../src/astro/runtime.js";
import { resetCoexistenceCacheForTests } from "../src/coexistence.js";
import { resolveOptions } from "../src/astro/options.js";

const open: HumanDecision = { restricted: false, hasAccess: true, authenticated: false, email: null, requiredPlanSlugs: [], requiredProductIds: [], humanMode: "stripe" };
const request = new Request("https://site.test/post", { headers: { cookie: "legacy_session=example" } });
beforeEach(() => { resetRuntimeForTests(); resetCoexistenceCacheForTests(); });
const anonymous = { ok: true, humanMode: "stripe", authenticated: false, planSlugs: [] };
function setup(ours: unknown = open, legacy?: unknown, entitlements: unknown = anonymous, legacySession: unknown = { authenticated: false }) {
	const privateCall = vi.fn(async (_id: string, _method: string, path: string, _req: Request) => ({ success: true, data: path === "access" ? ours : path === "entitlements" ? entitlements : { ok: true } }));
	const publicCall = vi.fn(async (_id: string, _method: string, path: string, _req: Request) => legacy === undefined
		? { success: false, error: { code: "NOT_FOUND" } } : { success: true, data: path === "access" ? legacy : legacySession });
	const locals = { emdash: { handlePluginApiRoute: privateCall, handlePublicPluginApiRoute: publicCall } };
	return { locals, privateCall, publicCall, api: createPaidAccess(locals, request, "test-token", resolveOptions({ legacyPluginId: "legacy-custom" })) };
}
const entry = { collection: "posts", id: "db-1", slug: "slug" };
it("unwraps private/public envelopes and preserves GET query and POST JSON", async () => {
	const { locals, privateCall, publicCall } = setup();
	expect(await callPlugin(locals, "access", { sessionToken: "test" })).toEqual({ ok: true, data: open });
	expect(privateCall.mock.calls[0].slice(0, 3)).toEqual(["paid-access", "POST", "access"]);
	expect(await privateCall.mock.calls[0][3].json()).toEqual({ sessionToken: "test" });
	await callPublicPlugin(locals, "offers", { limit: "3", cursor: "next" });
	expect(publicCall.mock.calls[0].slice(0, 3)).toEqual(["paid-access", "GET", "offers"]);
	expect(new URL(publicCall.mock.calls[0][3].url).search).toBe("?limit=3&cursor=next");
});
it("unwraps plugin error codes and contains exceptions and missing locals", async () => {
	const { locals, privateCall } = setup({ ok: false, error: { code: "MODULE_DISABLED" } });
	expect(await callPlugin(locals, "access", {})).toEqual({ ok: false, code: "MODULE_DISABLED" });
	privateCall.mockRejectedValueOnce(new Error("offline"));
	expect(await callPlugin(locals, "access", {})).toEqual({ ok: false, code: "UNAVAILABLE" });
	// Public calls need EmDash's locals; private calls don't (they use the server runtime).
	expect(await callPublicPlugin({}, "offers", {})).toEqual({ ok: false, code: "UNAVAILABLE" });
});
it("probes lazily, reports once and memoizes stripe access per entry and requirements", async () => {
	const { api, privateCall, publicCall } = setup();
	expect(privateCall).not.toHaveBeenCalled(); expect(publicCall).not.toHaveBeenCalled();
	expect(await api.access(entry)).toEqual(open);
	await api.access(entry); await api.session();
	expect(privateCall.mock.calls.filter(call => call[2] === "access")).toHaveLength(1);
	expect(privateCall.mock.calls.filter(call => call[2] === "coexistence/report")).toHaveLength(1);
	expect(publicCall).toHaveBeenCalledTimes(1);
	expect(publicCall.mock.calls[0][0]).toBe("legacy-custom");
	await api.access({ ...entry, requiredPlanSlugs: ["plus"] });
	expect(privateCall.mock.calls.filter(call => call[2] === "access")).toHaveLength(2);
});
it.each(["delegate", "stripe"] as const)("unions restrictions and delegates %s to the installed legacy plugin", async humanMode => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
	const ours = { ...open, restricted: true, hasAccess: false, requiredPlanSlugs: ["plus"], humanMode, delegated: humanMode === "delegate" };
	const { api, publicCall } = setup(ours, { ...open, restricted: true, authenticated: true, hasAccess: true, requiredPlanSlugs: ["plus", "legacy"] });
	expect(await api.access(entry)).toMatchObject({ restricted: true, hasAccess: true, requiredPlanSlugs: ["plus", "legacy"] });
	const call = publicCall.mock.calls.find(call => call[2] === "access")!;
	expect(await call[3].json()).toMatchObject({ contentId: "db-1", requiredPlanSlugs: ["plus"] });
	expect(call[3].headers.get("cookie")).toBe("legacy_session=example");
	vi.restoreAllMocks();
});
it.each([null, { ...open, error: "offline" }, { ok: false, error: "offline" }, { hasAccess: true }])("fails closed on invalid/error access %j", async ours => {
	expect(await setup(ours).api.access(entry)).toMatchObject({ hasAccess: false, restricted: true });
});
it("fails closed for legacy denial, unavailable delegation, and probe errors", async () => {
	expect(await setup({ ...open, delegated: true }, { ...open, restricted: true, hasAccess: false }).api.access(entry)).toMatchObject({ hasAccess: false });
	resetRuntimeForTests(); resetCoexistenceCacheForTests();
	expect(await setup({ ...open, delegated: true }).api.access(entry)).toMatchObject({ hasAccess: false });
	resetRuntimeForTests(); resetCoexistenceCacheForTests();
	const { api, publicCall } = setup(); publicCall.mockRejectedValue(new Error("offline"));
	expect(await api.access(entry)).toMatchObject({ hasAccess: false });
	expect(await api.session()).toEqual({ authenticated: false, email: null });
	expect(await api.plans()).toEqual([]);
});
it("returns session and public plans without exposing failed responses", async () => {
	const { api, privateCall, publicCall } = setup();
	privateCall.mockImplementation(async () => ({ success: true, data: { authenticated: true, email: "member@example.com" } }));
	expect(await api.session()).toEqual({ authenticated: true, email: "member@example.com" });
	publicCall.mockImplementation(async () => ({ success: true, data: { plans: [{ slug: "plus", name: "Plus" }] } }));
	expect(await api.plans()).toEqual([{ slug: "plus", name: "Plus" }]);
});

it("does not unlock a delegated restriction when legacy silently drops its requirements", async () => {
	const ours = { ...open, restricted: true, hasAccess: false, delegated: true, requiredPlanSlugs: ["unknown-plan"] };
	const legacy = { ...open, authenticated: true, restricted: true, hasAccess: true };
	expect(await setup(ours, legacy).api.access(entry)).toMatchObject({ hasAccess: false });
});

it("middleware sets request locals and reads the cookie without eagerly calling plugins", async () => {
	const { onRequest } = await import("../src/astro/middleware.js");
	const { locals, privateCall, publicCall } = setup();
	const context = { locals, request, cookies: { get: () => ({ value: "test-token" }) } };
	const next = vi.fn(async () => new Response("next"));
	await onRequest(context as unknown as Parameters<typeof onRequest>[0], next);
	expect((locals as typeof locals & { paidAccess: { sessionToken: string } }).paidAccess.sessionToken).toBe("test-token");
	expect(next).toHaveBeenCalledOnce(); expect(privateCall).not.toHaveBeenCalled(); expect(publicCall).not.toHaveBeenCalled();
});

it("prevents shared caching before a streamed HTML body is read", async () => {
	const { onRequest } = await import("../src/astro/middleware.js");
	const { locals } = setup();
	const context = { locals, request, cookies: { get: () => undefined } };
	let finish: (() => void) | undefined;
	const body = new ReadableStream<Uint8Array>({ start(controller) { finish = () => { controller.enqueue(new TextEncoder().encode("protected body")); controller.close(); }; } });
	const response = await onRequest(context as unknown as Parameters<typeof onRequest>[0], async () => new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" } }));
	expect(response.headers.get("Cache-Control")).toBe("private, no-store");
	finish!();
	expect(await response.text()).toBe("protected body");
});

it("preserves cache policy for non-HTML responses", async () => {
	const { onRequest } = await import("../src/astro/middleware.js");
	const { locals } = setup();
	const context = { locals, request, cookies: { get: () => undefined } };
	const response = await onRequest(context as unknown as Parameters<typeof onRequest>[0], async () => new Response("{}", { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" } }));
	expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
});

// Mirrors AstroCache.set(): a later hint clears an earlier set(false).
function routeCache(enabled = true) {
	const state = { disabled: false };
	const set = vi.fn((input: unknown) => { state.disabled = input === false; });
	return { cache: { enabled, set }, state };
}
const html = () => new Response("<p>page</p>", { headers: { "Content-Type": "text/html" } });

it("disables Astro's route cache for HTML after the page sets a cache hint", async () => {
	const { onRequest } = await import("../src/astro/middleware.js");
	const { locals } = setup();
	const { cache, state } = routeCache();
	const context = { locals, request, cookies: { get: () => undefined }, cache };
	const response = await onRequest(context as unknown as Parameters<typeof onRequest>[0], async () => { cache.set({ maxAge: 300, tags: ["post"] }); return html(); });
	expect(response.headers.get("Cache-Control")).toBe("private, no-store");
	expect(cache.set).toHaveBeenLastCalledWith(false);
	expect(state.disabled).toBe(true);
});

it("leaves the route cache alone for non-HTML responses and contexts without cache", async () => {
	const { onRequest } = await import("../src/astro/middleware.js");
	const { locals } = setup();
	const { cache, state } = routeCache();
	const json = { locals, request, cookies: { get: () => undefined }, cache };
	await onRequest(json as unknown as Parameters<typeof onRequest>[0], async () => { cache.set({ maxAge: 60 }); return new Response("{}", { headers: { "Content-Type": "application/json" } }); });
	expect(cache.set).toHaveBeenCalledOnce(); expect(state.disabled).toBe(false);
	const bare = { locals, request, cookies: { get: () => undefined } };
	const response = await onRequest(bare as unknown as Parameters<typeof onRequest>[0], async () => html());
	expect(response.headers.get("Cache-Control")).toBe("private, no-store");
});

it("disables Astro's route cache for a paid agent response marked no-store", async () => {
	const { onRequest } = await import("../src/astro/middleware.js");
	const { locals } = setup();
	const { cache, state } = routeCache();
	const context = { locals, request: new Request("https://site.test/agents/posts/slug.md"), cookies: { get: () => undefined }, cache };
	const response = await onRequest(context as unknown as Parameters<typeof onRequest>[0], async () => {
		cache.set({ maxAge: 600 });
		return new Response("# Paid body", { headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "private, no-store" } });
	});
	expect(response.headers.get("Cache-Control")).toBe("private, no-store");
	expect(cache.set).toHaveBeenLastCalledWith(false);
	expect(state.disabled).toBe(true);
});

it("keeps the route cache for cacheable non-HTML responses", async () => {
	const { onRequest } = await import("../src/astro/middleware.js");
	const { locals } = setup();
	const { cache, state } = routeCache();
	const context = { locals, request: new Request("https://site.test/agents/offers.json"), cookies: { get: () => undefined }, cache };
	const response = await onRequest(context as unknown as Parameters<typeof onRequest>[0], async () => {
		cache.set({ maxAge: 300 });
		return Response.json({ offers: [] }, { headers: { "Cache-Control": "public, max-age=300" } });
	});
	expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
	expect(cache.set).not.toHaveBeenCalledWith(false);
	expect(state.disabled).toBe(false);
});

it("does not touch a cache that is not enabled", async () => {
	const { onRequest } = await import("../src/astro/middleware.js");
	const { locals } = setup();
	const { cache } = routeCache(false);
	const context = { locals, request, cookies: { get: () => undefined }, cache };
	const response = await onRequest(context as unknown as Parameters<typeof onRequest>[0], async () => html());
	expect(response.headers.get("Cache-Control")).toBe("private, no-store");
	expect(cache.set).not.toHaveBeenCalled();
});

it("calls private routes through the server runtime when locals only carry the public dispatcher", async () => {
	// EmDash's anonymous fast path (every AI agent) exposes only handlePublicPluginApiRoute.
	runtimeCall.mockClear();
	const locals = { emdash: { handlePublicPluginApiRoute: vi.fn() } };
	expect(await callPlugin(locals, "agent/context", { collection: "posts" })).toEqual({ ok: true, data: { ok: true, via: "runtime" } });
	expect(runtimeCall.mock.calls[0].slice(0, 3)).toEqual(["paid-access", "POST", "agent/context"]);
	expect(locals.emdash.handlePublicPluginApiRoute).not.toHaveBeenCalled();
});

const member = { ok: true, humanMode: "stripe", authenticated: true, planSlugs: ["team", "plus", "plus"] };
const calls = (spy: { mock: { calls: unknown[][] } }, path: string) => spy.mock.calls.filter(call => call[2] === path);
function reset() { resetRuntimeForTests(); resetCoexistenceCacheForTests(); }

it("segments returns member and plan segments from one memoized entitlement call", async () => {
	const { api, privateCall } = setup(open, undefined, member);
	const first = await api.segments();
	expect(first).toEqual(["member", "plan:plus", "plan:team"]);
	// Each call gets its own copy, so a host that mutates one can't change the next.
	first.push("plan:mutated");
	expect(await api.segments()).toEqual(["member", "plan:plus", "plan:team"]);
	await Promise.all([api.segments(), api.segments({ entry }), api.segments({ entry: { ...entry, id: "db-2" } })]);
	expect(calls(privateCall, "entitlements")).toHaveLength(1);
	const [, method, , init] = calls(privateCall, "entitlements")[0] as [string, string, string, Request];
	expect(method).toBe("POST");
	expect(await init.json()).toEqual({ sessionToken: "test-token" });
	expect(init.headers.has("cookie")).toBe(false);
});

it("segments adds entitled only when access grants the entry, including unrestricted ones", async () => {
	const { api, privateCall } = setup(open, undefined, { ...member, planSlugs: ["plus"] });
	const decisions: Record<string, unknown> = {
		open, granted: { ...open, restricted: true, authenticated: true, hasAccess: true },
		denied: { ...open, restricted: true, authenticated: true, hasAccess: false },
		erred: { ...open, restricted: true, hasAccess: true, error: "Unable to verify Stripe access right now." },
	};
	privateCall.mockImplementation(async (_id, _method, path, init) => ({ success: true, data: path === "access" ? decisions[(await init.json()).contentId] : path === "entitlements" ? { ...member, planSlugs: ["plus"] } : { ok: true } }));
	expect(await api.segments()).toEqual(["member", "plan:plus"]);
	expect(await api.segments({ entry: { ...entry, id: "open" } })).toEqual(["entitled", "member", "plan:plus"]);
	expect(await api.segments({ entry: { ...entry, id: "granted" } })).toEqual(["entitled", "member", "plan:plus"]);
	expect(await api.segments({ entry: { ...entry, id: "denied" } })).toEqual(["member", "plan:plus"]);
	// An unverifiable decision fails the whole answer closed.
	expect(await api.segments({ entry: { ...entry, id: "erred" } })).toEqual([]);
});

it("segments returns [] when the entry decision could not be verified", async () => {
	const { api, privateCall } = setup(open, undefined, member);
	privateCall.mockImplementation(async (_id, _method, path, init) => path === "access"
		? (await init.json()).contentId === "offline" ? { success: false, error: { code: "UNAVAILABLE" } } : { success: true, data: { ...open, restricted: true, hasAccess: false, error: "Required plans are not configured." } }
		: { success: true, data: path === "entitlements" ? member : { ok: true } });
	expect(await api.segments()).toEqual(["member", "plan:plus", "plan:team"]);
	expect(await api.segments({ entry: { ...entry, id: "offline" } })).toEqual([]);
	expect(await api.segments({ entry: { ...entry, id: "unconfigured" } })).toEqual([]);
	reset();
	const reader = { authenticated: true, email: "reader@example.com" };
	const delegated = setup({ ...open, restricted: true, hasAccess: false, humanMode: "delegate", delegated: true }, open, { ...member, humanMode: "delegate" }, reader);
	delegated.publicCall.mockImplementation(async (_id, _method, path) => path === "access" ? { success: false, error: { code: "INTERNAL_ERROR" } } : { success: true, data: reader });
	expect(await delegated.api.segments()).toEqual(["member"]);
	expect(await delegated.api.segments({ entry })).toEqual([]);
});

it("segments shares the memoized access decision for an entry", async () => {
	const { api, privateCall } = setup({ ...open, restricted: true, authenticated: true, hasAccess: true });
	expect(await api.segments({ entry })).toEqual(["entitled"]);
	const decision = api.access(entry);
	expect(await decision).toMatchObject({ hasAccess: true });
	await api.segments({ entry: { ...entry } });
	expect(calls(privateCall, "access")).toHaveLength(1);
	await api.access({ ...entry, requiredPlanSlugs: ["plus"] });
	await api.segments({ entry: { ...entry, requiredPlanSlugs: ["plus"] } });
	expect(calls(privateCall, "access")).toHaveLength(2);
});

it("segments derives member from the legacy session in delegate mode and never emits plans", async () => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
	const reader = { authenticated: true, email: "reader@example.com" };
	const delegated = { ...open, restricted: true, hasAccess: false, humanMode: "delegate", delegated: true };
	const granted = { ...open, restricted: true, authenticated: true, hasAccess: true };
	const { api, publicCall } = setup(delegated, granted, { ...member, humanMode: "delegate" }, reader);
	expect(await api.segments()).toEqual(["member"]);
	expect(await api.segments({ entry })).toEqual(["entitled", "member"]);
	const [id, method, path, init] = calls(publicCall, "auth/session").at(-1) as [string, string, string, Request];
	expect([id, method, path, init.method]).toEqual(["legacy-custom", "GET", "auth/session", "GET"]);
	expect(init.headers.get("cookie")).toBe("legacy_session=example");
	// A configured stripe mode is downgraded while the legacy plugin is active.
	reset();
	expect(await setup(open, open, member, reader).api.segments()).toEqual(["member"]);
	reset();
	expect(await setup(open, open, { ...member, humanMode: "delegate" }, { authenticated: false }).api.segments()).toEqual([]);
	vi.restoreAllMocks();
});

it("segments emits no member or plan segments in off mode", async () => {
	const off = { ...member, humanMode: "off" };
	const { api, privateCall, publicCall } = setup({ ...open, humanMode: "off" }, undefined, off);
	expect(await api.segments()).toEqual([]);
	expect(await api.segments({ entry })).toEqual(["entitled"]);
	expect(calls(publicCall, "auth/session")).toHaveLength(1); // the probe only
	expect(calls(privateCall, "auth/session")).toHaveLength(0);
	reset();
	const restricted = { ...open, humanMode: "off", restricted: true, hasAccess: false, error: "Member access is turned off for this site." };
	expect(await setup(restricted, undefined, off).api.segments({ entry })).toEqual([]);
});

it("segments returns [] on entitlement failure or a malformed answer and never throws", async () => {
	const answers = [
		{ ok: false, error: { code: "UNAVAILABLE" } }, null, [], { ...member, ok: undefined, humanMode: undefined },
		{ ...member, humanMode: "paid" }, { ...member, authenticated: "yes" }, { ...member, planSlugs: "plus" }, { ...member, planSlugs: [1] },
	];
	for (const answer of answers) {
		reset();
		expect(await setup(open, undefined, answer).api.segments({ entry })).toEqual([]);
	}
	reset();
	const rejected = setup(open, undefined, member);
	rejected.privateCall.mockRejectedValue(new Error("offline"));
	expect(await rejected.api.segments({ entry })).toEqual([]);
	reset();
	const probe = setup(open, undefined, member);
	probe.publicCall.mockRejectedValue(new Error("offline"));
	expect(await probe.api.segments({ entry })).toEqual([]);
	reset();
	const legacy = setup(open, open, { ...member, humanMode: "delegate" });
	await legacy.api.detectLegacy();
	legacy.publicCall.mockResolvedValue({ success: false, error: { code: "INTERNAL_ERROR" } });
	expect(await legacy.api.segments()).toEqual([]);
	reset();
	const missing = createPaidAccess({}, request, "test-token", resolveOptions());
	await expect(missing.segments({ entry })).resolves.toEqual([]);
	// A pathological host argument never throws synchronously.
	reset();
	const odd = setup(open, undefined, member).api;
	await expect(odd.segments({ entry: { ...entry, requiredPlanSlugs: [1n] as unknown as string[] } })).resolves.toEqual([]);
	const throwing = Object.defineProperty({}, "entry", { get() { throw new Error("host bug"); } }) as { entry?: typeof entry };
	await expect(odd.segments(throwing)).resolves.toEqual([]);
});

it("segments returns [] unless the entitlements answer is explicitly ok", async () => {
	const { ok: _ok, ...noOk } = member;
	for (const answer of [noOk, { ...member, ok: "false" }, { ...member, ok: 1 }]) {
		reset();
		expect(await setup(open, undefined, answer).api.segments({ entry })).toEqual([]);
	}
	reset();
	expect(await setup(open, undefined, member).api.segments({ entry })).toEqual(["entitled", "member", "plan:plus", "plan:team"]);
});

it("segments returns [] for a malformed or failed legacy session answer, even for an unrestricted entry", async () => {
	const delegate = { ...member, humanMode: "delegate" };
	for (const anonymousAnswer of [{ authenticated: false }, { authenticated: true }, { authenticated: false, email: null }]) {
		reset();
		expect(await setup(open, open, delegate, anonymousAnswer).api.segments({ entry })).toEqual(["entitled"]);
	}
	for (const answer of [{ ok: false, authenticated: true, email: "reader@example.com" }, { authenticated: "yes", email: "reader@example.com" }, {}, { authenticated: true, email: 5 }, null]) {
		reset();
		expect(await setup(open, open, delegate, answer).api.segments({ entry })).toEqual([]);
	}
});

it("segments shares one entitlements call across concurrent cold calls", async () => {
	const { api, privateCall } = setup(open, undefined, member);
	const [cold, withEntry] = await Promise.all([api.segments(), api.segments({ entry })]);
	expect(cold).toEqual(["member", "plan:plus", "plan:team"]);
	expect(withEntry).toEqual(["entitled", "member", "plan:plus", "plan:team"]);
	expect(calls(privateCall, "entitlements")).toHaveLength(1);
	expect(calls(privateCall, "coexistence/report")).toHaveLength(1);
});

it("segments keeps returning [] after a rejected entitlements call", async () => {
	const { api, privateCall } = setup(open, undefined, member);
	privateCall.mockImplementation(async (_id, _method, path) => {
		if (path === "entitlements") throw new Error("offline");
		return { success: true, data: path === "access" ? open : { ok: true } };
	});
	expect(await api.segments()).toEqual([]);
	expect(await api.segments({ entry })).toEqual([]);
	expect(await api.segments()).toEqual([]);
	expect(calls(privateCall, "entitlements")).toHaveLength(1);
});

it("segments omits plan slugs outside the grammar", async () => {
	const slugs = ["plus", "Plus", "has space", "<script>", "plus\n", "", "a".repeat(59), "a".repeat(60)];
	expect(await setup(open, undefined, { ...member, planSlugs: slugs }).api.segments()).toEqual(["member", `plan:${"a".repeat(59)}`, "plan:plus"]);
});

it("segments ignores an EmDash staff user on locals", async () => {
	const { locals, privateCall } = setup(open, undefined, anonymous);
	const user = vi.fn(() => ({ id: "staff", email: "admin@example.com", role: 50 }));
	Object.defineProperty(locals, "user", { get: user });
	const api = createPaidAccess(locals, request, null, resolveOptions());
	const segments = await api.segments({ entry });
	expect(segments).toEqual(["entitled"]);
	expect(user).not.toHaveBeenCalled();
	expect(JSON.stringify(segments)).not.toMatch(/admin|staff|@|50/);
	const [, , , init] = calls(privateCall, "entitlements")[0] as [string, string, string, Request];
	expect(await init.json()).toEqual({ sessionToken: null });
});
