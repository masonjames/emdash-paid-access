// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, it, vi } from "vitest";
import paidAccessAstro from "../src/astro/index.js";
import { resolveOptions } from "../src/astro/options.js";
import type { AstroIntegration } from "astro";
it.each(["relative", "/trailing/", "/../bad", "//external", "/path?x=1", "/path\\evil"])("rejects invalid prefix %s", prefix => {
	expect(() => resolveOptions({ agentRoutePrefix: prefix })).toThrow("agentRoutePrefix");
	expect(() => resolveOptions({ accountPath: prefix })).toThrow("accountPath");
});
it.each([[], [""], [" "]])("rejects empty collections %j", collections => { expect(() => resolveOptions({ collections })).toThrow("collections"); });
it.each([true, false])("registers x402, virtual config, post middleware and routes (account=%s)", async injectAccountRoutes => {
	const injectRoute = vi.fn(); const addMiddleware = vi.fn(); const updateConfig = vi.fn();
	const hook = paidAccessAstro({ injectAccountRoutes, entitlementTimeoutMs: 3000, paymentMaxConcurrent: 4, paymentRequestsPerMinute: 60 }).hooks["astro:config:setup"]!;
	await hook({ injectRoute, addMiddleware, updateConfig } as unknown as Parameters<NonNullable<AstroIntegration["hooks"]["astro:config:setup"]>>[0]);
	expect(injectRoute.mock.calls.map(([route]) => route.pattern)).toEqual(["/agents/[collection]/[slug].md", "/agents/offers.json", ...(injectAccountRoutes ? ["sign-in", "verify", "logout", "checkout", "complete", "portal"].map(action => `/account/${action}`) : [])]);
	expect(addMiddleware).toHaveBeenCalledWith({ entrypoint: "emdash-paid-access/astro/middleware", order: "post" });
	const config = updateConfig.mock.calls[0][0]; expect(config.integrations[0].name).toBe("@emdash-cms/x402");
	const serialized = config.vite.plugins[0].load("\0virtual:paid-access/config");
 expect(serialized).toContain('"accountPath":"/account"');
 for (const value of ['"entitlementTimeoutMs":3000', '"paymentMaxConcurrent":4', '"paymentRequestsPerMinute":60']) expect(serialized).toContain(value);
});

it.each(["not-a-url", "http://facilitator.test", "https://user:pass@facilitator.test", "https://facilitator.test?key=secret", "https://facilitator.test#fragment"])("rejects unsafe facilitator URL %s", facilitatorUrl => {
 expect(() => resolveOptions({ facilitatorUrl })).toThrow("facilitatorUrl");
});
it("normalizes the facilitator URL", () => {
 expect(resolveOptions({ facilitatorUrl: "https://x402.org/facilitator/" }).facilitatorUrl).toBe("https://x402.org/facilitator");
});

it.each(["entitlementTimeoutMs", "paymentMaxConcurrent", "paymentRequestsPerMinute"] as const)("validates %s", key => {
 for (const value of [0, -1, 0.5, NaN, Infinity, 10001]) expect(() => resolveOptions({ [key]: value })).toThrow(key);
});
it("accepts explicit reader and admission budgets", () => {
 expect(resolveOptions({ entitlementTimeoutMs: 3000, paymentMaxConcurrent: 4, paymentRequestsPerMinute: 60 })).toMatchObject({ entitlementTimeoutMs: 3000, paymentMaxConcurrent: 4, paymentRequestsPerMinute: 60 });
});
