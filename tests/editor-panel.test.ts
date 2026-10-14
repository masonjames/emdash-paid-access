import type { BlockResponse } from "@emdash-cms/blocks";
import { describe, expect, it, vi } from "vitest";
import { editor, fixture, paid, rule } from "./fixtures/admin.js";
import plugin from "../src/plugin.js";

const plan = { slug: "premium", name: "Premium", stripeProductId: "prod_one", grantsVisibility: [] };
const load = (ctx: ReturnType<typeof fixture>) => editor(ctx, { type: "panel_load" });
function form(panel: BlockResponse) {
	const found = panel.blocks.find(b => b.type === "form");
	if (!found || found.type !== "form") throw new Error("Missing native form");
	return found;
}
const save = (ctx: ReturnType<typeof fixture>, panel: BlockResponse, values: Record<string, unknown>) => editor(ctx, { type: "form_submit", block_id: form(panel).block_id, action_id: form(panel).submit.action_id, values });
const get = (ctx: ReturnType<typeof fixture>) => ctx.storage.restrictions.get("posts:1");
const currentPreset = (panel: BlockResponse) => form(panel).fields.find(f => f.action_id === "preset");

describe("native complete policy form", () => {
	it("shows a safe recovery message for malformed or unreadable stored rules", async () => {
		const ctx = fixture(paid);
		await ctx.storage.restrictions.put("posts:1", { contentId: "1", collectionSlug: "posts" });
		const panel = await load(ctx);
		expect(JSON.stringify(panel)).toContain("Advanced rules");
		expect(panel.blocks.some(b => b.type === "form")).toBe(false);
		vi.spyOn(ctx.storage.restrictions, "getVersioned").mockRejectedValue(new Error("secret storage detail"));
		const failed = await load(ctx);
		expect(JSON.stringify(failed)).not.toContain("secret storage detail");
		expect(JSON.stringify(failed)).toContain("could not be loaded safely");
	});
	it("uses actual Block Kit form contracts with stable field IDs and eq conditionals", async () => {
		const ctx = fixture({ ...paid, humansMode: "stripe", humansPlans: [plan] });
		const panel = await load(ctx);
		expect(form(panel).submit).toEqual({ action_id: "editor:save", label: "Save access" });
		expect(currentPreset(panel)).toMatchObject({ initial_value: "defaults", options: expect.arrayContaining([{ value: "public", label: "Public — free machine-readable copy" }, { value: "members", label: "Members or paid read" }]) });
		expect(form(panel).fields.find(f => f.action_id === "price_members")).toMatchObject({ condition: { field: "preset", eq: "members" } });
		expect(form(panel).fields.find(f => f.action_id === "plans_members-only")).toMatchObject({ condition: { field: "preset", eq: "members-only" } });
		expect(JSON.stringify(panel)).not.toContain("AI agents");
		expect(JSON.stringify(panel)).toContain("field list is unverified");
		const cas = vi.spyOn(ctx.storage.restrictions, "compareAndSet");
		const kv = vi.spyOn(ctx.kv, "compareAndSet");
		const result = await save(ctx, panel, { preset: "members", price_members: "0.12", plans_members: ["premium"], contentId: "forged", policy: "public" });
		expect(result.toast?.type).toBe("success");
		expect(await get(ctx)).toMatchObject({ collectionSlug: "posts", contentId: "1", policy: "members", agentPrice: "$0.12", requiredPlanSlugs: ["premium"], productIds: [], passEligible: false });
		expect(cas).toHaveBeenCalledTimes(1); expect(kv).not.toHaveBeenCalled();
		expect(form(result).fields.map(f => f.action_id)).toEqual(form(panel).fields.map(f => f.action_id));
		expect(form(result).block_id).not.toBe(form(panel).block_id);
		expect(result.toast?.message).toContain("Access saved.");
	});

	it("distinguishes defaults, explicit free, and inherited strongest rules", async () => {
		const ctx = fixture(paid);
		expect(JSON.stringify(await load(ctx))).toContain("Not offered");
		const free = await save(ctx, await load(ctx), { preset: "public" });
		expect(await get(ctx)).toMatchObject({ policy: "public", agentPrice: null });
		expect(JSON.stringify(free)).toContain("Free copy");
		await ctx.storage.taxonomy_restrictions.put("category:premium", { taxonomyName: "category", termId: "premium", policy: "members-only" });
		const inherited = await load(ctx);
		expect(JSON.stringify(inherited)).toContain("Inherited from category:premium");
		expect(inherited.blocks).toEqual(expect.arrayContaining([{ type: "context", text: "Website access: Members only" }, { type: "context", text: "Machine-readable copy (saved policy): Not offered" }]));
		const del = vi.spyOn(ctx.storage.restrictions, "compareAndDelete");
		await save(ctx, inherited, { preset: "defaults" });
		expect(await get(ctx)).toBeNull(); expect(del).toHaveBeenCalledTimes(1);
		expect(ctx.storage.taxonomy_restrictions.data.size).toBe(1);
		const defaults = fixture({ ...paid, agentsFreeByDefault: true });
		expect(currentPreset(await load(defaults))).toMatchObject({ initial_value: "defaults" });
		expect(JSON.stringify(await load(defaults))).toContain("Free copy");
	});

	it("keeps typed values and revision on invalid input; rejects hidden forged plans", async () => {
		const ctx = fixture({ ...paid, humansMode: "stripe", humansPlans: [plan] });
		const panel = await load(ctx);
		const invalid = await save(ctx, panel, { preset: "agents-pay", "price_agents-pay": "bad" });
		expect(invalid.toast?.type).toBe("error"); expect(await get(ctx)).toBeNull();
		expect(form(invalid).block_id).toBe(form(panel).block_id);
		expect(form(invalid).fields.find(f => f.action_id === "price_agents-pay")).toMatchObject({ initial_value: "bad" });
		for (const values of [{ preset: "public", plans_members: ["unknown"] }, { preset: "members", price_members: "0.01", plans_members: "premium" }, { preset: "members-only", "plans_members-only": [] }, { preset: "bogus" }]) {
			expect((await save(ctx, panel, values)).toast?.type).toBe("error");
		}
		expect(await get(ctx)).toBeNull();
		const corrected = await save(ctx, invalid, { preset: "agents-pay", "price_agents-pay": "$0.05", price_members: "ignored hidden input" });
		expect(corrected.toast?.type).toBe("success");
		expect(JSON.stringify(corrected)).toContain("scrapers can still read it for free");
	});

	it("allows only one concurrent complete save and reloads the winner after CAS conflict", async () => {
		const ctx = fixture(paid); await ctx.storage.restrictions.put("posts:1", rule);
		const panel = await load(ctx);
		const original = ctx.storage.restrictions.compareAndSet;
		let release!: () => void;
		const barrier = new Promise<void>(resolve => { release = resolve; });
		let arrivals = 0;
		ctx.storage.restrictions.compareAndSet = async (...args) => { if (++arrivals === 2) release(); await barrier; return original(...args); };
		// Real SQLite CAS serializes at the write, not at the earlier load/validation.
		const results = await Promise.all([save(ctx, panel, { preset: "public" }), save(ctx, panel, { preset: "agents-pay", "price_agents-pay": "0.09" })]);
		expect(results.filter(r => r.toast?.type === "success")).toHaveLength(1);
		const stale = results.find(r => r.toast?.type === "error")!;
		expect(stale.toast?.message).toContain("Stored values reloaded");
		expect(currentPreset(stale)).toMatchObject({ initial_value: (await get(ctx) as { policy: string }).policy });
		expect(form(stale).block_id).not.toBe(form(panel).block_id);
	});

	it("does not let stale removal undo a newer rule", async () => {
		const ctx = fixture(paid); await ctx.storage.restrictions.put("posts:1", rule);
		const panel = await load(ctx);
		await save(ctx, panel, { preset: "public" });
		const stale = await save(ctx, panel, { preset: "defaults" });
		expect(stale.toast?.type).toBe("error"); expect(await get(ctx)).toMatchObject({ policy: "public" });
	});

	it("refuses legacy-only and mixed records without any mutation", async () => {
		for (const mixed of [false, true]) {
			const ctx = fixture(paid); const panel = await load(ctx);
			await ctx.storage.restrictions.put("posts:hello", { ...rule, policy: "members-only" });
			if (mixed) await ctx.storage.restrictions.put("posts:1", rule);
			const before = [...ctx.storage.restrictions.data];
			const blocked = await save(ctx, panel, { preset: "defaults" });
			expect(blocked.blocks.some(b => b.type === "form")).toBe(false);
			expect(JSON.stringify(blocked)).toContain("merge it with the entry-ID rule");
			expect([...ctx.storage.restrictions.data]).toEqual(before);
		}
	});

	it("keeps every native preset read-only until migration is complete", async () => {
		for (const restriction of [undefined, { policy: "public" }, { policy: "members", requiredPlanSlugs: ["premium"] }, { policy: "members-only" }, { policy: "agents-pay" }]) {
			const ctx = fixture(paid);
			const stalePanel = await load(ctx);
			if (restriction) await ctx.storage.restrictions.put("posts:1", { ...rule, ...restriction });
			await ctx.storage.taxonomy_restrictions.put("category:premium", { taxonomyName: "category", termId: "premium", policy: "members-only" });
			await ctx.settings.set("humansMode", "delegate");
			const before = [...ctx.storage.restrictions.data];
			const panel = await load(ctx);
			expect(panel.blocks.some(b => b.type === "form")).toBe(false);
			expect(JSON.stringify(panel)).toContain("Member access needs migration");
			for (const preset of ["defaults", "public", "agents-pay", "members", "members-only"]) {
				const result = await save(ctx, stalePanel, { preset, "price_agents-pay": "0.01", plans_members: ["premium"] });
				expect(result.toast?.message).toContain("Member access needs migration");
				expect(result.blocks.some(b => b.type === "form")).toBe(false);
				expect([...ctx.storage.restrictions.data]).toEqual(before);
			}
		}
	});

	it.each(["off", "stripe"])("locks a stale editor when historical %s delegation is discovered", async humansMode => {
		const ctx = fixture({ ...paid, humansMode }); const panel = await load(ctx);
		await ctx.kv.set("state:legacyPluginPresent", true);
		expect((await save(ctx, panel, { preset: "public" })).toast?.type).toBe("error");
		expect(await get(ctx)).toBeNull();
		expect(JSON.stringify(await load(ctx))).toContain("Member access needs migration");
	});

	it("revalidates actual provider changes before saving a stale form", async () => {
		const ctx = fixture(paid); const panel = await load(ctx);
		await ctx.settings.set("agentsMode", "off");
		expect((await save(ctx, panel, { preset: "agents-pay", "price_agents-pay": "0.01" })).toast?.type).toBe("error");
		expect(await get(ctx)).toBeNull();
	});

	it("preserves the native permission declaration and requires host entry identity", async () => {
		expect(plugin.routes?.["editor/paid-access"].permission).toBe("content:publish_any");
		const ctx = fixture(paid);
		ctx.content.get = async () => null as never;
		expect((await load(ctx)).toast?.type).toBe("error");
		expect(await get(ctx)).toBeNull();
	});

	it("retains typed values on write failure without leaking internal details", async () => {
		const ctx = fixture(paid); const panel = await load(ctx);
		ctx.storage.restrictions.compareAndSet = async () => { throw new Error("private internal detail"); };
		const failed = await save(ctx, panel, { preset: "agents-pay", "price_agents-pay": "0.02" });
		expect(failed.toast?.type).toBe("error"); expect(JSON.stringify(failed)).not.toContain("private internal detail");
		expect(form(failed).block_id).toBe(form(panel).block_id);
		expect(form(failed).fields.find(f => f.action_id === "price_agents-pay")).toMatchObject({ initial_value: "0.02" });
		expect(await get(ctx)).toBeNull();
	});
});
