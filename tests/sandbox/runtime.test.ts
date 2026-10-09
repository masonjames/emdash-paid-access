// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, beforeEach, expect, it } from "vitest";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

let host: PluginRuntimeTestHost;
beforeEach(async () => { host = await createPluginRuntimeTestHost(); });
afterEach(async () => { await host?.dispose(); });

it("keeps payment context and receipt writes private through the production dispatcher", async () => {
 for (const name of ["agent/context", "receipts/record", "coexistence/report", "admin/settings"]) {
  const response = await host.actions.routes.request(name, { method: "POST", body: {} });
  expect(response.status).toBe(401);
 }
 expect(await host.inspect.storage.list("receipts")).toEqual([]);
});

it("requires admin permission and CSRF protection before settings writes", async () => {
 const admin = await host.fixtures.user({ email: "admin@example.test", role: "admin" });
 const editor = await host.fixtures.user({ email: "editor@example.test", role: "editor" });
 const body = { agentRoutePrefix: "/changed" };
 expect((await host.actions.routes.request("admin/settings", { method: "POST", user: admin, body })).status).toBe(403);
 expect((await host.actions.routes.request("admin/settings", { method: "POST", user: editor, headers: { "X-EmDash-Request": "1" }, body })).status).toBe(403);
 expect(await host.inspect.setting("agentRoutePrefix")).toBeNull();
 const allowed = await host.actions.routes.request("admin/settings", { method: "POST", user: admin, headers: { "X-EmDash-Request": "1" }, body });
 expect(allowed.status).toBe(200);
 expect(await host.inspect.setting("agentRoutePrefix")).toBe("/changed");
});

it("runs Block Kit settings in the isolate and preserves them after restart", async () => {
 const screen = await host.admin.loadPage("/settings");
 expect(screen.blocks.some(block => block.type === "tab")).toBe(true);
 const saved = await host.admin.submit("/settings", "settings:agents:save", {
  agents_mode: "paid", agents_network: "eip155:84532", agents_pay_to: `0x${"1".repeat(40)}`,
 });
 expect(saved.toast?.type).toBe("success");
 await host.restart();
 expect(await host.inspect.setting("agentsMode")).toBe("paid");
 expect(JSON.stringify(await host.admin.loadWidget("overview"))).toContain("Base Sepolia test network");
 const rejected = await host.admin.submit("/settings", "settings:advanced:save", {
  agent_route_prefix: "/agents", account_path: "/account/", rail: "gateway", edge_trust: "trusted-header",
 });
 expect(rejected.toast?.type).toBe("error");
 expect(await host.inspect.setting("agentsRail")).toBe("origin-x402");
});

it("queries each network separately through real plugin storage", async () => {
 const common = { entryId: "post", collectionSlug: "posts", slug: "hello", payer: `0x${"1".repeat(40)}`, rail: "origin-x402", transaction: `0x${"2".repeat(64)}`, createdAt: new Date().toISOString() };
 await host.fixtures.plugin.storage("receipts", "test", { ...common, amount: "$10", network: "eip155:84532" });
 await host.fixtures.plugin.storage("receipts", "live", { ...common, amount: "$1", network: "eip155:8453" });
 const live = await host.admin.loadPage("/receipts");
 expect(live.blocks.find(block => block.type === "stats")).toMatchObject({ items: [{ value: "$1.00" }, { value: 1 }, { value: 1 }, { value: "$1.00" }] });
 expect(live.blocks.find(block => block.type === "table")).toMatchObject({ rows: [{ network: "Base" }] });
 const test = await host.admin.act("/receipts", "receipts:test");
 expect(test.blocks.find(block => block.type === "stats")).toMatchObject({ items: [{ label: "Test USDC (30 days)", value: "$10.00" }, { value: 1 }, { value: 1 }, { value: "$10.00" }] });
 expect(test.blocks.find(block => block.type === "table")).toMatchObject({ rows: [{ network: "Base Sepolia" }] });
});
