// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from "vitest";
import { AGENTS_PAY_WARNING, answers, policyFromAnswers } from "../src/admin/shared.js";
import { action, admin, fixture, flatten, page, paid, rule, submit } from "./fixtures/admin.js";

describe("two questions", () => {
	it.each([["anyone", "free", "public"], ["anyone", "pay", "agents-pay"], ["members", "pay", "members"], ["members", "subscribers", "members-only"]] as const)("maps %s + %s", (people, agents, policy) => {
		expect(policyFromAnswers(people, agents)).toBe(policy); expect(answers(policy)).toEqual({ people, agents });
	});
	it.each([
		["anyone", "subscribers", "For posts anyone can read, choose Free or Pay per read for AI agents. To offer agents nothing, remove the rule."],
		["members", "free", "Members-only posts can't be free for AI agents. Choose Pay per read or Not sold to agents."],
	])("rejects %s + %s without changing saved rules", async (people, agents, message) => {
		expect(() => policyFromAnswers(people, agents)).toThrow(message);
		const ctx = fixture(paid); await ctx.storage.restrictions.put("posts:1", rule);
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
	it.each(["delegate", "off", "stripe"])("blocks every rule mutation while %s requires migration", async humansMode => {
		const ctx = fixture({ ...paid, humansMode });
		if (humansMode !== "delegate") await ctx.kv.set("state:legacyPluginPresent", true);
		await ctx.storage.restrictions.put("posts:1", rule);
		const before = [...ctx.storage.restrictions.data];
		const screen = await admin(ctx, page("/rules"));
		expect(JSON.stringify(screen)).toContain("Member access needs migration");
		expect(flatten(screen.blocks).some(b => b.type === "form")).toBe(false);
		for (const input of [submit("rules:taxonomy:save:category", { term: "premium", people: "anyone", agents: "free" }), submit("rules:page:save:emvb_pages", { entry: "01PRICING" }), action("rules:remove", JSON.stringify({ collectionSlug: "posts", contentId: "1" }))]) {
			expect((await admin(ctx, input)).toast?.type).toBe("error");
		}
		expect([...ctx.storage.restrictions.data]).toEqual(before);
		expect(ctx.storage.taxonomy_restrictions.data.size).toBe(0);
	});
	it("adds a rule for a published page of a visual builder's collection", async () => {
		const ctx = fixture(paid);
		const start = await admin(ctx, page("/rules"));
		expect(flatten(start.blocks).find(b => b.type === "form" && b.submit.action_id === "rules:page:choose")).toMatchObject({ fields: [{ type: "text_input", action_id: "collection", initial_value: "emvb_pages" }] });
		expect(JSON.stringify(start)).toContain("A page rule takes effect only when the site's route for those pages checks Paid Access.");
		const chosen = await admin(ctx, submit("rules:page:choose", { collection: "emvb_pages" }));
		// Drafts aren't offered, and a translation shows its locale.
		expect(flatten(chosen.blocks).find(b => b.type === "form" && b.submit.action_id === "rules:page:save:emvb_pages")).toMatchObject({ fields: [{ type: "combobox", action_id: "entry", label: "Page", options: [{ value: "01PRICING", label: "Pricing · pricing" }, { value: "01TARIFS", label: "Tarifs · pricing · fr" }] }] });
		const result = await admin(ctx, submit("rules:page:save:emvb_pages", { entry: "01PRICING" }));
		expect(result.toast).toEqual({ type: "success", message: "Rule saved. A page rule takes effect only when the site's route for those pages checks Paid Access." });
		expect(await ctx.storage.restrictions.get("emvb_pages:01PRICING")).toMatchObject({ collectionSlug: "emvb_pages", contentId: "01PRICING", slug: "pricing", title: "Pricing", policy: "members-only", agentPrice: null });
		expect(result.blocks.find(b => b.type === "table")).toMatchObject({ rows: [{ post: { label: "Pricing · pricing", target: { kind: "content", collection: "emvb_pages", id: "01PRICING" } }, people: "Members only", agents: "Not sold" }] });
	});
	it("saves page rules for people only in off and Stripe modes", async () => {
		const plan = { slug: "premium", name: "Premium", stripeProductId: "prod_one", grantsVisibility: [] };
		for (const [seed, plans] of [[paid, []], [{ ...paid, humansMode: "stripe", humansPlans: [plan] }, ["premium"]]] as const) {
			const ctx = fixture(seed);
			const form = JSON.stringify(await admin(ctx, submit("rules:page:choose", { collection: "emvb_pages" })));
			expect(form).not.toContain('"action_id":"agents"'); expect(form).not.toContain('"action_id":"people"');
			// Forged agent answers are ignored.
			expect((await admin(ctx, submit("rules:page:save:emvb_pages", { entry: "01PRICING", people: "anyone", agents: "pay", price: "$0.05", plans: ["premium"] }))).toast?.type).toBe("success");
			expect(await ctx.storage.restrictions.get("emvb_pages:01PRICING")).toMatchObject({ policy: "members-only", agentPrice: null, requiredPlanSlugs: plans });
		}
	});
	it("refuses to overwrite an existing page rule from a stale form", async () => {
		const ctx = fixture({ ...paid, humansMode: "stripe", humansPlans: [{ slug: "premium", name: "Premium", stripeProductId: "prod_one", grantsVisibility: [] }] });
		const existing = { ...rule, collectionSlug: "emvb_pages", contentId: "01PRICING", slug: "pricing", title: "Pricing", policy: "members-only", agentPrice: null, requiredPlanSlugs: ["premium"] };
		await ctx.storage.restrictions.put("emvb_pages:01PRICING", existing);
		const result = await admin(ctx, submit("rules:page:save:emvb_pages", { entry: "01PRICING", people: "anyone", agents: "free", plans: ["premium"] }));
		expect(result.toast).toEqual({ type: "error", message: "A rule already exists for this page. Remove it from the table first, then add it again." });
		expect(await ctx.storage.restrictions.get("emvb_pages:01PRICING")).toEqual(existing);
	});
	it("refuses a page rule with no plan in stripe mode", async () => {
		const ctx = fixture({ ...paid, humansMode: "stripe", humansPlans: [{ slug: "premium", name: "Premium", stripeProductId: "prod_one", grantsVisibility: [] }] });
		for (const values of [{ entry: "01PRICING" }, { entry: "01PRICING", plans: [] }, { entry: "01PRICING", plans: "premium" }]) {
			expect((await admin(ctx, submit("rules:page:save:emvb_pages", values))).toast).toEqual({ type: "error", message: "Choose at least one plan. A page rule without a plan can't grant access to anyone." });
		}
		expect(ctx.storage.restrictions.data.size).toBe(0);
	});
	it("offers no page form in stripe mode until a plan exists", async () => {
		const ctx = fixture({ ...paid, humansMode: "stripe", humansPlans: [] });
		const chosen = await admin(ctx, submit("rules:page:choose", { collection: "emvb_pages" }));
		expect(flatten(chosen.blocks).some(b => b.type === "form" && b.submit.action_id === "rules:page:save:emvb_pages")).toBe(false);
		expect(JSON.stringify(chosen)).toContain("Add a plan under Paid Access → Settings → Members first.");
		// A stale form from before the plans were removed can't save an unusable rule either.
		expect((await admin(ctx, submit("rules:page:save:emvb_pages", { entry: "01PRICING" }))).toast?.type).toBe("error");
		expect(ctx.storage.restrictions.data.size).toBe(0);
	});
	it("refuses a page rule for an entry outside the chosen collection's published list", async () => {
		const ctx = fixture(paid); const values = { people: "anyone", agents: "pay", price: "$0.05" };
		// A draft, a post from another collection, nothing, and an unknown collection.
		for (const [name, entry] of [["emvb_pages", "01DRAFT"], ["emvb_pages", "1"], ["emvb_pages", ""], ["missing", "01PRICING"]]) {
			expect((await admin(ctx, submit(`rules:page:save:${name}`, { ...values, entry }))).toast).toEqual({ type: "error", message: "Choose a published page in this collection, then save again." });
		}
		expect(ctx.storage.restrictions.data.size).toBe(0);
		expect(JSON.stringify(await admin(ctx, submit("rules:page:choose", { collection: "missing" })))).toContain("Couldn't read the collection missing.");
	});
	it("paginates posts and counts all rules beyond the storage page size", async () => {
		const ctx = fixture(); for (let i = 0; i < 205; i++) await ctx.storage.restrictions.put(`posts:${i}`, { ...rule, contentId: String(i), policy: i % 2 ? "members" : "agents-pay" });
		const result = await admin(ctx, page("/rules")); const more = result.blocks.find(b => b.type === "actions");
		expect(result.blocks.find(b => b.type === "stats")).toMatchObject({ items: [{ value: 205 }, { value: 205 }, { value: 102 }] });
		expect(more).toMatchObject({ elements: [{ label: "Load more", action_id: "rules:more", value: "25" }] });
		const next = await admin(ctx, action("rules:more", "25")); expect(next.blocks.find(b => b.type === "table")).toMatchObject({ rows: expect.arrayContaining([expect.objectContaining({ post: expect.objectContaining({ target: expect.objectContaining({ id: "25" }) }) })]) });
	});
});
