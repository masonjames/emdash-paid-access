// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from "vitest";
import { coexistenceReport } from "../src/admin/index.js";
import { settingsHandler } from "../src/handlers/settings.js";
import { invoke } from "./fixtures/route.js";
import { action, admin, fixture, flatten, page, paid, submit } from "./fixtures/admin.js";

describe("settings screens", () => {
	it("renders three tabs and saves each independently", async () => {
		const ctx = fixture();
		const initial = await admin(ctx, page("/settings"));
		expect(initial.blocks.find(b => b.type === "tab")).toMatchObject({ panels: [{ label: "AI agents" }, { label: "Members" }, { label: "Advanced" }] });
		expect((await admin(ctx, submit("settings:agents:save", { agents_mode: "paid", agents_network: paid.agentsNetwork, agents_pay_to: paid.agentsPayTo }))).toast).toEqual({ type: "success", message: "Agent settings saved." });
		expect((await admin(ctx, submit("settings:members:save", { humans_mode: "stripe", stripe_secret_key: "sk_test_example", stripe_publishable_key: "pk_test_example", show_excerpts: false }))).toast?.message).toBe("Member settings saved.");
		expect((await admin(ctx, submit("settings:advanced:save", { agent_route_prefix: "/read", account_path: "/members/", rail: "origin-x402", edge_trust: "none" }))).toast?.message).toBe("Advanced settings saved.");
		expect(ctx.settings.data.get("agentsMode")).toBe("paid"); expect(ctx.settings.data.get("accountPath")).toBe("/members/");
		const result = await admin(ctx, submit("settings:members:save", { humans_mode: "stripe", stripe_secret_key: "", show_excerpts: true }));
		expect(result.toast?.type).toBe("success"); expect(ctx.settings.data.get("stripeSecretKey")).toBe("sk_test_example"); expect(ctx.settings.data.get("stripeEnvironment")).toBe("test");
		expect(JSON.stringify(result)).not.toContain("sk_test_example");
		expect(flatten(result.blocks).filter(b => b.type === "form").flatMap(b => b.fields)).toContainEqual(expect.objectContaining({ type: "secret_input", has_value: true }));
	});
	it("validates before writes, and preserves empty secrets on the shared API", async () => {
		const ctx = fixture({ stripeSecretKey: "sk_test_example", stripeEnvironment: "test" }); const before = [...ctx.settings.data];
		expect((await admin(ctx, submit("settings:agents:save", { agents_mode: "paid", agents_network: paid.agentsNetwork, agents_pay_to: "bad" }))).toast?.type).toBe("error");
		expect([...ctx.settings.data]).toEqual(before);
		for (const path of ["read", "/", "/a..b", "/a/../b"]) expect((await admin(ctx, submit("settings:advanced:save", { agent_route_prefix: path, account_path: "/account/", rail: "origin-x402" }))).toast?.type).toBe("error");
		await invoke(settingsHandler, { ...ctx, request: new Request("https://site.test/", { method: "POST" }), input: { stripeSecretKey: " " } });
		expect([...ctx.settings.data]).toEqual(before);
	});
	it("adds, edits, confirms and removes plans, rejecting duplicate IDs", async () => {
		const ctx = fixture({ humansMode: "stripe", stripeSecretKey: "sk_test_example" });
		const values = { slug: "all-access", name: "All access", product: "prod_one", monthly: "$5/month", yearly: "$50/year" };
		expect((await admin(ctx, submit("plans:add", values))).toast?.type).toBe("success");
		expect((await admin(ctx, submit("plans:add", values))).toast?.message).toContain("already exists");
		const edit = await admin(ctx, action("plans:menu:all-access", "edit"));
		expect(flatten(edit.blocks)).toContainEqual(expect.objectContaining({ type: "header", text: "Edit plan" }));
		expect(flatten(edit.blocks).find(b => b.type === "form" && b.submit.action_id === "plans:save:all-access")).toMatchObject({ fields: expect.arrayContaining([{ type: "combobox", action_id: "product", label: "Stripe product", initial_value: "prod_one", options: [{ value: "prod_one", label: "Membership" }] }]) });
		await admin(ctx, submit("plans:save:all-access", { ...values, slug: "tampered", name: "Updated" }));
		expect(ctx.settings.data.get("humansPlans")).toMatchObject([{ slug: "all-access", name: "Updated" }]);
		const confirmation = await admin(ctx, action("plans:menu:all-access", "remove"));
		expect(JSON.stringify(confirmation)).toContain("Remove this plan?"); expect(ctx.settings.data.get("humansPlans")).toHaveLength(1);
		await admin(ctx, action("plans:remove:all-access")); expect(ctx.settings.data.get("humansPlans")).toEqual([]);
	});
	it("disconnects through the deliberate confirmed button", async () => {
		const ctx = fixture({ stripeSecretKey: "sk_test_example" }); const screen = await admin(ctx, page("/settings"));
		expect(JSON.stringify(screen)).toContain("Disconnect Stripe?"); expect(JSON.stringify(screen)).not.toContain("sk_test_example");
		await admin(ctx, action("settings:disconnect")); expect(ctx.settings.data.has("stripeSecretKey")).toBe(false);
	});
	it("keeps tokens-only as a read-only status, refusing newly enabling it", async () => {
		const ctx = fixture({ agentsMode: "tokens-only" }); expect(JSON.stringify(await admin(ctx, page("/settings")))).toContain("Subscriber tokens only");
		await admin(ctx, submit("settings:agents:save", {})); expect(ctx.settings.data.get("agentsMode")).toBe("tokens-only");
		const off = fixture(); expect((await admin(off, submit("settings:agents:save", { agents_mode: "tokens-only" }))).toast?.type).toBe("error");
	});
	it("stores the private runtime hint and refuses Stripe on both admin and shared settings paths", async () => {
		const ctx = fixture(); const request = new Request("https://site.test/", { method: "POST" });
		expect(await invoke(coexistenceReport, { ...ctx, request, input: { legacyPluginPresent: "true" } })).toMatchObject({ ok: false });
		expect(await invoke(coexistenceReport, { ...ctx, request, input: { legacyPluginPresent: true } })).toEqual({ ok: true });
		const screen = await admin(ctx, page("/settings")); expect(JSON.stringify(screen)).toContain("Restrict With Stripe is active");
		const radio = flatten(screen.blocks).filter(b => b.type === "form").flatMap(b => b.fields).find(f => f.action_id === "humans_mode");
		expect(radio).toMatchObject({ options: [{ value: "off" }, { value: "delegate" }] });
		expect((await admin(ctx, submit("settings:members:save", { humans_mode: "stripe" }))).toast?.message).toContain("Use delegate mode");
		expect(await invoke(settingsHandler, { ...ctx, request, input: { humans: { mode: "stripe", plans: [] } } })).toMatchObject({ ok: false });
		expect(ctx.settings.data.size).toBe(0);
		await invoke(coexistenceReport, { ...ctx, request, input: { legacyPluginPresent: false } });
		expect((await admin(ctx, submit("settings:members:save", { humans_mode: "stripe" }))).toast?.type).toBe("success");
	});
});

it("renders with no products or a missing saved product, and supports block_id dispatch", async () => {
	const ctx = fixture({ humansMode: "stripe", stripeSecretKey: "sk_test_example" });
	ctx.http.fetch = async () => new Response(JSON.stringify({ data: [], has_more: false }));
	const result = await admin(ctx, page("/settings")); expect(JSON.stringify(result)).toContain("No Stripe products yet");
	const memberForm = flatten(result.blocks).find(b => b.type === "form" && b.submit.action_id === "settings:members:save");
	expect((await admin(ctx, { type: "form_submit", block_id: memberForm?.block_id, values: { humans_mode: "off" } })).toast?.message).toBe("Member settings saved.");
	await ctx.settings.set("humansMode", "stripe");
	await ctx.settings.set("humansPlans", [{ slug: "old", name: "Old", stripeProductId: "prod_removed", grantsVisibility: [] }]);
	expect(JSON.stringify(await admin(ctx, action("plans:menu:old", "edit")))).toContain("prod_removed (saved product)");
});

it("renders a previously enabled Stripe mode after a legacy runtime report", async () => {
	const ctx = fixture({ humansMode: "stripe" }); await ctx.kv.set("state:legacyPluginPresent", true);
	expect(JSON.stringify(await admin(ctx, page("/settings")))).toContain("Use migration mode");
});
