// Copyright 2026 Stranger Studios.
// Modified by Mason James, 2026-09-23.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PluginContext } from "emdash/plugin";
import type { RouteContext } from "../types.js";

import { normalizeAgentPrice, normalizeContentRestriction, normalizeTaxonomyRestriction } from "../restrictions.js";
import type { AccessPolicy, ContentRestrictionRecord } from "../types.js";
import { isRecord, parsePlanSlugs, normalizeStringArray, nowIso } from "../utils.js";
import { loadSettings } from "./settings.js";

const POLICIES: AccessPolicy[] = ["public", "agents-pay", "members", "members-only"];
const SALE: AccessPolicy[] = ["agents-pay", "members"];
// With expectedRevision ("" when the rule must not exist yet), a write applies
// only if the rule hasn't changed since the caller read it.
const STALE = { ok: false, stale: true, error: "This post's access changed since the panel loaded. Check the choices and try again." };
const expected = (body: Record<string, unknown>) => typeof body.expectedRevision === "string" ? body.expectedRevision : undefined;

export async function restrictionsHandler(routeCtx: RouteContext, ctx: PluginContext) {
	const method = routeCtx.request.method;
	const input = isRecord(routeCtx.input) ? routeCtx.input : {};

	if (method === "GET") {
		const type = (typeof input.type === "string" ? input.type : null) || "content";
		if (type === "taxonomy") {
			const taxonomyName = (typeof input.taxonomy === "string" ? input.taxonomy : null);
			const result = await ctx.storage.taxonomy_restrictions.query(
				taxonomyName ? { where: { taxonomyName }, limit: 200 } : { limit: 200 },
			);
			return {
				items: result.items
					.map((item: { id: string; data: unknown }) => {
						const data = normalizeTaxonomyRestriction(item.data);
						return data ? { id: item.id, data } : null;
					})
					.filter(Boolean),
			};
		}

		const collectionSlug = (typeof input.collection === "string" ? input.collection : null);
		const contentId = (typeof input.contentId === "string" ? input.contentId : null);
		const slug = (typeof input.slug === "string" ? input.slug : null);

		if (collectionSlug && contentId) {
			const items: Array<{ id: string; data: ContentRestrictionRecord }> = [];
			const direct = normalizeContentRestriction(
				await ctx.storage.restrictions.get(`${collectionSlug}:${contentId}`),
			);
			if (direct) {
				items.push({ id: `${collectionSlug}:${contentId}`, data: direct });
			}
			if (slug && slug !== contentId) {
				const legacy = normalizeContentRestriction(
					await ctx.storage.restrictions.get(`${collectionSlug}:${slug}`),
				);
				if (legacy) {
					items.push({ id: `${collectionSlug}:${slug}`, data: legacy });
				}
			}
			return { items };
		}

		const result = await ctx.storage.restrictions.query(
			collectionSlug ? { where: { collectionSlug }, limit: 200 } : { limit: 200 },
		);
		const items = result.items
			.map((item: { id: string; data: unknown }) => {
				const data = normalizeContentRestriction(item.data);
				return data ? { id: item.id, data } : null;
			})
			.filter((item: { id: string; data: ContentRestrictionRecord } | null): item is { id: string; data: ContentRestrictionRecord } => Boolean(item))
			.filter((item: { id: string; data: ContentRestrictionRecord }) => (contentId ? item.data.contentId === contentId : true))
			.filter((item: { id: string; data: ContentRestrictionRecord }) => (slug ? item.data.slug === slug || item.data.contentId === slug : true));
		return { items };
	}

	if (method === "POST") {
		const body: Record<string, unknown> = isRecord(routeCtx.input) ? routeCtx.input : {};
		const settings = await loadSettings(ctx);
		const taxonomy = body.type === "taxonomy";
		const taxonomyName = typeof body.taxonomyName === "string" ? body.taxonomyName : "";
		const termId = typeof body.termId === "string" ? body.termId : "";
		const contentId = typeof body.contentId === "string" ? body.contentId : "";
		const collectionSlug = typeof body.collectionSlug === "string" ? body.collectionSlug : "";
		if (taxonomy ? !taxonomyName || !termId : !contentId || !collectionSlug) {
			return { ok: false, error: taxonomy ? "taxonomyName and termId are required." : "contentId and collectionSlug are required." };
		}
		const key = taxonomy ? `${taxonomyName}:${termId}` : `${collectionSlug}:${contentId}`;
		const existing = taxonomy
			? normalizeTaxonomyRestriction(await ctx.storage.taxonomy_restrictions.get(key))
			: normalizeContentRestriction(await ctx.storage.restrictions.get(key));
		const merged: Record<string, unknown> = { ...existing, ...body };
		const validPlanSlugs = settings.humans.plans.map((plan) => plan.slug);
		const requestedPlanSlugs = parsePlanSlugs(merged.requiredPlanSlugs);
		const requiredPlanSlugs = parsePlanSlugs(requestedPlanSlugs, validPlanSlugs);
		if (requestedPlanSlugs.length !== requiredPlanSlugs.length) {
			return { ok: false, error: "requiredPlanSlugs contains an unknown plan." };
		}
		if (merged.policy != null && (typeof merged.policy !== "string" || !POLICIES.includes(merged.policy as AccessPolicy))) {
			return { ok: false, error: "Invalid policy." };
		}
		const policy = typeof merged.policy === "string"
			? merged.policy as AccessPolicy
			: requiredPlanSlugs.length > 0 ? "members" : "public";
		const agentPrice = normalizeAgentPrice(merged.agentPrice);
		if (merged.agentPrice != null && merged.agentPrice !== "" && !agentPrice) {
			return { ok: false, error: "agentPrice must be a dollar amount with at most six decimals." };
		}
		if (settings.agents.mode !== "off" && (policy === "agents-pay" || policy === "members") && !agentPrice) {
			return { ok: false, error: "A valid agentPrice is required for a policy sold to agents." };
		}
		// A price only means something on a policy sold to agents.
		const salePrice = SALE.includes(policy) ? agentPrice : null;
		if (taxonomy) {
			await ctx.storage.taxonomy_restrictions.put(key, {
				taxonomyName,
				termId,
				requiredPlanSlugs,
				productIds: normalizeStringArray(merged.productIds),
				policy,
				agentPrice: salePrice,
				passEligible: merged.passEligible === true,
				createdAt: existing?.createdAt ?? nowIso(),
				updatedAt: nowIso(),
			});
			return { ok: true };
		}

		const record: ContentRestrictionRecord = {
			contentId,
			collectionSlug,
			slug: typeof merged.slug === "string" ? merged.slug : null,
			title: typeof merged.title === "string" ? merged.title : null,
			requiredPlanSlugs,
			productIds: normalizeStringArray(merged.productIds),
			policy,
			agentPrice: salePrice,
			passEligible: merged.passEligible === true,
			source: "manual",
			createdAt: existing?.createdAt ?? nowIso(),
			updatedAt: nowIso(),
		};
		const revision = expected(body);
		if (revision === undefined) await ctx.storage.restrictions.put(key, record);
		else if (!(await ctx.storage.restrictions.compareAndSet(key, revision || null, record)).applied) return STALE;
		return { ok: true, item: { id: key, data: record } };
	}

	if (method === "DELETE") {
		const body = isRecord(routeCtx.input) ? routeCtx.input : {};
		if ((body as Record<string, unknown>).type === "taxonomy") {
			const key = `${String((body as Record<string, unknown>).taxonomyName || "")}:${String((body as Record<string, unknown>).termId || "")}`;
			await ctx.storage.taxonomy_restrictions.delete(key);
			return { ok: true };
		}

		const collectionSlug = String((body as Record<string, unknown>).collectionSlug || "");
		const contentId = String((body as Record<string, unknown>).contentId || "");
		const slug = typeof (body as Record<string, unknown>).slug === "string" ? (body as Record<string, unknown>).slug : null;
		if (!collectionSlug || !contentId) {
			return { ok: false, error: "contentId and collectionSlug are required." };
		}

		const key = `${collectionSlug}:${contentId}`;
		const revision = expected(body);
		if (revision === undefined) await ctx.storage.restrictions.delete(key);
		else if (!(revision ? (await ctx.storage.restrictions.compareAndDelete(key, revision)).applied : !(await ctx.storage.restrictions.get(key)))) return STALE;
		if (slug && slug !== contentId) {
			await ctx.storage.restrictions.delete(`${collectionSlug}:${slug}`);
		}
		return { ok: true };
	}

	return { ok: false, error: "Method not allowed." };
}
