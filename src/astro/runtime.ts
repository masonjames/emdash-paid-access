// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later


import { resolveReaderAccess } from "../resolver.js";
import type {} from "emdash/locals";
import type {} from "@emdash-cms/x402/locals";
import { failClosedHumanDecision, unionAccessDecisions, type PublicPluginRouteHandler } from "../decisions.js";
import type { AccessDecision, HumanMode, MemberSessionState } from "../types.js";
import { planSegment, type HumanPlan } from "../plans.js";
import { isRecord } from "../utils.js";
import type { PaidAccessOptions } from "./options.js";

export type PluginLocals = { emdash?: { handlePluginApiRoute?: PublicPluginRouteHandler; handlePublicPluginApiRoute: PublicPluginRouteHandler } };
export type PluginResult<T> = { ok: true; data: T } | { ok: false; code: string };
export type HumanDecision = AccessDecision & { humanMode?: HumanMode; showExcerpts?: boolean; agentsSold?: boolean };
export type PublicPlan = Pick<HumanPlan, "slug" | "name" | "description" | "monthlyLabel" | "yearlyLabel" | "trialLabel"> & { checkoutEnabled: boolean };
export type AccessInput = { collection: string; id: string; slug: string; requiredPlanSlugs?: string[]; locale?: string; revision?: string };

async function dispatch<T>(locals: PluginLocals, path: string, body: unknown, publicOnly: boolean, pluginId: string, request?: Request): Promise<PluginResult<T>> {
	try {
		if (publicOnly && !locals.emdash) return { ok: false, code: "UNAVAILABLE" };
		const method = ["plans", "offers"].includes(path) ? "GET" : "POST";
		const url = new URL(`/_emdash/api/plugins/${encodeURIComponent(pluginId)}/${path}`, request?.url ?? "https://paid-access.invalid");
		if (method === "GET" && isRecord(body)) for (const [key, value] of Object.entries(body)) if (value != null) url.searchParams.set(key, String(value));
		const headers = new Headers({ "Content-Type": "application/json" });
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
	return isRecord(value) && ["off", "stripe"].includes(String(value.humanMode)) && typeof value.restricted === "boolean" && typeof value.hasAccess === "boolean" && typeof value.authenticated === "boolean"
		&& (value.email === null || typeof value.email === "string") && Array.isArray(value.requiredPlanSlugs) && value.requiredPlanSlugs.every(v => typeof v === "string")
		&& Array.isArray(value.requiredProductIds) && value.requiredProductIds.every(v => typeof v === "string");
}
export function canRenderBody(decision: AccessDecision): boolean { return decision.hasAccess === true && !decision.error; }
type Entitlements = { humanMode: HumanMode; authenticated: boolean; planSlugs: string[] };
function validEntitlements(value: unknown): value is Entitlements {
	return isRecord(value) && value.ok === true && typeof value.humanMode === "string" && ["off", "stripe", "migration-required"].includes(value.humanMode)
		&& typeof value.authenticated === "boolean"
		&& Array.isArray(value.planSlugs) && value.planSlugs.every(slug => typeof slug === "string");
}
const accessKey = (input: AccessInput) => JSON.stringify([input.collection, input.id, input.slug, input.requiredPlanSlugs ?? [], input.locale, input.revision]);

export function createPaidAccess(locals: PluginLocals, request: Request, sessionToken: string | null, options: Required<PaidAccessOptions>) {
	const memo = new Map<string, Promise<HumanDecision>>();
	async function access(input: AccessInput): Promise<HumanDecision> {
		try {
			const body = { collection: input.collection, collectionSlug: input.collection, contentId: input.id, slug: input.slug, requiredPlanSlugs: input.requiredPlanSlugs, sessionToken };
			const result = await callPlugin(locals, "access", body, request);
			if (!result.ok || !validDecision(result.data) || result.data.error) return failClosedHumanDecision();
			return result.data;
		} catch { return failClosedHumanDecision(); }
	}
	function memoizedAccess(input: AccessInput): Promise<HumanDecision> {
		const key = accessKey(input);
		if (!memo.has(key)) memo.set(key, bounded(access(input), failClosedHumanDecision(), options.entitlementTimeoutMs));
		return memo.get(key)!;
	}
	// One entitlements call per request, however many segments() calls there are. Rejects on any doubt.
	let readerSegments: Promise<string[]> | undefined;
	async function readReaderSegments(): Promise<string[]> {
		const result = await callPlugin(locals, "entitlements", { sessionToken }, request);
		if (!result.ok || !validEntitlements(result.data)) throw new Error("Entitlements unavailable");
		const { humanMode, authenticated, planSlugs } = result.data;
		if (humanMode !== "stripe" || !authenticated) return [];
		return ["member", ...planSlugs.map(planSegment).filter((segment): segment is string => segment !== null)];
	}
	const segmentMemo = new Map<string, Promise<string[]>>();
	async function segments(entry?: AccessInput): Promise<string[]> {
		try {
			const [reader, decision] = await Promise.all([readerSegments ??= bounded<string[] | null>(readReaderSegments(), null, options.entitlementTimeoutMs).then(value => { if (value === null) throw new Error("Entitlements unavailable"); return value; }), entry ? memoizedAccess(entry) : undefined]);
			// An entry decision that couldn't be verified fails the whole answer closed.
			if (decision?.error) return [];
			return [...new Set([...reader, ...(decision && canRenderBody(decision) ? ["entitled"] : [])])].sort();
		} catch { return []; }
	}

	const groupMemo = new Map<string, Promise<HumanDecision>>();
	async function groupAccess(resource: AccessInput & { locale: string; revision: string }): Promise<HumanDecision> {
		const result = await callPlugin(locals, "reader/group", { collection: resource.collection, id: resource.id }, request);
		if (!result.ok || result.data.ok !== true || typeof result.data.group !== "string" || !result.data.group || !Array.isArray(result.data.entries)) return failClosedHumanDecision();
		const entries = result.data.entries;
		if (!entries.length || entries.length > 100 || !entries.every(validGroupEntry) || !entries.some(item => item.id === resource.id && item.locale === resource.locale)) return failClosedHumanDecision();
		if (new Set(entries.map(item => item.id)).size !== entries.length || new Set(entries.map(item => item.locale)).size !== entries.length) return failClosedHumanDecision();
		// Sibling rules, including draft siblings, still own policy for the translated work.
		const decisions = await Promise.all(entries.map(item => memoizedAccess({ ...resource, ...item, slug: item.slug ?? item.id })));
		if (decisions.some(item => item.error)) return failClosedHumanDecision();
		const combined = decisions.reduce((left, right) => ({ ...left, ...unionAccessDecisions(left, right) }));
		return { ...combined, showExcerpts: decisions.every(item => !item.restricted || item.showExcerpts === true) };
	}
	function readerAccess(resource: AccessInput & { locale: string; revision: string }) {
		const key = accessKey(resource);
		if (!groupMemo.has(key)) groupMemo.set(key, bounded(groupAccess(resource), failClosedHumanDecision(), options.entitlementTimeoutMs));
		return groupMemo.get(key)!;
	}
	return {
		options, sessionToken,
		trustedPolicyMetadata: undefined as (<T>(run: () => T) => T) | undefined,
		trustedContent: undefined as (<T>(run: () => T) => T) | undefined,
		readerProvider() {
			return { id: "paid-access", decide: async (resource: AccessInput & { locale: string; revision: string }) => resolveReaderAccess(await readerAccess(resource)) };
		},
		access: memoizedAccess,
		/**
		 * Audience segments for visual builders: `member` (signed in, not a paid entitlement),
		 * `plan:<slug>` for each owned plan, and `entitled` when `entry` may render. Sorted,
		 * memoized per entry, and `[]` whenever anything can't be verified. Never throws, and
		 * each call gets its own array.
		 */
		segments(input?: { entry?: AccessInput }): Promise<string[]> {
			try {
				const entry = input?.entry;
				const key = entry ? accessKey(entry) : "";
				if (!segmentMemo.has(key)) segmentMemo.set(key, segments(entry));
				return segmentMemo.get(key)!.then(list => [...list]);
			} catch { return Promise.resolve([]); }
		},
		async session(): Promise<MemberSessionState> {
			try {
				const result = await callPlugin(locals, "auth/session", { sessionToken }, request);
				if (result.ok && result.data.authenticated === true && typeof result.data.email === "string") return { authenticated: true, email: result.data.email };
			} catch { /* An unavailable session is anonymous. */ }
			return { authenticated: false, email: null };
		},
		async plans(): Promise<PublicPlan[]> {
			const result = await callPublicPlugin(locals, "plans", {}, "paid-access", request);
			if (!result.ok || !Array.isArray(result.data.plans)) return [];
			return result.data.plans.filter((plan): plan is PublicPlan => isRecord(plan) && typeof plan.slug === "string" && typeof plan.name === "string" && typeof plan.checkoutEnabled === "boolean"
				&& ["description", "monthlyLabel", "yearlyLabel", "trialLabel"].every(key => plan[key] == null || typeof plan[key] === "string"));
		},
	};
}
export type PaidAccessLocals = ReturnType<typeof createPaidAccess>;
declare global { namespace App { interface Locals { paidAccess: PaidAccessLocals } } }

async function bounded<T>(pending: Promise<T>, fallback: T, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([pending, new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), timeoutMs); })]);
	} catch { return fallback; }
	finally { clearTimeout(timer); }
}

function validGroupEntry(value: unknown): value is { id: string; slug: string | null; locale: string } {
	return isRecord(value) && typeof value.id === "string" && value.id.length > 0 && (typeof value.slug === "string" || value.slug === null) && typeof value.locale === "string" && value.locale.length > 0;
}
