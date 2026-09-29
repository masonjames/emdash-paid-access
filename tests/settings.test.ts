// Copyright 2026 Stranger Studios.
// Modified by Mason James, 2026-09-23.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from "vitest";

import { loadSettings, settingsHandler } from "../src/handlers/settings.js";
import { MASONJAMES_PLANS } from "./fixtures/masonjames-plans.js";

function createCtx(options?: { kvSeed?: Record<string, unknown>; email?: { send: () => Promise<void> } }) {
	const kvStore = new Map<string, unknown>(Object.entries(options?.kvSeed ?? {}));

	return {
		kvStore,
		kv: {
			get: async <T>(key: string): Promise<T | null> => ((kvStore.get(key) as T | undefined) ?? null),
			set: async (key: string, value: unknown) => { kvStore.set(key, value); },
			delete: async (key: string) => { kvStore.delete(key); },
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
		});
		expect(settings.humans).toEqual({ mode: "off", plans: [] });
	});

	it("reports emailConfigured false when EmDash has no configured email provider", async () => {
		const settings = await loadSettings(
			createCtx({
				kvSeed: {
					stripe_secret_key: "sk_test_123",
				},
			}),
		);

		expect(settings.emailConfigured).toBe(false);
	});

	it("reports emailConfigured true when EmDash provides the email API", async () => {
		const settings = await loadSettings(
			createCtx({
				kvSeed: {
					stripe_secret_key: "sk_test_123",
				},
				email: {
					send: async () => undefined,
				},
			}),
		);

		expect(settings.emailConfigured).toBe(true);
	});

	it("loads a settings-defined plan catalog", async () => {
		const settings = await loadSettings(createCtx({ kvSeed: { humans_plans: MASONJAMES_PLANS } }));
		expect(settings.humans.plans.map((plan) => plan.slug)).toEqual([
			"free",
			"default-product",
			"content-personall-ai",
		]);
	});

	it("fails closed instead of accepting corrupt stored settings", async () => {
		await expect(loadSettings(createCtx({ kvSeed: { humans_mode: "surprise" } }))).rejects.toThrow(
			"Stored Paid Access settings are invalid.",
		);
		await expect(loadSettings(createCtx({ kvSeed: { humans_plans: { nope: true } } }))).rejects.toThrow(
			"Stored Paid Access plan settings are invalid.",
		);
	});

	it("refuses to save Stripe mode while the legacy plugin is present", async () => {
		const ctx: any = createCtx();
		ctx.request = new Request("https://site.test/_emdash/api/plugins/paid-access/admin/settings", { method: "POST" });
		ctx.input = {
			legacyPluginPresent: true,
			humans: { mode: "stripe", plans: MASONJAMES_PLANS },
		};

		await expect(settingsHandler(ctx)).resolves.toEqual({
			ok: false,
			error: "Stripe mode cannot be enabled while the legacy membership plugin is active. Use delegate mode.",
		});
		expect(ctx.kvStore.has("humans_mode")).toBe(false);
	});

	it("validates every section before the first write", async () => {
		const base = createCtx();
		const request = new Request("https://site.test/admin/settings", { method: "POST" });
		const agents = { mode: "off", rail: "origin-x402", network: "", payTo: "", edgeTrust: "none" };
		const ctx = { ...base, request, input: { agents, humans: { mode: "invalid", plans: [] } } };
		await expect(settingsHandler(ctx)).resolves.toMatchObject({ ok: false, error: "Invalid humans.mode." });
		expect(ctx.kvStore.size).toBe(0);
		await expect(settingsHandler({ ...base, request, input: { agents, stripeEnvironment: "invalid" } })).resolves.toMatchObject({ ok: false, error: "Invalid stripeEnvironment." });
		expect(ctx.kvStore.size).toBe(0);
	});
});
