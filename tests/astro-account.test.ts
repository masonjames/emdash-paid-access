// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, it, vi } from "vitest";
import type { APIContext } from "astro";
import { GET, POST } from "../src/astro/routes/account.js";
function setup(action: string, method = "GET", data: unknown = { ok: true }, origin = "https://site.test", fields: Record<string, string> = {}) {
	const handler = vi.fn(async (_id: string, _method: string, _path: string, _req: Request) => ({ success: true, data }));
	const url = new URL(`/account/${action}`, origin);
	const body = new URLSearchParams(fields);
	if (method === "GET") url.search = body.toString();
	const cookies = { get: vi.fn(() => ({ value: "session-test" })), set: vi.fn(), delete: vi.fn() };
	const context = { url, cookies, request: new Request(url, { method, ...(method === "POST" ? { body } : {}) }), locals: { emdash: { handlePluginApiRoute: handler } } } as unknown as APIContext;
	return { context, handler, cookies };
}
it.each([true, false])("sign-in redirects with success=%s, sanitizing and sending intent", async success => {
	const { context, handler } = setup("sign-in", "POST", { ok: success }, undefined, { email: "me@example.com", redirect: "/post?x=1#body" });
	const response = await POST(context);
	expect(response.status).toBe(303); expect(response.headers.get("Location")).toBe(`/post?x=1&phb=${success ? "link-sent" : "link-error"}#body`);
	expect(await handler.mock.calls[0][3].json()).toEqual({ email: "me@example.com", redirect: "/post?x=1#body", intent: "signin" });
});
it.each(["https://site.test", "http://localhost:4321", "http://127.0.0.1:4321", "http://site.test"])("verify sets the session cookie correctly on %s", async origin => {
	const { context, cookies } = setup("verify/", "GET", { ok: true, sessionToken: "issued-token", redirect: "/post" }, origin, { token: "magic-test" });
	const response = await GET(context); expect(response.headers.get("Location")).toBe("/post?phb=signed-in");
	expect(cookies.set).toHaveBeenCalledWith("phb_session", "issued-token", { path: "/", httpOnly: true, sameSite: "lax", maxAge: 2592000, secure: !["localhost", "127.0.0.1"].includes(new URL(origin).hostname) });
});
it("invalid verify never sets a cookie; external redirects become local", async () => {
	const failed = setup("verify", "GET", { ok: false });
	expect((await GET(failed.context)).headers.get("Location")).toBe("/?phb=link-invalid"); expect(failed.cookies.set).not.toHaveBeenCalled();
	const external = setup("verify", "GET", { sessionToken: "test", redirect: "//evil.test" });
	expect((await GET(external.context)).headers.get("Location")).toBe("/?phb=signed-in");
});
it("logout clears the cookie even when the plugin errors", async () => {
	const { context, handler, cookies } = setup("logout", "POST", { ok: false });
	expect((await POST(context)).headers.get("Location")).toBe("/?phb=signed-out");
	expect(await handler.mock.calls[0][3].json()).toEqual({ sessionToken: "session-test" });
	expect(cookies.delete).toHaveBeenCalledWith("phb_session", { path: "/", httpOnly: true, secure: true, sameSite: "lax" });
});
it("checkout uses the core redirectUrl field and only redirects to Stripe HTTPS", async () => {
	const { context, handler } = setup("checkout", "POST", { ok: true, url: "https://checkout.stripe.com/c/pay/test" }, undefined, { email: "me@example.com", planSlug: "plus", billingInterval: "monthly", redirect: "//evil.test" });
	expect((await POST(context)).headers.get("Location")).toBe("https://checkout.stripe.com/c/pay/test");
	expect(await handler.mock.calls[0][3].json()).toMatchObject({ redirectUrl: "/", planSlug: "plus", billingInterval: "monthly" });
	for (const data of [{ ok: false }, { ok: true, url: "https://evil.test" }, { ok: true, url: "javascript:alert(1)" }]) {
		const failed = setup("checkout", "POST", data, undefined, { redirect: "/post" });
		expect((await POST(failed.context)).headers.get("Location")).toBe("/post?phb=checkout-error");
	}
});
it.each([true, false])("complete forwards session ID and reports success=%s", async success => {
	const { context, handler } = setup("complete/", "GET", { ok: success }, undefined, { session_id: "cs_test", redirect: "/post" });
	expect((await GET(context)).headers.get("Location")).toBe(`/post?phb=${success ? "check-email" : "checkout-error"}`);
	expect(await handler.mock.calls[0][3].json()).toEqual({ sessionId: "cs_test", redirect: "/post" });
});
it("portal requires a session and forwards a sanitized return URL", async () => {
	const { context, handler, cookies } = setup("portal", "GET", { url: "https://billing.stripe.com/p/session/test" }, undefined, { return: "https://evil.test" });
	expect((await GET(context)).headers.get("Location")).toBe("https://billing.stripe.com/p/session/test");
	expect(await handler.mock.calls[0][3].json()).toEqual({ sessionToken: "session-test", returnUrl: "/" });
	cookies.get.mockReturnValue(undefined as never);
	expect((await GET(context)).headers.get("Location")).toBe("/?phb=sign-in-required"); expect(handler).toHaveBeenCalledTimes(1);
});
it("refuses GET sign-in and POST verification", async () => {
	expect((await GET(setup("sign-in").context)).status).toBe(405);
	expect((await POST(setup("verify", "POST").context)).status).toBe(405);
});
