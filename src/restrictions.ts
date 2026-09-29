// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type {
	AccessPolicy,
	ContentRestrictionRecord,
	TaxonomyRestrictionRecord,
} from "./types.js";
import {
	normalizeStringArray,
	nowIso,
	parsePlanSlugs,
	unwrapStoredRecord,
} from "./utils.js";

const POLICIES: AccessPolicy[] = ["public", "agents-pay", "members", "members-only"];

export function normalizeAgentPrice(value: unknown): string | null {
	if (value == null || value === "") return null;
	if (typeof value !== "string" || !/^\$(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value.trim())) {
		return null;
	}
	const normalized = value.trim();
	return priceMicros(normalized) > 0n ? normalized : null;
}

export function priceMicros(price: string): bigint {
	const [whole, fraction = ""] = price.slice(1).split(".");
	return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

// Only policies sold to agents carry a price that counts.
export function highestAgentPrice(records: Array<{ policy: AccessPolicy; agentPrice?: string | null }>): string | null {
	return records.reduce<string | null>((highest, record) => {
		if (!record.agentPrice || (record.policy !== "agents-pay" && record.policy !== "members")) return highest;
		return !highest || priceMicros(record.agentPrice) > priceMicros(highest) ? record.agentPrice : highest;
	}, null);
}

function normalizePolicy(value: unknown, requiredPlanSlugs: string[], productIds: string[]): AccessPolicy {
	if (POLICIES.includes(value as AccessPolicy)) return value as AccessPolicy;
	return requiredPlanSlugs.length > 0 || productIds.length > 0 ? "members" : "public";
}

export function normalizeContentRestriction(record: unknown): ContentRestrictionRecord | null {
	const data = unwrapStoredRecord<ContentRestrictionRecord>(record);
	if (!data || typeof data.contentId !== "string" || typeof data.collectionSlug !== "string") return null;
	const requiredPlanSlugs = parsePlanSlugs(data.requiredPlanSlugs);
	const productIds = normalizeStringArray(data.productIds);
	const createdAt = typeof data.createdAt === "string" ? data.createdAt : nowIso();
	return {
		contentId: data.contentId,
		collectionSlug: data.collectionSlug,
		slug: typeof data.slug === "string" ? data.slug : null,
		title: typeof data.title === "string" ? data.title : null,
		requiredPlanSlugs,
		productIds,
		policy: normalizePolicy(data.policy, requiredPlanSlugs, productIds),
		agentPrice: normalizeAgentPrice(data.agentPrice),
		passEligible: data.passEligible === true,
		source: "manual",
		createdAt,
		updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : createdAt,
	};
}

export function normalizeTaxonomyRestriction(record: unknown): TaxonomyRestrictionRecord | null {
	const data = unwrapStoredRecord<TaxonomyRestrictionRecord>(record);
	if (!data || typeof data.taxonomyName !== "string" || typeof data.termId !== "string") return null;
	const requiredPlanSlugs = parsePlanSlugs(data.requiredPlanSlugs);
	const productIds = normalizeStringArray(data.productIds);
	const createdAt = typeof data.createdAt === "string" ? data.createdAt : nowIso();
	return {
		taxonomyName: data.taxonomyName,
		termId: data.termId,
		requiredPlanSlugs,
		productIds,
		policy: normalizePolicy(data.policy, requiredPlanSlugs, productIds),
		agentPrice: normalizeAgentPrice(data.agentPrice),
		passEligible: data.passEligible === true,
		createdAt,
		updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : createdAt,
	};
}

export async function getEntryRestrictions(
	ctx: any,
	collectionSlug: string,
	contentId: string,
	slug?: string | null,
): Promise<Array<ContentRestrictionRecord | TaxonomyRestrictionRecord>> {
	const records: Array<ContentRestrictionRecord | TaxonomyRestrictionRecord> = [];
	const direct = normalizeContentRestriction(await ctx.storage.restrictions.get(`${collectionSlug}:${contentId}`));
	if (direct) records.push(direct);
	if (slug && slug !== contentId) {
		const legacy = normalizeContentRestriction(await ctx.storage.restrictions.get(`${collectionSlug}:${slug}`));
		if (legacy) records.push(legacy);
	}

	if (!ctx.taxonomies?.getEntryTerms) {
		const result = await ctx.storage.taxonomy_restrictions.query({ limit: 1 });
		if (result.items.length > 0) throw new Error("Taxonomy access is unavailable.");
		return records;
	}

	for (const term of await ctx.taxonomies.getEntryTerms(collectionSlug, contentId)) {
		const rule = normalizeTaxonomyRestriction(
			await ctx.storage.taxonomy_restrictions.get(`${term.taxonomy}:${term.id}`),
		);
		if (rule) records.push(rule);
	}
	return records;
}
