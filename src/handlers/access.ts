// Copyright 2026 Stranger Studios.
// Modified by Mason James, 2026-09-23.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PluginContext } from "emdash/plugin";
import type { PaidAccessSettings, RouteContext } from "../types.js";

import type { AccessDecision } from "../types.js";
import { getCustomerRecordByEmail, upsertCustomerRecord } from "../customers.js";
import { getEntryRestrictions, highestAgentPrice } from "../restrictions.js";
import { StripeClient } from "../stripe.js";
import { isRecord, parsePlanSlugs, uniqueStrings } from "../utils.js";
import { getSessionEmail } from "./auth.js";
import { loadSettings, resolveRequiredProductIds } from "./settings.js";

function readAccessInput(routeCtx: RouteContext) {
	const body = isRecord(routeCtx.input) ? routeCtx.input : {};
	return {
		contentId: typeof body.contentId === "string" ? body.contentId.trim() : "",
		collectionSlug: typeof body.collectionSlug === "string" ? body.collectionSlug.trim() : typeof body.collection === "string" ? body.collection.trim() : "",
		slug: typeof body.slug === "string" ? body.slug : null,
		requiredPlanSlugs: parsePlanSlugs(body.requiredPlanSlugs),
	};
}

export async function accessHandler(routeCtx: RouteContext, ctx: PluginContext) {
	const settings = await loadSettings(ctx);
	const humanMode = settings.humans.mode;
	// Only the trusted companion can report coexistence through the private route.
	if (humanMode === "stripe" && await ctx.kv?.get("state:legacyPluginPresent") === true) {
		settings.humans = { ...settings.humans, mode: "delegate" };
	}
	const input = readAccessInput(routeCtx);
	if (!input.contentId || !input.collectionSlug) return { ok: false, error: "contentId and collectionSlug are required." };
	const rules = await getEntryRestrictions(ctx, input.collectionSlug, input.contentId, input.slug);
	const decision = await resolveHumanAccess(routeCtx, ctx, settings, rules);
	return { ...decision, humanMode, showExcerpts: settings.showExcerpts,
		agentsSold: settings.agents.mode === "paid" && Boolean(highestAgentPrice(rules)) && rules.some(rule => rule.policy === "agents-pay" || rule.policy === "members") && !rules.some(rule => rule.policy === "members-only") };
}

async function resolveHumanAccess(routeCtx: RouteContext, ctx: PluginContext, settings: PaidAccessSettings, restrictionRecords: Awaited<ReturnType<typeof getEntryRestrictions>>): Promise<AccessDecision | { ok: false; error: string }> {
	// Already parsed; unknown or removed caller plans must restrict, never vanish.
	const { requiredPlanSlugs: callerPlanSlugs } = readAccessInput(routeCtx);
	const humanRestrictionRecords = restrictionRecords.filter(
		(record) => record.policy === "members" || record.policy === "members-only",
	);
	const restrictionPlanSlugs = humanRestrictionRecords.flatMap((record) => record.requiredPlanSlugs || []);
	const restrictionProductIds = humanRestrictionRecords.flatMap((record) => record.productIds || []);
	const validPlanSlugs = new Set(settings.humans.plans.map((plan) => plan.slug));
	const requiredPlanSlugs = uniqueStrings([...restrictionPlanSlugs, ...callerPlanSlugs]);
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
	const email = await getSessionEmail(ctx, isRecord(routeCtx.input) ? routeCtx.input.sessionToken : undefined);
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
	if (requiredProductIds.length === 0 || callerPlanSlugs.some((slug) => !validPlanSlugs.has(slug))) {
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

	const stripe = new StripeClient(settings.stripeSecretKey, ctx.http!.fetch);
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
