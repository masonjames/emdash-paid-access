import type { PluginContext } from "emdash/plugin";
// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type {
	AccessPolicy,
	ContentRestrictionRecord,
	TaxonomyRestrictionRecord,
} from "./types.js";
import {
	isRecord,
	normalizeStringArray,
	nowIso,
	parsePlanSlugs,
	unwrapStoredRecord,
} from "./utils.js";


export function normalizeAgentPrice(value: unknown): string | null {
	if (value == null || value === "") return null;
	if (typeof value !== "string" || !/^\$(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value.trim())) {
		return null;
	}
	const normalized = value.trim();
	return priceMicros(normalized) > 0n ? normalized : null;
}

// People type prices with or without the dollar sign; stored prices always carry it.
export function priceFromInput(value: unknown): unknown {
	return typeof value === "string" && /^\s*\d/.test(value) ? `$${value.trim()}` : value;
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

function normalizePolicy(value: unknown, requiredPlanSlugs: string[], productIds: string[]): AccessPolicy | null {
	if (value === "public" || value === "agents-pay" || value === "members" || value === "members-only") return value;
	// Legacy membership records omitted policy but carried explicit nonempty requirements.
	if (value === undefined && (requiredPlanSlugs.length > 0 || productIds.length > 0)) return "members";
	return null;
}

function validRequirements(data: Record<string, unknown>): boolean {
	return ["requiredPlanSlugs", "productIds"].every(key => data[key] === undefined ||
		(Array.isArray(data[key]) && data[key].every((value: unknown) => typeof value === "string" && value.trim().length > 0))) &&
		(data.agentPrice == null || data.agentPrice === "" || normalizeAgentPrice(data.agentPrice) !== null);
}

export function normalizeContentRestriction(record: unknown): ContentRestrictionRecord | null {
	const data = unwrapStoredRecord<unknown>(record);
	if (!isRecord(data) || !validRequirements(data) || typeof data.contentId !== "string" || typeof data.collectionSlug !== "string") return null;
	const requiredPlanSlugs = parsePlanSlugs(data.requiredPlanSlugs);
	const productIds = normalizeStringArray(data.productIds);
	const policy = normalizePolicy(data.policy, requiredPlanSlugs, productIds);
	if (!policy) return null;
	const createdAt = typeof data.createdAt === "string" ? data.createdAt : nowIso();
	return {
		contentId: data.contentId,
		collectionSlug: data.collectionSlug,
		slug: typeof data.slug === "string" ? data.slug : null,
		title: typeof data.title === "string" ? data.title : null,
		requiredPlanSlugs,
		productIds,
		policy,
		agentPrice: normalizeAgentPrice(data.agentPrice),
		passEligible: data.passEligible === true,
		source: "manual",
		createdAt,
		updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : createdAt,
	};
}

export function normalizeTaxonomyRestriction(record: unknown): TaxonomyRestrictionRecord | null {
	const data = unwrapStoredRecord<unknown>(record);
	if (!isRecord(data) || !validRequirements(data) || typeof data.taxonomyName !== "string" || typeof data.termId !== "string") return null;
	const requiredPlanSlugs = parsePlanSlugs(data.requiredPlanSlugs);
	const productIds = normalizeStringArray(data.productIds);
	const policy = normalizePolicy(data.policy, requiredPlanSlugs, productIds);
	if (!policy) return null;
	const createdAt = typeof data.createdAt === "string" ? data.createdAt : nowIso();
	return {
		taxonomyName: data.taxonomyName,
		termId: data.termId,
		requiredPlanSlugs,
		productIds,
		policy,
		agentPrice: normalizeAgentPrice(data.agentPrice),
		passEligible: data.passEligible === true,
		createdAt,
		updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : createdAt,
	};
}

export async function getEntryRestrictions(
	ctx: Pick<PluginContext, "storage" | "taxonomies">,
	collectionSlug: string,
	contentId: string,
	slug?: string | null,
): Promise<Array<ContentRestrictionRecord | TaxonomyRestrictionRecord>> {
	const records: Array<ContentRestrictionRecord | TaxonomyRestrictionRecord> = [];
	const readContent = async (key: string) => {
		const raw = await ctx.storage.restrictions.get(`${collectionSlug}:${key}`);
		if (raw == null) return null;
		const rule = normalizeContentRestriction(raw);
		if (!rule || rule.collectionSlug !== collectionSlug || (rule.contentId !== contentId && rule.contentId !== key && rule.slug !== key)) throw new Error("Content access metadata is invalid.");
		return rule;
	};
	const direct = await readContent(contentId);
	if (direct) records.push(direct);
	if (slug && slug !== contentId) {
		const legacy = await readContent(slug);
		if (legacy) records.push(legacy);
	}

	if (!ctx.taxonomies?.getEntryTerms) {
		const result = await ctx.storage.taxonomy_restrictions.query({ limit: 1 });
		if (result.items.length > 0) throw new Error("Taxonomy access is unavailable.");
		return records;
	}

	const terms = await ctx.taxonomies.getEntryTerms(collectionSlug, contentId);
	if (!Array.isArray(terms)) throw new Error("Taxonomy metadata is invalid.");
	for (const term of terms) {
		if (!term || typeof term.taxonomy !== "string" || !term.taxonomy || typeof term.id !== "string" || !term.id) throw new Error("Taxonomy metadata is invalid.");
		const raw = await ctx.storage.taxonomy_restrictions.get(`${term.taxonomy}:${term.id}`);
		if (raw == null) continue;
		const rule = normalizeTaxonomyRestriction(raw);
		if (!rule || rule.taxonomyName !== term.taxonomy || rule.termId !== term.id) throw new Error("Taxonomy access metadata is invalid.");
		if (rule) records.push(rule);
	}
	return records;
}
