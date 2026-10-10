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
	it("in delegate mode, taxonomy rules only price AI agents", async () => {
		const ctx = fixture({ ...paid, humansMode: "delegate" });
		const selected = JSON.stringify(await admin(ctx, submit("rules:taxonomy:choose", { taxonomy: "category" })));
		expect(selected).not.toContain('"action_id":"people"'); expect(selected).not.toContain("Not sold to agents");
		await admin(ctx, submit("rules:taxonomy:save:category", { term: "premium", people: "members", agents: "pay", price: "$0.05" }));
		expect(await ctx.storage.taxonomy_restrictions.get("category:premium")).toMatchObject({ policy: "agents-pay", agentPrice: "$0.05" });
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
	it("saves page rules for people only in every mode, including delegate", async () => {
		const plan = { slug: "premium", name: "Premium", stripeProductId: "prod_one", grantsVisibility: [] };
		for (const [seed, plans] of [[paid, []], [{ ...paid, humansMode: "stripe", humansPlans: [plan] }, ["premium"]], [{ ...paid, humansMode: "delegate", humansPlans: [plan] }, []]] as const) {
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

describe("editor panel", () => {
	type Panel = Awaited<ReturnType<typeof editor>>;
	type Control = { action_id: string; initial_value?: unknown; options?: Array<{ value: string; label: string }> };
	// Acts like the editor: finds a control on the panel on screen and sends its action.
	const control = (panel: Panel, kind: string) => panel.blocks.flatMap(b => b.type === "actions" ? b.elements as unknown as Control[] : []).find(e => e.action_id.startsWith(`editor:${kind}|`));
	const idFor = (panel: Panel, kind: string) => control(panel, kind)?.action_id ?? `editor:${kind}`;
	const act = (ctx: ReturnType<typeof fixture>, panel: Panel, kind: string, value?: unknown) => editor(ctx, action(idFor(panel, kind), value));
	const load = (ctx: ReturnType<typeof fixture>) => editor(ctx, { type: "panel_load" });
	const radioOptions = (panel: Panel, kind: string) => JSON.stringify(control(panel, kind) ?? {});
	const stored = (ctx: ReturnType<typeof fixture>) => ctx.storage.restrictions.get("posts:1");

	it("auto-saves from the host identity with modules off, and removes the rule", async () => {
		const ctx = fixture();
		const initial = await load(ctx); expect(initial.blocks[0]).toMatchObject({ fields: [{ label: "People", value: "Anyone" }, { label: "AI agents", value: "Off" }] });
		expect(JSON.stringify(initial)).toContain("AI agent sales are off for this site."); expect(JSON.stringify(initial)).toContain("Changes save as you make them.");
		// With agents off, a price isn't required, so "pay" saves straight away.
		const saved = await act(ctx, initial, "agents", "pay");
		expect(saved.toast).toEqual({ type: "success", message: "Saved. Readers see the change on their next visit." });
		expect(await stored(ctx)).toMatchObject({ policy: "agents-pay", slug: "hello", title: "Hello" });
		expect(JSON.stringify(saved)).toContain(AGENTS_PAY_WARNING); expect(ctx.storage.restrictions.data.has("posts:forged")).toBe(false);
		expect((await act(ctx, saved, "remove")).toast?.message).toBe("Rule removed. Site defaults and category or tag rules still apply."); expect(ctx.storage.restrictions.data.size).toBe(0);
	});
	it("shows a post without a rule as not offered, and offers only valid agent choices", async () => {
		const ctx = fixture(paid);
		const anyone = await load(ctx);
		expect(anyone.blocks[0]).toMatchObject({ fields: [{ label: "People", value: "Anyone" }, { label: "AI agents", value: "Not offered" }] });
		expect(radioOptions(anyone, "agents")).toContain('"initial_value":"none"'); expect(radioOptions(anyone, "agents")).toContain('"label":"Not offered"');
		expect((await act(ctx, anyone, "agents", "subscribers")).toast?.type).toBe("error"); expect(ctx.storage.restrictions.data.size).toBe(0);
		// A refused value claims nothing, so the same panel's next click still works.
		const members = await act(ctx, anyone, "people", "members");
		expect(await stored(ctx)).toMatchObject({ policy: "members-only" });
		expect(radioOptions(members, "agents")).toContain('"label":"Not sold to agents"'); expect(radioOptions(members, "agents")).not.toContain('"value":"free"');
		const defaults = fixture({ ...paid, agentsFreeByDefault: true });
		expect((await load(defaults)).blocks[0]).toMatchObject({ fields: [{ label: "People", value: "Anyone" }, { label: "AI agents", value: "Free (site default)" }] });
	});
	it("asks for a price before selling, saves it on blur, and keeps the saved price on a bad or blank one", async () => {
		const ctx = fixture(paid);
		const members = await act(ctx, await load(ctx), "people", "members");
		const choosePay = await act(ctx, members, "agents", "pay");
		expect(choosePay.toast?.type).toBe("info"); expect(idFor(choosePay, "price")).toMatch(/^editor:price\|.*\|pay$/);
		expect(await stored(ctx)).toMatchObject({ policy: "members-only" });
		const priced = await act(ctx, choosePay, "price", "$0.05");
		expect(priced.toast?.type).toBe("success"); expect(await stored(ctx)).toMatchObject({ policy: "members", agentPrice: "$0.05" });
		expect(JSON.stringify(priced)).toContain("/agents/posts/hello.md"); expect(JSON.stringify(priced)).toContain("Member access is off");
		const invalid = await act(ctx, priced, "price", "bad");
		expect(invalid.toast?.type).toBe("error"); expect(await stored(ctx)).toMatchObject({ agentPrice: "$0.05" });
		// A refused save remounts the controls, so they show what's saved.
		expect(JSON.stringify(invalid.blocks)).not.toContain('"block_id":"editor:price/0"');
		const blank = await act(ctx, invalid, "price", "  ");
		expect(blank.toast).toMatchObject({ type: "error", message: "Enter a price per read, or choose another option for AI agents." }); expect(await stored(ctx)).toMatchObject({ agentPrice: "$0.05" });
	});
	it("saves an audience change at once and keeps an unpriced Pay choice", async () => {
		const ctx = fixture(paid);
		const pay = await act(ctx, await load(ctx), "agents", "pay");
		const members = await act(ctx, pay, "people", "members");
		expect(await stored(ctx)).toMatchObject({ policy: "members-only" }); expect(idFor(members, "price")).toMatch(/\|pay$/);
		// A price blur left over from the Anyone panel can't undo the saved audience.
		expect((await act(ctx, pay, "price", "$0.06")).toast?.message).toContain("changed since the panel loaded");
		expect(await stored(ctx)).toMatchObject({ policy: "members-only" });
		await act(ctx, members, "price", "$0.05");
		expect(await stored(ctx)).toMatchObject({ policy: "members", agentPrice: "$0.05" });
	});
	it("refuses a stale action instead of undoing a newer save", async () => {
		const ctx = fixture(paid); await ctx.storage.restrictions.put("posts:1", rule);
		const panel = await load(ctx);
		// The price blur and the audience change leave the same panel; the audience change lands first.
		expect((await act(ctx, panel, "people", "members")).toast?.type).toBe("success");
		const late = await act(ctx, panel, "price", "$0.06");
		expect(late.toast?.message).toContain("changed since the panel loaded");
		expect(await stored(ctx)).toMatchObject({ policy: "members", agentPrice: "$0.05" });
	});
	it("lets a click follow an unchanged or refused price blur from the same panel", async () => {
		const ctx = fixture(paid); await ctx.storage.restrictions.put("posts:1", rule);
		const panel = await load(ctx);
		expect((await act(ctx, panel, "price", "$0.05")).toast).toBeUndefined();
		expect((await act(ctx, panel, "price", "bad")).toast?.message).toBe("Enter a price like $0.05, with at most six decimals.");
		expect((await act(ctx, panel, "agents", "free")).toast?.type).toBe("success"); expect(await stored(ctx)).toMatchObject({ policy: "public" });
	});
	it("accepts a price typed without the dollar sign", async () => {
		const ctx = fixture(paid); await ctx.storage.restrictions.put("posts:1", rule);
		expect((await act(ctx, await load(ctx), "price", "0.03")).toast?.type).toBe("success");
		expect(await stored(ctx)).toMatchObject({ agentPrice: "$0.03" });
	});
	it("refuses a leftover action even when the newer one saved nothing", async () => {
		const ctx = fixture(paid);
		const pay = await act(ctx, await load(ctx), "agents", "pay");
		expect((await act(ctx, pay, "agents", "none")).toast?.type).toBe("success"); expect(ctx.storage.restrictions.data.size).toBe(0);
		expect((await act(ctx, pay, "price", "$0.05")).toast?.message).toContain("changed since the panel loaded");
		expect(ctx.storage.restrictions.data.size).toBe(0);
	});
	it("shows what's saved, not Pay, after a price loses to a newer save", async () => {
		const ctx = fixture(paid);
		const pay = await act(ctx, await load(ctx), "agents", "pay");
		// Another writer saves Free for this post while the price is in flight.
		await ctx.storage.restrictions.put("posts:1", { ...rule, policy: "public", agentPrice: null });
		const late = await act(ctx, pay, "price", "$0.05");
		expect(late.toast?.message).toContain("changed since the panel loaded"); expect(control(late, "price")).toBeUndefined();
		expect(await stored(ctx)).toMatchObject({ policy: "public" });
	});
	it("clears the price when agents stop paying", async () => {
		const ctx = fixture(paid); await ctx.storage.restrictions.put("posts:1", { ...rule, agentPrice: "$0.50" });
		await act(ctx, await load(ctx), "agents", "free");
		expect(await stored(ctx)).toMatchObject({ policy: "public", agentPrice: null });
		const none = await act(ctx, await load(ctx), "agents", "none");
		expect(none.toast?.message).toBe("Rule removed. Site defaults and category or tag rules still apply."); expect(ctx.storage.restrictions.data.size).toBe(0);
	});
	it("lets members' plans be chosen when Stripe memberships are on, even while Pay waits for a price", async () => {
		const ctx = fixture({ ...paid, humansMode: "stripe", humansPlans: [{ slug: "premium", name: "Premium", stripeProductId: "prod_one", grantsVisibility: [] }] });
		const members = await act(ctx, await load(ctx), "people", "members");
		expect(idFor(members, "plans")).toMatch(/^editor:plans\|/); expect(JSON.stringify(members)).toContain('"label":"Premium"');
		const pay = await act(ctx, members, "agents", "pay");
		const planned = await act(ctx, pay, "plans", ["premium"]);
		expect(await stored(ctx)).toMatchObject({ policy: "members-only", requiredPlanSlugs: ["premium"] }); expect(idFor(planned, "price")).toMatch(/\|pay$/);
		await act(ctx, planned, "price", "$0.05");
		expect(await stored(ctx)).toMatchObject({ policy: "members", agentPrice: "$0.05", requiredPlanSlugs: ["premium"] });
	});
	it("in delegate mode only asks what AI agents get", async () => {
		const ctx = fixture({ ...paid, humansMode: "delegate" }); await ctx.kv.set("state:legacyPluginPresent", true);
		const loaded = await load(ctx); const text = JSON.stringify(loaded);
		expect(text).toContain("Restrict With Stripe decides who can read this post"); expect(text).not.toContain('"action_id":"editor:people'); expect(text).not.toContain("Review its rule in the Restrict panel");
		// Forged audience actions can't restrict people in delegate mode.
		expect((await editor(ctx, action(idFor(loaded, "agents").replace("editor:agents", "editor:people"), "members"))).toast?.type).toBe("error");
		expect((await editor(ctx, action(idFor(await load(ctx), "agents").replace(/\|[^|]*$/, "|members"), "none"))).toast?.type).not.toBe("error"); expect(ctx.storage.restrictions.data.size).toBe(0);
		const priced = await act(ctx, await act(ctx, await load(ctx), "agents", "pay"), "price", "$0.02");
		expect(await stored(ctx)).toMatchObject({ policy: "agents-pay", agentPrice: "$0.02" }); expect(JSON.stringify(priced)).not.toContain(AGENTS_PAY_WARNING);
		// Free isn't offered or accepted while another plugin decides who can read.
		expect(JSON.stringify(priced)).not.toContain('"value":"free"');
		expect((await act(ctx, priced, "agents", "free")).toast?.type).toBe("error"); expect(await stored(ctx)).toMatchObject({ policy: "agents-pay" });
		// A rule saved as free before delegation still gets the warning.
		await ctx.storage.restrictions.put("posts:1", { ...rule, policy: "public", agentPrice: null });
		expect(JSON.stringify(await load(ctx))).toContain("ignored while Restrict With Stripe is active");
	});
	it("shows inherited and legacy rules, allows only removal of a legacy rule, and guards it", async () => {
		const ctx = fixture(paid); await ctx.storage.restrictions.put("posts:hello", { ...rule, policy: "members" });
		await ctx.storage.taxonomy_restrictions.put("category:premium", { taxonomyName: "category", termId: "premium", policy: "members-only", createdAt: rule.createdAt });
		const result = await load(ctx); const text = JSON.stringify(result);
		expect(text).toContain("Also covered by Category: Premium"); expect(text).toContain("An older Paid Access rule also covers this post"); expect(text).not.toContain("Agents can buy it at");
		expect(control(result, "agents")).toBeUndefined();
		// A legacy rule that changed after the panel loaded isn't deleted from under it.
		await ctx.storage.restrictions.put("posts:hello", { ...rule, policy: "members-only" });
		expect((await act(ctx, result, "remove")).toast?.message).toContain("changed since the panel loaded"); expect(ctx.storage.restrictions.data.size).toBe(1);
		await act(ctx, await load(ctx), "remove"); expect(ctx.storage.restrictions.data.size).toBe(0); expect(ctx.storage.taxonomy_restrictions.data.size).toBe(1);
	});
});

it("explains an empty taxonomy and protects errors from exposing internal details", async () => {
	const ctx = fixture(); ctx.taxonomies.getTerms = async () => [];
	expect(JSON.stringify(await admin(ctx, submit("rules:taxonomy:choose", { taxonomy: "category" })))).toContain("Add a term under Categories");
	const panel = await editor(ctx, { type: "panel_load" });
	ctx.storage.restrictions.compareAndSet = async () => { throw new Error("private internal detail"); };
	const agents = JSON.stringify(panel.blocks).match(/"action_id":"(editor:agents\|[^"]*)"/)?.[1] ?? "";
	const failed = await editor(ctx, action(agents, "pay"));
	expect(failed.toast?.type).toBe("error"); expect(JSON.stringify(failed)).not.toContain("private internal detail");
	await ctx.kv.set("state:legacyPluginPresent", true);
	expect(JSON.stringify(await editor(ctx, { type: "panel_load" }))).toContain("Review its rule in the Restrict panel");
});
