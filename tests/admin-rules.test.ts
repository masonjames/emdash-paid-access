// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from "vitest";
import { AGENTS_PAY_WARNING, answers, policyFromAnswers } from "../src/admin/shared.js";
import { action, admin, editor, fixture, flatten, page, paid, rule, submit } from "./fixtures/admin.js";

describe("two questions", () => {
	it.each([["anyone", "free", "public"], ["anyone", "pay", "agents-pay"], ["members", "pay", "members"], ["members", "subscribers", "members-only"]] as const)("maps %s + %s", (people, agents, policy) => {
		expect(policyFromAnswers(people, agents)).toBe(policy); expect(answers(policy)).toEqual({ people, agents });
	});
	it.each([
		["anyone", "subscribers", "A free post can't be limited to subscriber tokens. Choose Free or Pay per read for agents."],
		["members", "free", "Members-only posts can't be free for AI agents. Choose Pay per read or Only readers' agents."],
	])("rejects %s + %s without changing saved rules", async (people, agents, message) => {
		expect(() => policyFromAnswers(people, agents)).toThrow(message);
		const ctx = fixture(paid); await ctx.storage.restrictions.put("posts:1", rule);
		const result = await editor(ctx, submit("editor:save", { people, agents }));
		expect(result.toast).toEqual({ type: "error", message }); expect(await ctx.storage.restrictions.get("posts:1")).toEqual(rule);
		const taxonomy = await admin(ctx, submit("rules:taxonomy:save:category", { term: "premium", people, agents }));
		expect(taxonomy.toast).toEqual({ type: "error", message }); expect(ctx.storage.taxonomy_restrictions.data.size).toBe(0);
	});
});

describe("rules page", () => {
	it("renders the empty state, content links, summaries and warnings", async () => {
		const ctx = fixture(); expect(JSON.stringify(await admin(ctx, page("/rules")))).toContain("No rules yet");
		await ctx.storage.restrictions.put("posts:1", rule);
		const result = await admin(ctx, page("/rules")); expect(JSON.stringify(result)).not.toContain("No rules yet");
		expect(result.blocks.find(b => b.type === "stats")).toMatchObject({ items: [{ value: 1 }, { value: 1 }, { value: 0 }] });
		expect(result.blocks.find(b => b.type === "table")).toMatchObject({ rows: [{ post: { type: "link", label: "Hello · hello", target: { kind: "content", collection: "posts", id: "1" } }, people: "Anyone", agents: "$0.05 per read" }] });
		expect(JSON.stringify(result)).toContain(AGENTS_PAY_WARNING);
	});
	it("uses two steps for taxonomy selection, validates the term and saves a rule", async () => {
		const ctx = fixture(paid);
		const selected = await admin(ctx, submit("rules:taxonomy:choose", { taxonomy: "category" }));
		expect(flatten(selected.blocks).find(b => b.type === "form" && b.submit.action_id === "rules:taxonomy:save:category")).toMatchObject({ fields: expect.arrayContaining([{ type: "combobox", action_id: "term", label: "Term", options: [{ value: "premium", label: "Premium" }] }]) });
		const values = { people: "anyone", agents: "pay", price: "$0.05", term: "premium" };
		expect((await admin(ctx, submit("rules:taxonomy:save:category", { ...values, term: "wrong" }))).toast?.type).toBe("error");
		const result = await admin(ctx, submit("rules:taxonomy:save:category", values)); expect(result.toast?.type).toBe("success");
		expect(JSON.stringify(result)).toContain(AGENTS_PAY_WARNING);
		expect(await ctx.storage.taxonomy_restrictions.get("category:premium")).toMatchObject({ policy: "agents-pay", agentPrice: "$0.05" });
		const value = JSON.stringify({ type: "taxonomy", taxonomyName: "category", termId: "premium" });
		expect(JSON.stringify(await admin(ctx, action("rules:confirm-remove", value)))).toContain("Remove this rule?");
		expect(ctx.storage.taxonomy_restrictions.data.size).toBe(1);
		await admin(ctx, action("rules:remove", value)); expect(ctx.storage.taxonomy_restrictions.data.size).toBe(0);
	});
	it("paginates posts and counts all rules beyond the storage page size", async () => {
		const ctx = fixture(); for (let i = 0; i < 205; i++) await ctx.storage.restrictions.put(`posts:${i}`, { ...rule, contentId: String(i), policy: i % 2 ? "members" : "agents-pay" });
		const result = await admin(ctx, page("/rules")); const more = result.blocks.find(b => b.type === "actions");
		expect(result.blocks.find(b => b.type === "stats")).toMatchObject({ items: [{ value: 205 }, { value: 205 }, { value: 102 }] });
		expect(more).toMatchObject({ elements: [{ label: "Load more", action_id: "rules:more", value: "25" }] });
		const next = await admin(ctx, action("rules:more", "25")); expect(next.blocks.find(b => b.type === "table")).toMatchObject({ rows: expect.arrayContaining([expect.objectContaining({ post: expect.objectContaining({ target: expect.objectContaining({ id: "25" }) }) })]) });
	});
});

describe("editor panel", () => {
	it("loads with modules off, saves from the host identity, and removes the saved rule", async () => {
		const ctx = fixture();
		const initial = await editor(ctx, { type: "panel_load" }); expect(initial.blocks[0]).toMatchObject({ fields: [{ label: "People", value: "Anyone" }, { label: "AI agents", value: "Off" }] });
		expect(JSON.stringify(initial)).toContain("AI agent sales are off for this site.");
		const saved = await editor(ctx, submit("editor:save", { people: "anyone", agents: "pay", price: "$0.05", contentId: "forged", title: "forged" }));
		expect(saved.toast).toEqual({ type: "success", message: "Saved. Readers see the change on their next visit." });
		expect(await ctx.storage.restrictions.get("posts:1")).toMatchObject({ policy: "agents-pay", slug: "hello", title: "Hello" });
		expect(JSON.stringify(saved)).toContain(AGENTS_PAY_WARNING); expect(ctx.storage.restrictions.data.has("posts:forged")).toBe(false);
		await editor(ctx, action("editor:remove")); expect(ctx.storage.restrictions.data.size).toBe(0);
	});
	it("uses conditional price and plans fields with names and published agent URLs", async () => {
		const ctx = fixture({ ...paid, humansPlans: [{ slug: "premium", name: "Premium", stripeProductId: "prod_one", grantsVisibility: [] }] });
		const result = await editor(ctx, submit("editor:save", { people: "members", agents: "pay", price: "$0.05", plans: ["premium"] }));
		const fields = result.blocks.find(b => b.type === "form"); expect(fields).toMatchObject({ fields: expect.arrayContaining([
			expect.objectContaining({ action_id: "price", placeholder: "$0.05", condition: { field: "agents", eq: "pay" } }),
			expect.objectContaining({ action_id: "plans", condition: { field: "people", eq: "members" }, options: [{ value: "premium", label: "Premium" }] }),
		]) });
		expect(JSON.stringify(result)).toContain("/agents/posts/hello.md"); expect(JSON.stringify(result)).toContain("Member access is off");
		const invalid = await editor(ctx, submit("editor:save", { people: "members", agents: "pay", price: "bad", plans: ["premium"] })); expect(invalid.toast?.type).toBe("error"); expect(await ctx.storage.restrictions.get("posts:1")).toMatchObject({ agentPrice: "$0.05" });
	});
	it("shows inherited and legacy rules and clears legacy keys only on removal", async () => {
		const ctx = fixture(paid); await ctx.storage.restrictions.put("posts:hello", { ...rule, policy: "members" });
		await ctx.storage.taxonomy_restrictions.put("category:premium", { taxonomyName: "category", termId: "premium", policy: "members-only", createdAt: rule.createdAt });
		const result = await editor(ctx, { type: "panel_load" }); expect(JSON.stringify(result)).toContain("Also covered by Category: Premium"); expect(JSON.stringify(result)).toContain("An older Paid Access rule also covers this post"); expect(JSON.stringify(result)).not.toContain("Agents can buy it at");
		await editor(ctx, action("editor:remove")); expect(ctx.storage.restrictions.data.size).toBe(0); expect(ctx.storage.taxonomy_restrictions.data.size).toBe(1);
	});
});

it("explains an empty taxonomy and protects errors from exposing internal details", async () => {
	const ctx = fixture(); ctx.taxonomies.getTerms = async () => [];
	expect(JSON.stringify(await admin(ctx, submit("rules:taxonomy:choose", { taxonomy: "category" })))).toContain("Add a term under Categories");
	ctx.storage.restrictions.put = async () => { throw new Error("private internal detail"); };
	const failed = await editor(ctx, submit("editor:save", { people: "anyone", agents: "free" }));
	expect(failed.toast?.type).toBe("error"); expect(JSON.stringify(failed)).not.toContain("private internal detail");
	await ctx.kv.set("state:legacyPluginPresent", true);
	expect(JSON.stringify(await editor(ctx, { type: "panel_load" }))).toContain("Review its rule in the Restrict panel");
});
