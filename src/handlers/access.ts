// Copyright 2026 Stranger Studios.
// Modified by Mason James, 2026-09-23.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AccessDecision } from "../types.js";
import { getCustomerRecordByEmail, upsertCustomerRecord } from "../customers.js";
import { getEntryRestrictions } from "../restrictions.js";
import { StripeClient } from "../stripe.js";
import { isRecord, parsePlanSlugs, uniqueStrings } from "../utils.js";
import { getSessionEmail } from "./auth.js";
import { loadSettings, resolveRequiredProductIds } from "./settings.js";

function parseRequiredPlanSlugsFromUrl(url: URL): string[] {
	const allValues = url.searchParams.getAll("requiredPlanSlugs");
	if (allValues.length === 0) {
		const single = url.searchParams.get("requiredPlanSlugs");
		return single ? single.split(",").map((value) => value.trim()).filter(Boolean) : [];
	}
	return allValues.map((value) => value.trim()).filter(Boolean);
}

function readAccessInput(ctx: any) {
	const url = new URL(ctx.request.url);
	const body = isRecord(ctx.input) ? ctx.input : {};
	return {
		contentId:
			typeof body.contentId === "string" ? body.contentId : (url.searchParams.get("contentId") ?? "").trim(),
		collectionSlug:
			typeof body.collectionSlug === "string"
				? body.collectionSlug
				: (url.searchParams.get("collectionSlug") || url.searchParams.get("collection") || "").trim(),
		slug:
			typeof body.slug === "string"
				? body.slug
				: (url.searchParams.get("slug") || null),
		requiredPlanSlugs:
			Array.isArray(body.requiredPlanSlugs)
				? parsePlanSlugs(body.requiredPlanSlugs)
				: parseRequiredPlanSlugsFromUrl(url),
	};
}

export async function accessHandler(ctx: any): Promise<AccessDecision | { ok: false; error: string }> {
	const settings = await loadSettings(ctx);
	const { contentId, collectionSlug, slug, requiredPlanSlugs: callerRequiredPlanSlugs } = readAccessInput(ctx);
	if (!contentId || !collectionSlug) {
		return { ok: false, error: "contentId and collectionSlug are required." };
	}

	const restrictionRecords = await getEntryRestrictions(ctx, collectionSlug, contentId, slug);
	const humanRestrictionRecords = restrictionRecords.filter(
		(record) => record.policy === "members" || record.policy === "members-only",
	);
	const restrictionPlanSlugs = humanRestrictionRecords.flatMap((record) => record.requiredPlanSlugs || []);
	const restrictionProductIds = humanRestrictionRecords.flatMap((record) => record.productIds || []);
	const validPlanSlugs = settings.humans.plans.map((plan) => plan.slug);
	const requiredPlanSlugs = uniqueStrings([
		...restrictionPlanSlugs,
		...parsePlanSlugs(callerRequiredPlanSlugs, validPlanSlugs),
	]);
	const requiredProductIds = uniqueStrings([
		...restrictionProductIds,
		...resolveRequiredProductIds(settings.humans.plans, requiredPlanSlugs),
	]);
	const restricted = humanRestrictionRecords.length > 0 || requiredPlanSlugs.length > 0 || requiredProductIds.length > 0;
	if (settings.humans.mode === "off" || settings.humans.mode === "delegate") {
		return {
			restricted,
			authenticated: false,
			hasAccess: !restricted,
			email: null,
			requiredPlanSlugs,
			requiredProductIds,
			...(settings.humans.mode === "delegate" ? { delegated: true } : {}),
			...(settings.humans.mode === "off" && restricted ? { error: "Member access is turned off for this site." } : {}),
		};
	}
	const email = await getSessionEmail(ctx);
	const authenticated = Boolean(email);

	if (!restricted) {
		return {
			restricted: false,
			authenticated,
			hasAccess: true,
			email,
			requiredPlanSlugs,
			requiredProductIds,
		};
	}
	if (requiredProductIds.length === 0) {
		return { restricted: true, authenticated, hasAccess: false, email, requiredPlanSlugs, requiredProductIds, error: "Required plans are not configured." };
	}

	if (!authenticated || !email) {
		return {
			restricted: true,
			authenticated: false,
			hasAccess: false,
			email: null,
			requiredPlanSlugs,
			requiredProductIds,
		};
	}

	if (!settings.stripeSecretKey) {
		return {
			restricted: true,
			authenticated: true,
			hasAccess: false,
			email,
			requiredPlanSlugs,
			requiredProductIds,
			error: "Stripe is not configured yet.",
		};
	}

	const stripe = new StripeClient(settings.stripeSecretKey, ctx.http.fetch);
	const localCustomer = await getCustomerRecordByEmail(ctx, email);
	if (localCustomer) {
		try {
			if (await stripe.customerHasProduct(localCustomer.stripeCustomerId, requiredProductIds)) {
				return {
					restricted: true,
					authenticated: true,
					hasAccess: true,
					email,
					requiredPlanSlugs,
					requiredProductIds,
				};
			}
		} catch (error) {
			ctx.log.warn("Failed to verify cached Stripe customer access", error);
		}
	}

	try {
		const stripeCustomers = await stripe.getCustomersByEmail(email);
		for (const stripeCustomer of stripeCustomers.data) {
			if (await stripe.customerHasProduct(stripeCustomer.id, requiredProductIds)) {
				await upsertCustomerRecord(ctx, email, stripeCustomer.id);
				return {
					restricted: true,
					authenticated: true,
					hasAccess: true,
					email,
					requiredPlanSlugs,
					requiredProductIds,
				};
			}
		}
	} catch (error) {
		ctx.log.error("Failed to verify Stripe access", error);
		return {
			restricted: true,
			authenticated: true,
			hasAccess: false,
			email,
			requiredPlanSlugs,
			requiredProductIds,
			error: "Unable to verify Stripe access right now.",
		};
	}

	return {
		restricted: true,
		authenticated: true,
		hasAccess: false,
		email,
		requiredPlanSlugs,
		requiredProductIds,
	};
}
