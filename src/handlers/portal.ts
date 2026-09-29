// Copyright 2026 Stranger Studios.
// Modified by Mason James, 2026-09-23.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PluginContext } from "emdash/plugin";
import type { RouteContext } from "../types.js";

import { getCustomerRecordByEmail, upsertCustomerRecord } from "../customers.js";
import { StripeClient } from "../stripe.js";
import { isRecord, sanitizeRedirectPath } from "../utils.js";
import { getSessionEmail } from "./auth.js";
import { loadSettings } from "./settings.js";

export async function portalHandler(routeCtx: RouteContext, ctx: PluginContext) {
	const body = isRecord(routeCtx.input) ? routeCtx.input : {};
	const email = await getSessionEmail(ctx, body.sessionToken);
	if (!email) {
		return { ok: false, code: "NOT_AUTHENTICATED", error: "Sign in to manage your subscription." };
	}

	const settings = await loadSettings(ctx);
	if (!settings.stripeSecretKey) {
		return { ok: false, code: "STRIPE_NOT_CONFIGURED", error: "Stripe is not configured yet." };
	}

	const stripe = new StripeClient(settings.stripeSecretKey, ctx.http!.fetch);
	let customer = await getCustomerRecordByEmail(ctx, email);
	if (!customer) {
		const stripeCustomers = await stripe.getCustomersByEmail(email);
		const stripeCustomerId = stripeCustomers.data[0]?.id;
		if (!stripeCustomerId) {
			return { ok: false, code: "NO_CUSTOMER", error: "No Stripe customer was found for this email address." };
		}
		customer = await upsertCustomerRecord(ctx, email, stripeCustomerId);
	}

	try {
		const returnUrl = ctx.url(sanitizeRedirectPath(body.returnUrl, settings.accountPath));
		const session = await stripe.createPortalSession(customer.stripeCustomerId, returnUrl);
		return { ok: true, url: session.url };
	} catch (error) {
		ctx.log.error("Failed to create Stripe portal session", error);
		return { ok: false, code: "STRIPE_UNAVAILABLE", error: "Unable to open the Stripe customer portal right now." };
	}
}
