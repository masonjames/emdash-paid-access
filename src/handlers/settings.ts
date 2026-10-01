// Copyright 2026 Stranger Studios.
// Modified by Mason James, 2026-09-23.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PluginContext } from "emdash/plugin";
import type { RouteContext } from "../types.js";

import { normalizeHumanPlans } from "../plans.js";
import type {
	AgentMode,
	AgentRail,
	HumanMode,
	PaidAccessSettings,
	StripeEnvironment,
} from "../types.js";
import { isRecord, sanitizeRedirectPath, uniqueStrings } from "../utils.js";
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
	freeByDefault: false,
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

function settingPath(value: unknown, fallback: string, trailingSlash: boolean): string {
	if (value == null) return fallback;
	if (typeof value !== "string" || !value || sanitizeRedirectPath(value, "") !== value || value.includes("..") || /[?#%]/.test(value)) {
		throw new Error("Invalid Paid Access route path.");
	}
	const path = value.replace(/\/+$/, "");
	if (!trailingSlash && !path) throw new Error("Choose an agent route prefix such as /agents.");
	return trailingSlash ? `${path}/` : path;
}

// While Restrict With Stripe is active, in any mode, this plugin can't see who it or the
// theme locks out, so agents never get a post free.
export async function agentsNeverFree(ctx: PluginContext, settings: PaidAccessSettings): Promise<boolean> {
	return settings.humans.mode === "delegate" || await ctx.kv?.get("state:legacyPluginPresent") === true;
}

export async function loadSettings(ctx: PluginContext): Promise<PaidAccessSettings> {
	const stripeSecretKey = (await ctx.settings.get("stripeSecretKey")) as string | null;
	const storedPlans = await ctx.settings.get("humansPlans");
	const plans = storedPlans == null ? [] : normalizeHumanPlans(storedPlans);
	if (!plans) throw new Error("Stored Paid Access plan settings are invalid.");

	return {
		agents: {
			mode: enumValue(await ctx.settings.get("agentsMode"), AGENT_MODES, DEFAULT_AGENTS.mode),
			rail: enumValue(await ctx.settings.get("agentsRail"), AGENT_RAILS, DEFAULT_AGENTS.rail),
			payTo: ((await ctx.settings.get("agentsPayTo")) as string | null) || "",
			network: enumValue(await ctx.settings.get("agentsNetwork"), NETWORKS, DEFAULT_AGENTS.network),
			edgeTrust: ((await ctx.settings.get("agentsEdgeTrust")) as string | null) || "none",
			freeByDefault: (await ctx.settings.get("agentsFreeByDefault")) === true,
		},
		humans: {
			mode: enumValue(await ctx.settings.get("humansMode"), HUMAN_MODES, DEFAULT_HUMANS.mode),
			plans,
		},
		stripeSecretKey,
		stripeSecretKeyMasked: maskSecretKey(stripeSecretKey),
		stripePublishableKey: ((await ctx.settings.get("stripePublishableKey")) as string | null) || "",
		stripeAccountId: ((await ctx.settings.get("stripeAccountId")) as string | null) || "",
		stripeEnvironment: normalizeStripeEnvironment(await ctx.settings.get("stripeEnvironment")),
		showExcerpts: ![false, "false"].includes((await ctx.settings.get("showExcerpts")) ?? true),
		accountPath: settingPath(await ctx.settings.get("accountPath"), "/account/", true),
		agentRoutePrefix: settingPath(await ctx.settings.get("agentRoutePrefix"), "/agents", false),
		emailConfigured: await isEmailReady(ctx),
		isConfigured: Boolean(stripeSecretKey),
	};
}

function validateAgents(value: unknown): string | null {
	if (!isRecord(value)) return "agents must be an object.";
	if (!AGENT_MODES.includes(value.mode as AgentMode)) return "Invalid agents.mode.";
	if (!AGENT_RAILS.includes(value.rail as AgentRail)) return "Invalid agents.rail.";
	if (!NETWORKS.includes(value.network as (typeof NETWORKS)[number])) return "Invalid agents.network.";
	if (typeof value.payTo !== "string") return "agents.payTo must be a string.";
	if (typeof value.edgeTrust !== "string") return "agents.edgeTrust must be a string.";
	if (value.freeByDefault !== undefined && typeof value.freeByDefault !== "boolean") return "agents.freeByDefault must be a boolean.";
	if (value.mode === "paid" && (!/^0x[0-9a-fA-F]{40}$/.test(value.payTo.trim()) || !value.network)) {
		return "Paid agent access requires an EVM payTo address and network.";
	}
	if (value.rail === "gateway" && (!value.edgeTrust.trim() || value.edgeTrust.trim() === "none")) {
		return "Gateway rail requires a configured edgeTrust method.";
	}
	return null;
}

function validateHumans(value: unknown, legacyPluginPresent: boolean): string | null {
	if (!isRecord(value)) return "humans must be an object.";
	if (!HUMAN_MODES.includes(value.mode as HumanMode)) return "Invalid humans.mode.";
	if (value.mode === "stripe" && legacyPluginPresent) {
		return "Stripe mode cannot be enabled while the legacy membership plugin is active. Use delegate mode.";
	}
	const plans = normalizeHumanPlans(value.plans);
	if (!plans) return "humans.plans must be a valid plan catalog with unique slugs.";
	return null;
}

export async function settingsHandler(routeCtx: RouteContext, ctx: PluginContext) {
	if (routeCtx.request.method === "GET") {
		const { stripeSecretKey: _secretKey, ...settings } = await loadSettings(ctx);
		return settings;
	}

	if (routeCtx.request.method !== "POST") {
		return { ok: false, error: "Method not allowed." };
	}

	const body = isRecord(routeCtx.input) ? routeCtx.input : {};
	const error = body.agents !== undefined ? validateAgents(body.agents) : null;
	const humanError = body.humans !== undefined ? validateHumans(body.humans, body.legacyPluginPresent === true || await ctx.kv?.get("state:legacyPluginPresent") === true) : null;
	if (error || humanError) return { ok: false, error: error || humanError };
	for (const field of ["stripeSecretKey", "stripePublishableKey", "stripeAccountId", "stripeEnvironment"] as const) {
		if (body[field] !== undefined && typeof body[field] !== "string") return { ok: false, error: `${field} must be a string.` };
	}
	if (body.stripeEnvironment !== undefined && !["live", "test", "sandbox"].includes(body.stripeEnvironment as string)) {
		return { ok: false, error: "Invalid stripeEnvironment." };
	}
	if (body.showExcerpts !== undefined && typeof body.showExcerpts !== "boolean") return { ok: false, error: "showExcerpts must be a boolean." };
	const paths: Record<string, string> = {};
	for (const field of ["accountPath", "agentRoutePrefix"] as const) {
		if (body[field] !== undefined) {
			try { paths[field] = settingPath(body[field], field === "accountPath" ? "/account/" : "/agents", field === "accountPath"); }
			catch { return { ok: false, error: `Invalid ${field}.` }; }
		}
	}
	// Both the runtime report and the older caller hint refuse double-gating.
	if (body.disconnect === true) {
		await Promise.all([
			ctx.settings.delete("stripeSecretKey"),
			ctx.settings.delete("stripePublishableKey"),
			ctx.settings.delete("stripeAccountId"),
			ctx.settings.delete("stripeEnvironment"),
		]);
		return { ok: true, disconnected: true };
	}

	// All input is validated before any write. Save the secret first: the host
	// rejects it before persistence if encryption is unavailable.
	try {
		if (typeof body.stripeSecretKey === "string" && body.stripeSecretKey.trim() !== "" && !body.stripeSecretKey.startsWith("sk_••••")) {
			await ctx.settings.set("stripeSecretKey", body.stripeSecretKey.trim());
		}
	} catch (error) {
		if ((isRecord(error) && error.code === "PLUGIN_SETTING_ENCRYPTION_KEY_MISSING") ||
			(error instanceof Error && error.message.includes("Plugin secret settings require EMDASH_ENCRYPTION_KEY"))) {
			return { ok: false, error: "Set EMDASH_ENCRYPTION_KEY on this site before saving a Stripe key." };
		}
		throw error;
	}

	if (body.agents !== undefined) {
		const value = body.agents as Record<string, string>;
		await Promise.all([
			ctx.settings.set("agentsMode", value.mode), ctx.settings.set("agentsRail", value.rail),
			ctx.settings.set("agentsPayTo", value.payTo.trim()), ctx.settings.set("agentsNetwork", value.network),
			ctx.settings.set("agentsEdgeTrust", value.edgeTrust.trim() || "none"),
			ctx.settings.set("agentsFreeByDefault", (body.agents as Record<string, unknown>).freeByDefault === true),
		]);
	}
	if (body.humans !== undefined) {
		const value = body.humans as Record<string, unknown>;
		await Promise.all([
			ctx.settings.set("humansMode", value.mode),
			ctx.settings.set("humansPlans", normalizeHumanPlans(value.plans)),
		]);
	}

	if (typeof body.stripePublishableKey === "string" && !body.stripePublishableKey.startsWith("pk_••••")) {
		await ctx.settings.set("stripePublishableKey", body.stripePublishableKey.trim());
	}
	if (typeof body.stripeAccountId === "string") {
		await ctx.settings.set("stripeAccountId", body.stripeAccountId.trim());
	}
	if (body.stripeEnvironment !== undefined) {
		await ctx.settings.set("stripeEnvironment", normalizeStripeEnvironment(body.stripeEnvironment));
	} else if (typeof body.stripeSecretKey === "string" && body.stripeSecretKey.trim() !== "" && !body.stripeSecretKey.startsWith("sk_••••")) {
		await ctx.settings.set("stripeEnvironment", body.stripeSecretKey.trim().startsWith("sk_test_") ? "test" : "live");
	}
	if (typeof body.showExcerpts === "boolean") {
		await ctx.settings.set("showExcerpts", body.showExcerpts);
	}

	for (const [key, value] of Object.entries(paths)) await ctx.settings.set(key, value);
	return { ok: true };
}
