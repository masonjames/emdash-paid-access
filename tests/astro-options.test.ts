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
	const hook = paidAccessAstro({ injectAccountRoutes }).hooks["astro:config:setup"]!;
	await hook({ injectRoute, addMiddleware, updateConfig } as unknown as Parameters<NonNullable<AstroIntegration["hooks"]["astro:config:setup"]>>[0]);
	expect(injectRoute.mock.calls.map(([route]) => route.pattern)).toEqual(["/agents/[collection]/[slug].md", "/agents/offers", ...(injectAccountRoutes ? ["sign-in", "verify", "logout", "checkout", "complete", "portal"].map(action => `/account/${action}`) : [])]);
	expect(addMiddleware).toHaveBeenCalledWith({ entrypoint: "emdash-paid-access/astro/middleware", order: "post" });
	const config = updateConfig.mock.calls[0][0]; expect(config.integrations[0].name).toBe("@emdash-cms/x402");
	expect(config.vite.plugins[0].load("\0virtual:paid-access/config")).toContain('"accountPath":"/account"');
});
