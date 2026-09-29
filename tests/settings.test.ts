// Copyright 2026 Stranger Studios.
// Modified by Mason James, 2026-09-23.
// SPDX-License-Identifier: GPL-2.0-or-later

import { invoke } from "./fixtures/route.js";

import { describe, expect, it } from "vitest";

import { loadSettings, settingsHandler } from "../src/handlers/settings.js";
import { MASONJAMES_PLANS } from "./fixtures/masonjames-plans.js";

function createCtx(options?: { settingsSeed?: Record<string, unknown>; email?: { send: () => Promise<void> } }) {
	const settingsStore = new Map<string, unknown>(Object.entries(options?.settingsSeed ?? {}));

	return {
		settingsStore,
		settings: {
			get: async <T>(key: string): Promise<T | null> => ((settingsStore.get(key) as T | undefined) ?? null),
			set: async (key: string, value: unknown) => { settingsStore.set(key, value); },
			delete: async (key: string) => { settingsStore.delete(key); },
		},
		email: options?.email,
	};
}

describe("loadSettings", () => {
	it("defaults both independent modules to off", async () => {
		const settings = await loadSettings(createCtx());

		expect(settings.agents).toEqual({
			mode: "off",
			rail: "origin-x402",
			payTo: "",
			network: "",
			edgeTrust: "none",
			freeByDefault: false,
		});
		expect(settings.humans).toEqual({ mode: "off", plans: [] });
	});

	it("reports emailConfigured false when EmDash has no configured email provider", async () => {
		const settings = await loadSettings(
			createCtx({
				settingsSeed: {
					stripeSecretKey: "sk_test_123",
				},
			}),
		);

		expect(settings.emailConfigured).toBe(false);
	});

	it("reports emailConfigured true when EmDash provides the email API", async () => {
		const settings = await loadSettings(
			createCtx({
				settingsSeed: {
					stripeSecretKey: "sk_test_123",
				},
				email: {
					send: async () => undefined,
				},
			}),
		);

		expect(settings.emailConfigured).toBe(true);
	});

	it("loads a settings-defined plan catalog", async () => {
		const settings = await loadSettings(createCtx({ settingsSeed: { humansPlans: MASONJAMES_PLANS } }));
		expect(settings.humans.plans.map((plan) => plan.slug)).toEqual([
			"free",
			"default-product",
			"content-personall-ai",
		]);
	});

	it("fails closed instead of accepting corrupt stored settings", async () => {
		await expect(loadSettings(createCtx({ settingsSeed: { humansMode: "surprise" } }))).rejects.toThrow(
			"Stored Paid Access settings are invalid.",
		);
		await expect(loadSettings(createCtx({ settingsSeed: { humansPlans: { nope: true } } }))).rejects.toThrow(
			"Stored Paid Access plan settings are invalid.",
		);
	});

	it("refuses to save Stripe mode while the legacy plugin is present", async () => {
		const ctx = {
			...createCtx(),
			request: new Request("https://site.test/admin/settings", { method: "POST" }),
			input: { legacyPluginPresent: true, humans: { mode: "stripe", plans: MASONJAMES_PLANS } },
		};

		await expect(invoke(settingsHandler, ctx)).resolves.toEqual({
			ok: false,
			error: "Stripe mode cannot be enabled while the legacy membership plugin is active. Use delegate mode.",
		});
		expect(ctx.settingsStore.has("humansMode")).toBe(false);
	});

	it("validates every section before the first write", async () => {
		const base = createCtx();
		const request = new Request("https://site.test/admin/settings", { method: "POST" });
		const agents = { mode: "off", rail: "origin-x402", network: "", payTo: "", edgeTrust: "none" };
		const ctx = { ...base, request, input: { agents, humans: { mode: "invalid", plans: [] } } };
		await expect(invoke(settingsHandler, ctx)).resolves.toMatchObject({ ok: false, error: "Invalid humans.mode." });
		expect(ctx.settingsStore.size).toBe(0);
		await expect(invoke(settingsHandler, { ...base, request, input: { agents, stripeEnvironment: "invalid" } })).resolves.toMatchObject({ ok: false, error: "Invalid stripeEnvironment." });
		expect(ctx.settingsStore.size).toBe(0);
	});
});


describe("standard settings storage", () => {
	it("uses ctx.settings and masks the secret on reads", async () => {
		const ctx = createCtx();
		const request = new Request("https://site.test/settings", { method: "POST" });
		await expect(invoke(settingsHandler, { ...ctx, request, input: { stripeSecretKey: "sk_test_example", accountPath: "/members", agentRoutePrefix: "/read/", showExcerpts: false, humans: { mode: "stripe", plans: MASONJAMES_PLANS } } })).resolves.toEqual({ ok: true });
		expect(ctx.settingsStore.get("stripeSecretKey")).toBe("sk_test_example");
		expect(ctx.settingsStore.get("humansPlans")).toHaveLength(3);
		const result = await invoke(settingsHandler, ctx);
		expect(result).toMatchObject({ stripeSecretKeyMasked: "sk_••••mple", accountPath: "/members/", agentRoutePrefix: "/read", showExcerpts: false });
		expect(result).not.toHaveProperty("stripeSecretKey");
	});
	it.each([Object.assign(new Error("Secret unavailable"), { code: "PLUGIN_SETTING_ENCRYPTION_KEY_MISSING" }), new Error("Plugin secret settings require EMDASH_ENCRYPTION_KEY")])("explains missing encryption without saving other settings", async (error) => {
		const ctx = createCtx();
		const settings = { ...ctx.settings, set: async () => { throw error; } };
		await expect(invoke(settingsHandler, { ...ctx, settings, request: new Request("https://site.test/settings", { method: "POST" }), input: { stripeSecretKey: "sk_test_example", humans: { mode: "stripe", plans: [] }, showExcerpts: false } })).resolves.toEqual({ ok: false, error: "Set EMDASH_ENCRYPTION_KEY on this site before saving a Stripe key." });
		expect(ctx.settingsStore.size).toBe(0);
	});
	it.each(["//evil.test", "/\\evil.test", "https://evil.test", "/members?next=bad", "/%2f/evil.test"])("rejects unsafe account and agent paths %s before writing", async (path) => {
		for (const key of ["accountPath", "agentRoutePrefix"]) {
			const ctx = createCtx();
			await expect(invoke(settingsHandler, { ...ctx, request: new Request("https://site.test/settings", { method: "POST" }), input: { [key]: path, stripeSecretKey: "sk_test_example" } })).resolves.toMatchObject({ ok: false });
			expect(ctx.settingsStore.size).toBe(0);
		}
	});
});
