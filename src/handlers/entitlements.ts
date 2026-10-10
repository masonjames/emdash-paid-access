// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PluginContext } from "emdash/plugin";
import type { HumanMode, RouteContext } from "../types.js";

import { getCustomerRecordByEmail } from "../customers.js";
import { StripeClient } from "../stripe.js";
import { isRecord, routeError, uniqueStrings } from "../utils.js";
import { getSessionEmail } from "./auth.js";
import { loadSettings } from "./settings.js";

/**
 * Every product the member's Stripe customers own, with at most one pass per
 * customer and no storage writes. Any Stripe error propagates, so the route fails closed.
 */
async function ownedProducts(ctx: PluginContext, stripe: StripeClient, email: string, configured: string[]): Promise<Set<string>> {
	const owned = new Set<string>();
	const passed = new Set<string>();
	const local = await getCustomerRecordByEmail(ctx, email);
	if (local?.stripeCustomerId) {
		passed.add(local.stripeCustomerId);
		for (const product of await stripe.customerProducts(local.stripeCustomerId)) owned.add(product);
		// Like access, search by email only when the stored customer doesn't cover what is asked: here, every plan.
		if (configured.every((product) => owned.has(product))) return owned;
	}
	for (const customer of (await stripe.getCustomersByEmail(email)).data) {
		if (passed.has(customer.id)) continue;
		passed.add(customer.id);
		for (const product of await stripe.customerProducts(customer.id)) owned.add(product);
	}
	return owned;
}

/** Private: the companion's member and plan segments for one reader. */
export async function memberEntitlementsHandler(routeCtx: RouteContext, ctx: PluginContext) {
	const settings = await loadSettings(ctx);
	// The same downgrade as access: only the trusted companion reports coexistence.
	const humanMode: HumanMode = settings.humans.mode === "stripe" && await ctx.kv?.get("state:legacyPluginPresent") === true ? "delegate" : settings.humans.mode;
	if (humanMode !== "stripe") return { ok: true, humanMode, authenticated: false, planSlugs: [] };
	const email = await getSessionEmail(ctx, isRecord(routeCtx.input) ? routeCtx.input.sessionToken : undefined);
	const configured = uniqueStrings(settings.humans.plans.map((plan) => plan.stripeProductId));
	if (!email || !settings.stripeSecretKey || configured.length === 0) return { ok: true, humanMode, authenticated: Boolean(email), planSlugs: [] };
	try {
		const owned = await ownedProducts(ctx, new StripeClient(settings.stripeSecretKey, ctx.http!.fetch), email, configured);
		const planSlugs = settings.humans.plans.filter((plan) => plan.stripeProductId && owned.has(plan.stripeProductId)).map((plan) => plan.slug);
		return { ok: true, humanMode, authenticated: true, planSlugs };
	} catch (error) {
		ctx.log.error("Failed to read Stripe entitlements", error);
		return routeError("UNAVAILABLE", "Unable to verify Stripe access right now.");
	}
}
