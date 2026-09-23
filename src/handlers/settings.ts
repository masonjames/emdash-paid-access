// Copyright 2026 Stranger Studios.
// Modified by Mason James, 2026-09-23.
// SPDX-License-Identifier: GPL-2.0-or-later

import { normalizeHumanPlans } from "../plans.js";
import type {
	AgentMode,
	AgentRail,
	HumanMode,
	PaidAccessSettings,
	StripeEnvironment,
} from "../types.js";
import { isRecord, uniqueStrings } from "../utils.js";
import { isEmailReady } from "./auth.js";

const AGENT_MODES: AgentMode[] = ["off", "tokens-only", "paid"];
const AGENT_RAILS: AgentRail[] = ["origin-x402", "gateway"];
const HUMAN_MODES: HumanMode[] = ["off", "stripe", "delegate"];
const NETWORKS = ["", "eip155:84532", "eip155:8453"] as const;

export const DEFAULT_AGENTS = {
	mode: "off" as const,
	rail: "origin-x402" as const,
	payTo: "",
	network: "" as const,
	edgeTrust: "none" as const,
};

export const DEFAULT_HUMANS = {
	mode: "off" as const,
	plans: [],
};

export function maskSecretKey(secretKey: string | null | undefined): string {
	return secretKey ? `sk_••••${secretKey.slice(-4)}` : "";
}

export function normalizeStripeEnvironment(value: unknown): StripeEnvironment {
	return value === "test" || value === "sandbox" ? "test" : "live";
}

function enumValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
	if (value == null) return fallback;
	if (typeof value === "string" && values.includes(value as T)) return value as T;
	throw new Error("Stored Paid Access settings are invalid.");
}

export function resolveRequiredProductIds(
	plans: PaidAccessSettings["humans"]["plans"],
	requiredPlanSlugs: string[],
): string[] {
	return uniqueStrings(
		requiredPlanSlugs.map((slug) => plans.find((plan) => plan.slug === slug)?.stripeProductId),
	);
}

export async function loadSettings(ctx: any): Promise<PaidAccessSettings> {
	const stripeSecretKey = (await ctx.kv.get("stripe_secret_key")) as string | null;
	const storedPlans = await ctx.kv.get("humans_plans");
	const plans = storedPlans == null ? [] : normalizeHumanPlans(storedPlans);
	if (!plans) throw new Error("Stored Paid Access plan settings are invalid.");

	return {
		agents: {
			mode: enumValue(await ctx.kv.get("agents_mode"), AGENT_MODES, DEFAULT_AGENTS.mode),
			rail: enumValue(await ctx.kv.get("agents_rail"), AGENT_RAILS, DEFAULT_AGENTS.rail),
			payTo: ((await ctx.kv.get("agents_pay_to")) as string | null) || "",
			network: enumValue(await ctx.kv.get("agents_network"), NETWORKS, DEFAULT_AGENTS.network),
			edgeTrust: ((await ctx.kv.get("agents_edge_trust")) as string | null) || "none",
		},
		humans: {
			mode: enumValue(await ctx.kv.get("humans_mode"), HUMAN_MODES, DEFAULT_HUMANS.mode),
			plans,
		},
		stripeSecretKey,
		stripeSecretKeyMasked: maskSecretKey(stripeSecretKey),
		stripePublishableKey: ((await ctx.kv.get("stripe_publishable_key")) as string | null) || "",
		stripeAccountId: ((await ctx.kv.get("stripe_account_id")) as string | null) || "",
		stripeEnvironment: normalizeStripeEnvironment(await ctx.kv.get("stripe_environment")),
		showExcerpts: (await ctx.kv.get("show_excerpts")) !== "false",
		emailConfigured: await isEmailReady(ctx),
		isConfigured: Boolean(stripeSecretKey),
	};
}

async function saveAgents(ctx: any, value: unknown): Promise<string | null> {
	if (!isRecord(value)) return "agents must be an object.";
	if (!AGENT_MODES.includes(value.mode as AgentMode)) return "Invalid agents.mode.";
	if (!AGENT_RAILS.includes(value.rail as AgentRail)) return "Invalid agents.rail.";
	if (!NETWORKS.includes(value.network as (typeof NETWORKS)[number])) return "Invalid agents.network.";
	if (typeof value.payTo !== "string") return "agents.payTo must be a string.";
	if (typeof value.edgeTrust !== "string") return "agents.edgeTrust must be a string.";
	if (value.mode === "paid" && (!/^0x[0-9a-fA-F]{40}$/.test(value.payTo.trim()) || !value.network)) {
		return "Paid agent access requires an EVM payTo address and network.";
	}
	if (value.rail === "gateway" && value.edgeTrust === "none") {
		return "Gateway rail requires a configured edgeTrust method.";
	}
	await Promise.all([
		ctx.kv.set("agents_mode", value.mode),
		ctx.kv.set("agents_rail", value.rail),
		ctx.kv.set("agents_pay_to", value.payTo.trim()),
		ctx.kv.set("agents_network", value.network),
		ctx.kv.set("agents_edge_trust", value.edgeTrust.trim() || "none"),
	]);
	return null;
}

async function saveHumans(ctx: any, value: unknown, legacyPluginPresent: boolean): Promise<string | null> {
	if (!isRecord(value)) return "humans must be an object.";
	if (!HUMAN_MODES.includes(value.mode as HumanMode)) return "Invalid humans.mode.";
	if (value.mode === "stripe" && legacyPluginPresent) {
		return "Stripe mode cannot be enabled while the legacy membership plugin is active. Use delegate mode.";
	}
	const plans = normalizeHumanPlans(value.plans);
	if (!plans) return "humans.plans must be a valid plan catalog with unique slugs.";
	await Promise.all([
		ctx.kv.set("humans_mode", value.mode),
		ctx.kv.set("humans_plans", plans),
	]);
	return null;
}

export async function settingsHandler(ctx: any) {
	if (ctx.request.method === "GET") {
		const { stripeSecretKey: _secretKey, ...settings } = await loadSettings(ctx);
		return settings;
	}

	if (ctx.request.method !== "POST") {
		return { ok: false, error: "Method not allowed." };
	}

	const body = isRecord(ctx.input) ? ctx.input : {};
	if (body.disconnect === true) {
		await Promise.all([
			ctx.kv.delete("stripe_secret_key"),
			ctx.kv.delete("stripe_publishable_key"),
			ctx.kv.delete("stripe_account_id"),
			ctx.kv.delete("stripe_environment"),
		]);
		return { ok: true, disconnected: true };
	}

	if (body.agents !== undefined) {
		const error = await saveAgents(ctx, body.agents);
		if (error) return { ok: false, error };
	}
	if (body.humans !== undefined) {
		const error = await saveHumans(ctx, body.humans, body.legacyPluginPresent === true);
		if (error) return { ok: false, error };
	}

	if (typeof body.stripeSecretKey === "string" && !body.stripeSecretKey.startsWith("sk_••••")) {
		await ctx.kv.set("stripe_secret_key", body.stripeSecretKey.trim());
	}
	if (typeof body.stripePublishableKey === "string" && !body.stripePublishableKey.startsWith("pk_••••")) {
		await ctx.kv.set("stripe_publishable_key", body.stripePublishableKey.trim());
	}
	if (typeof body.stripeAccountId === "string") {
		await ctx.kv.set("stripe_account_id", body.stripeAccountId.trim());
	}
	if (body.stripeEnvironment !== undefined) {
		await ctx.kv.set("stripe_environment", normalizeStripeEnvironment(body.stripeEnvironment));
	} else if (typeof body.stripeSecretKey === "string" && !body.stripeSecretKey.startsWith("sk_••••")) {
		await ctx.kv.set("stripe_environment", body.stripeSecretKey.startsWith("sk_test_") ? "test" : "live");
	}
	if (typeof body.showExcerpts === "boolean") {
		await ctx.kv.set("show_excerpts", String(body.showExcerpts));
	}

	return { ok: true };
}
