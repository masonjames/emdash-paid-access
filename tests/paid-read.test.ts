// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later
import { beforeEach, expect, it, vi } from "vitest";
import type { PluginContext } from "emdash/plugin";
import type { RouteContext } from "../src/types.js";
import { paidReadQuote } from "../src/handlers/paid-read.js";
const agentContext = vi.hoisted(() => vi.fn());
beforeEach(() => { agentContext.mockResolvedValue({ rules: [{ policy: "public" }], agents: { mode: "paid", rail: "origin-x402", freeByDefault: true }, price: null }); });
vi.mock("../src/handlers/agents.js", () => ({
 agentContextHandler: agentContext,
 recordReceiptHandler: vi.fn(),
}));
const route = { input: { collection: "posts", contentId: "p" } } as RouteContext;
function context() {
 return { content: { get: async () => ({ id: "p", slug: "p", status: "published" }) } } as unknown as PluginContext;
}
it("allows an explicitly public native quote", async () => {
 await expect(paidReadQuote(route, context())).resolves.toMatchObject({ price: null, resource: "posts:p" });
});
it("never issues a free quote when migration or policy resolution is unavailable", async () => {
 agentContext.mockResolvedValue({ ok: false, error: { code: "UNAVAILABLE" } });
 await expect(paidReadQuote(route, context())).rejects.toThrow("Agent policy unavailable");
});
