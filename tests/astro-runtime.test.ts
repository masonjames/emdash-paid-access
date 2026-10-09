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
function setup(ours: unknown = open, legacy?: unknown) {
	const privateCall = vi.fn(async (_id: string, _method: string, path: string, _req: Request) => ({ success: true, data: path === "access" ? ours : { ok: true } }));
	const publicCall = vi.fn(async (_id: string, _method: string, path: string, _req: Request) => legacy === undefined
		? { success: false, error: { code: "NOT_FOUND" } } : { success: true, data: path === "access" ? legacy : { authenticated: false } });
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

it("calls private routes through the server runtime when locals only carry the public dispatcher", async () => {
	// EmDash's anonymous fast path (every AI agent) exposes only handlePublicPluginApiRoute.
	runtimeCall.mockClear();
	const locals = { emdash: { handlePublicPluginApiRoute: vi.fn() } };
	expect(await callPlugin(locals, "agent/context", { collection: "posts" })).toEqual({ ok: true, data: { ok: true, via: "runtime" } });
	expect(runtimeCall.mock.calls[0].slice(0, 3)).toEqual(["paid-access", "POST", "agent/context"]);
	expect(locals.emdash.handlePublicPluginApiRoute).not.toHaveBeenCalled();
});
