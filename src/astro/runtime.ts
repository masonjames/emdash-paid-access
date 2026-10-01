// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type {} from "emdash/locals";
import type {} from "@emdash-cms/x402/locals";
import { ABSENT_TTL_MS, failClosedHumanDecision, probeLegacyPlugin, resolveHumanMode, unionAccessDecisions, type PublicPluginRouteHandler } from "../coexistence.js";
import type { AccessDecision, HumanMode, MemberSessionState } from "../types.js";
import type { HumanPlan } from "../plans.js";
import { isRecord } from "../utils.js";
import type { PaidAccessOptions } from "./options.js";

export type PluginLocals = { emdash?: { handlePluginApiRoute?: PublicPluginRouteHandler; handlePublicPluginApiRoute: PublicPluginRouteHandler } };
export type PluginResult<T> = { ok: true; data: T } | { ok: false; code: string };
export type HumanDecision = AccessDecision & { humanMode?: HumanMode; showExcerpts?: boolean; agentsSold?: boolean };
export type PublicPlan = Pick<HumanPlan, "slug" | "name" | "description" | "monthlyLabel" | "yearlyLabel" | "trialLabel">;
export type AccessInput = { collection: string; id: string; slug: string; requiredPlanSlugs?: string[] };

async function dispatch<T>(locals: PluginLocals, path: string, body: unknown, publicOnly: boolean, pluginId: string, request?: Request): Promise<PluginResult<T>> {
	try {
		if (publicOnly && !locals.emdash) return { ok: false, code: "UNAVAILABLE" };
		const method = ["plans", "offers"].includes(path) ? "GET" : "POST";
		const url = new URL(`/_emdash/api/plugins/${encodeURIComponent(pluginId)}/${path}`, request?.url ?? "https://paid-access.invalid");
		if (method === "GET" && isRecord(body)) for (const [key, value] of Object.entries(body)) if (value != null) url.searchParams.set(key, String(value));
		const headers = new Headers({ "Content-Type": "application/json" });
		// Only the legacy public API needs the browser cookie; the paid-access core receives an explicit token.
		if (pluginId !== "paid-access" && request?.headers.has("cookie")) headers.set("cookie", request.headers.get("cookie")!);
		const init = new Request(url, { method, headers, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });
		// Anonymous requests (every AI agent) only get EmDash's public dispatcher on
		// locals, so trusted calls to private routes fall back to the server-only runtime.
		const privateDispatch = locals.emdash?.handlePluginApiRoute;
		const result = publicOnly
			? await locals.emdash!.handlePublicPluginApiRoute.call(locals.emdash, pluginId, method, path, init)
			: privateDispatch
				? await privateDispatch.call(locals.emdash, pluginId, method, path, init)
				: await (await import("emdash/middleware")).withEmDashRuntime(runtime => runtime.handlePluginApiRoute(pluginId, method, path, init));
		if (!result.success) return { ok: false, code: isRecord(result.error) && typeof result.error.code === "string" ? result.error.code : "UNAVAILABLE" };
		if (!isRecord(result.data)) return { ok: false, code: "UNAVAILABLE" };
		const data = result.data;
		if (data.ok === false) return { ok: false, code: typeof data.code === "string" ? data.code : isRecord(data.error) && typeof data.error.code === "string" ? data.error.code : "UNAVAILABLE" };
		return { ok: true, data: data as T };
	} catch { return { ok: false, code: "UNAVAILABLE" }; }
}
export function callPlugin<T = Record<string, unknown>>(locals: PluginLocals, path: string, body: unknown, request?: Request): Promise<PluginResult<T>> {
	return dispatch(locals, path, body, false, "paid-access", request);
}
export function callPublicPlugin<T = Record<string, unknown>>(locals: PluginLocals, path: string, body: unknown, pluginId = "paid-access", request?: Request): Promise<PluginResult<T>> {
	return dispatch(locals, path, body, true, pluginId, request);
}

function validDecision(value: unknown): value is HumanDecision {
	return isRecord(value) && typeof value.restricted === "boolean" && typeof value.hasAccess === "boolean" && typeof value.authenticated === "boolean"
		&& (value.email === null || typeof value.email === "string") && Array.isArray(value.requiredPlanSlugs) && value.requiredPlanSlugs.every(v => typeof v === "string")
		&& Array.isArray(value.requiredProductIds) && value.requiredProductIds.every(v => typeof v === "string");
}
export function canRenderBody(decision: AccessDecision): boolean { return decision.hasAccess === true && !decision.error; }

let reported: Promise<boolean> | undefined;
let reportedAbsentAt = 0;
export function resetRuntimeForTests(): void { reported = undefined; reportedAbsentAt = 0; }

export function createPaidAccess(locals: PluginLocals, request: Request, sessionToken: string | null, options: Required<PaidAccessOptions>) {
	const memo = new Map<string, Promise<HumanDecision>>();
	async function probe(): Promise<boolean> {
		if (!locals.emdash) throw new Error("EmDash unavailable");
		// Recheck an "absent" answer once it's stale, and report the new one to the core.
		if (reportedAbsentAt && Date.now() - reportedAbsentAt > ABSENT_TTL_MS) { reported = undefined; reportedAbsentAt = 0; }
		reported ??= (async () => {
			const present = await probeLegacyPlugin((_id, method, path, req) => locals.emdash!.handlePublicPluginApiRoute(options.legacyPluginId, method, path, req), request);
			const result = await callPlugin(locals, "coexistence/report", { legacyPluginPresent: present }, request);
			if (!result.ok) throw new Error("Coexistence report unavailable");
			if (["off", "stripe", "delegate"].includes(String(result.data.humanMode))) resolveHumanMode(result.data.humanMode as HumanMode, present);
			reportedAbsentAt = present ? 0 : Date.now();
			return present;
		})().catch(error => { reported = undefined; throw error; });
		return reported;
	}
	async function access(input: AccessInput): Promise<HumanDecision> {
		try {
			const present = await probe();
			const body = { collection: input.collection, collectionSlug: input.collection, contentId: input.id, slug: input.slug, requiredPlanSlugs: input.requiredPlanSlugs, sessionToken };
			const result = await callPlugin(locals, "access", body, request);
			if (!result.ok || !validDecision(result.data) || result.data.error) return failClosedHumanDecision();
			const ours = result.data;
			const mode = resolveHumanMode(ours.humanMode ?? (ours.delegated ? "delegate" : "off"), present).mode;
			if (!ours.delegated && mode !== "delegate") return ours;
			const legacy = await callPublicPlugin(locals, "access", { ...body, sessionToken: undefined, requiredPlanSlugs: ours.requiredPlanSlugs, requiredProductIds: ours.requiredProductIds }, options.legacyPluginId, request);
			if (!legacy.ok || !validDecision(legacy.data) || legacy.data.error) return failClosedHumanDecision();
			const legacyDecision = legacy.data;
			// A legacy response must actually enforce our requirements, not silently drop unknown plans.
			const granted = legacyDecision.restricted && legacyDecision.authenticated && legacyDecision.hasAccess
				&& ours.requiredPlanSlugs.every(slug => legacyDecision.requiredPlanSlugs.includes(slug))
				&& ours.requiredProductIds.every(id => legacyDecision.requiredProductIds.includes(id));
			return { ...ours, ...unionAccessDecisions({ ...ours, hasAccess: !ours.restricted || granted }, legacy.data) };
		} catch { return failClosedHumanDecision(); }
	}
	return {
		options, sessionToken,
		/** Tell the core whether the legacy plugin is active. Throws when that can't be established. */
		detectLegacy: probe,
		access(input: AccessInput) {
			const key = JSON.stringify([input.collection, input.id, input.slug, input.requiredPlanSlugs ?? []]);
			if (!memo.has(key)) memo.set(key, access(input));
			return memo.get(key)!;
		},
		async session(): Promise<MemberSessionState> {
			try {
				await probe();
				const result = await callPlugin(locals, "auth/session", { sessionToken }, request);
				if (result.ok && result.data.authenticated === true && typeof result.data.email === "string") return { authenticated: true, email: result.data.email };
			} catch { /* An unavailable session is anonymous. */ }
			return { authenticated: false, email: null };
		},
		async plans(): Promise<PublicPlan[]> {
			const result = await callPublicPlugin(locals, "plans", {}, "paid-access", request);
			if (!result.ok || !Array.isArray(result.data.plans)) return [];
			return result.data.plans.filter((plan): plan is PublicPlan => isRecord(plan) && typeof plan.slug === "string" && typeof plan.name === "string"
				&& ["description", "monthlyLabel", "yearlyLabel", "trialLabel"].every(key => plan[key] == null || typeof plan[key] === "string"));
		},
	};
}
export type PaidAccessLocals = ReturnType<typeof createPaidAccess>;
declare global { namespace App { interface Locals { paidAccess: PaidAccessLocals } } }
