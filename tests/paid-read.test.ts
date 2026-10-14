// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, it, vi } from "vitest";
import type { PluginContext } from "emdash/plugin";
import type { RouteContext } from "../src/types.js";
import { paidReadQuote } from "../src/handlers/paid-read.js";
vi.mock("../src/handlers/agents.js", () => ({
 agentContextHandler: async () => ({ rules: [{ policy: "public" }], agents: { mode: "paid", rail: "origin-x402", freeByDefault: true }, price: null }),
 recordReceiptHandler: vi.fn(),
}));
const route = { input: { collection: "posts", contentId: "p" } } as RouteContext;
function context(present: boolean | null) {
 return { content: { get: async () => ({ id: "p", slug: "p", status: "published" }) }, kv: { get: async () => present } } as unknown as PluginContext;
}
it.each([null, true])("rejects a free quote unless legacy absence was verified (%s)", async present => {
 await expect(paidReadQuote(route, context(present))).rejects.toThrow("Membership coexistence must be verified");
});
it("allows the configured free quote after verified legacy absence", async () => {
 await expect(paidReadQuote(route, context(false))).resolves.toMatchObject({ price: null, resource: "posts:p" });
});
