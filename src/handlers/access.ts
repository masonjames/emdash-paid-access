// Copyright 2026 Stranger Studios.
// Modified by Mason James, 2026-09-23.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PluginContext } from "emdash/plugin";
import type { PaidAccessSettings, RouteContext } from "../types.js";

import type { AccessDecision, CustomerRecord } from "../types.js";
import { ForeignMigratedCustomerError, getCustomerRecordByEmail, hasMigrationBinding, upsertCustomerRecord, verifyCustomerAssociation, verifyMigratedCustomer } from "../customers.js";
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
	if (settings.humans.mode !== "stripe") {
		const migrationRequired = settings.humans.mode === "migration-required";
		return {
			restricted: restricted || migrationRequired,
			authenticated: false,
			hasAccess: !restricted && !migrationRequired,
			email: null,
			requiredPlanSlugs,
			requiredProductIds,
			...(migrationRequired ? { error: "Complete the membership migration before enabling access." }
				: restricted ? { error: "Member access is turned off for this site." } : {}),
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
	if (requiredProductIds.length === 0 || requiredPlanSlugs.some((slug) => !validPlanSlugs.has(slug))) {
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
	let localCustomer: CustomerRecord | null;
	try { localCustomer = await getCustomerRecordByEmail(ctx, email); }
	catch { return { restricted: true, authenticated: true, hasAccess: false, email, requiredPlanSlugs, requiredProductIds, error: "Migrated customer identity requires review." }; }
	if (hasMigrationBinding(localCustomer)) {
		try {
			await verifyMigratedCustomer(localCustomer, stripe, email, settings);
			const hasAccess = await stripe.customerHasProduct(localCustomer.stripeCustomerId, requiredProductIds);
			return { restricted: true, authenticated: true, hasAccess, email, requiredPlanSlugs, requiredProductIds };
		} catch {
			return { restricted: true, authenticated: true, hasAccess: false, email, requiredPlanSlugs, requiredProductIds,
				error: "Unable to verify migrated Stripe access. Contact the site administrator." };
		}
	}
	if (localCustomer) {
		let migrated: boolean;
		try {
			migrated = await verifyCustomerAssociation(ctx, stripe, email, localCustomer.stripeCustomerId, settings);
		} catch {
			return { restricted: true, authenticated: true, hasAccess: false, email, requiredPlanSlugs, requiredProductIds,
				error: "Unable to verify migrated Stripe access. Contact the site administrator." };
		}
		try {
			const hasAccess = await stripe.customerHasProduct(localCustomer.stripeCustomerId, requiredProductIds);
			if (migrated || hasAccess) {
				return {
					restricted: true,
					authenticated: true,
					hasAccess,
					email,
					requiredPlanSlugs,
					requiredProductIds,
				};
			}
		} catch (error) {
			if (migrated) return { restricted: true, authenticated: true, hasAccess: false, email, requiredPlanSlugs, requiredProductIds, error: "Unable to verify Stripe access right now." };
			ctx.log.warn("Failed to verify cached Stripe customer access", error);
		}
	}

	try {
		const stripeCustomers = await stripe.getCustomersByEmail(email);
		for (const stripeCustomer of stripeCustomers.data) {
			let migrated: boolean;
			try { migrated = await verifyCustomerAssociation(ctx, stripe, email, stripeCustomer.id, settings); }
			catch (error) {
				if (error instanceof ForeignMigratedCustomerError) continue;
				throw error;
			}
			const hasAccess = await stripe.customerHasProduct(stripeCustomer.id, requiredProductIds);
			if (migrated || hasAccess) {
				if (hasAccess) await upsertCustomerRecord(ctx, email, stripeCustomer.id);
				return {
					restricted: true,
					authenticated: true,
					hasAccess,
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
