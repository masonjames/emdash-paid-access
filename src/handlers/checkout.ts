// Copyright 2026 Stranger Studios.
// Modified by Mason James, 2026-09-23.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PluginContext } from "emdash/plugin";
import type { CustomerRecord, RouteContext } from "../types.js";

import { findOrCreateCustomerRecord, getCustomerRecordByEmail, hasMigrationBinding, upsertCustomerRecord, verifyCustomerAssociation, verifyMigratedCustomer } from "../customers.js";
import { getPlan, isBillingInterval } from "../plans.js";
import { StripeClient } from "../stripe.js";
import { isRecord, normalizeEmail, sanitizeRedirectPath } from "../utils.js";
import { isEmailReady, sendMagicLink } from "./auth.js";
import { loadSettings } from "./settings.js";

function buildAbsoluteUrl(routeCtx: RouteContext, ctx: PluginContext, path: string): string {
	const absolute = ctx.url(path);
	const base = routeCtx.request ? new URL(routeCtx.request.url).origin : undefined;
	return new URL(absolute, base).toString();
}

export async function checkoutHandler(routeCtx: RouteContext, ctx: PluginContext) {
	const body = isRecord(routeCtx.input) ? routeCtx.input : {};
	const planSlug = body.planSlug;
	const billingInterval = body.billingInterval;
	const email = normalizeEmail(body.email);
	const redirectPath = sanitizeRedirectPath(body.redirectUrl, "/");

	if (!isBillingInterval(billingInterval)) {
		return { ok: false, error: "A valid billing interval is required." };
	}
	if (!email) {
		return { ok: false, error: "A valid email address is required." };
	}
	if (!(await isEmailReady(ctx))) {
		return { ok: false, error: "Email delivery is not configured for this site yet." };
	}

	const settings = await loadSettings(ctx);
	const plan = typeof planSlug === "string" ? getPlan(settings.humans.plans, planSlug) : undefined;
	if (!plan || !plan.stripeProductId) {
		return { ok: false, error: "A configured paid subscription option is required." };
	}
	if (!settings.stripeSecretKey) {
		return { ok: false, error: "Stripe is not configured yet." };
	}

	const productId = plan.stripeProductId;

	const stripe = new StripeClient(settings.stripeSecretKey, ctx.http!.fetch);
	let existing: CustomerRecord | null;
	try { existing = await getCustomerRecordByEmail(ctx, email); }
	catch { return { ok: false, error: "Migrated customer identity requires review." }; }
	if (existing) {
		try {
			if (hasMigrationBinding(existing)) await verifyMigratedCustomer(existing, stripe, email, settings);
			else await verifyCustomerAssociation(ctx, stripe, email, existing.stripeCustomerId, settings);
		} catch {
			return { ok: false, error: "Unable to verify migrated Stripe customer. Contact the site administrator." };
		}
	}
	const price = await stripe.findRecurringPriceForProduct(productId, billingInterval);
	if (!price) {
		return {
			ok: false,
			error: `No active ${billingInterval} price was found for ${plan.name}.`,
		};
	}

	let customer: CustomerRecord;
	try { customer = hasMigrationBinding(existing) ? existing : await findOrCreateCustomerRecord(ctx, stripe, email, settings); }
	catch { return { ok: false, error: "Unable to verify migrated Stripe customer. Contact the site administrator." }; }
	const successUrl = new URL(buildAbsoluteUrl(routeCtx, ctx, `${settings.accountPath}complete/`));
	successUrl.searchParams.set("session_id", "{CHECKOUT_SESSION_ID}");
	successUrl.searchParams.set("redirect", redirectPath);

	const checkoutSession = await stripe.createCheckoutSession({
		priceId: price.id,
		customerId: customer.stripeCustomerId,
		successUrl: successUrl.toString(),
		cancelUrl: buildAbsoluteUrl(routeCtx, ctx, redirectPath),
	});

	return { ok: true, url: checkoutSession.url };
}

export async function checkoutCompleteHandler(routeCtx: RouteContext, ctx: PluginContext) {
	const body = isRecord(routeCtx.input) ? routeCtx.input : {};
	const checkoutSessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";

	if (!checkoutSessionId) {
		return { ok: false, error: "A checkout session is required." };
	}
	if (!(await isEmailReady(ctx))) {
		return { ok: false, error: "Email delivery is not configured for this site yet." };
	}

	const settings = await loadSettings(ctx);
	if (!settings.stripeSecretKey) {
		return { ok: false, error: "Stripe is not configured yet." };
	}

	const stripe = new StripeClient(settings.stripeSecretKey, ctx.http!.fetch);
	const checkoutSession = await stripe.getCheckoutSession(checkoutSessionId);
	if (checkoutSession.status !== "complete") {
		return { ok: false, error: "Your Stripe checkout has not completed yet." };
	}
	if (
		checkoutSession.payment_status !== "paid" &&
		checkoutSession.payment_status !== "no_payment_required"
	) {
		return { ok: false, error: "Your Stripe payment has not completed yet." };
	}

	const email = normalizeEmail(
		checkoutSession.customer_details?.email ?? checkoutSession.customer_email ?? null,
	);
	if (!email) {
		return { ok: false, error: "Stripe did not return a customer email for this checkout." };
	}

	let existing: CustomerRecord | null;
	try { existing = await getCustomerRecordByEmail(ctx, email); }
	catch { return { ok: false, error: "Migrated customer identity requires review." }; }
	try {
		if (hasMigrationBinding(existing)) {
			if (checkoutSession.customer !== existing.stripeCustomerId) throw new Error("Customer mismatch");
			await verifyMigratedCustomer(existing, stripe, email, settings);
		} else if (typeof checkoutSession.customer === "string" && checkoutSession.customer) {
			await verifyCustomerAssociation(ctx, stripe, email, checkoutSession.customer, settings);
		}
	} catch {
		return { ok: false, error: "Unable to verify migrated Stripe customer. Contact the site administrator." };
	}
	if (typeof checkoutSession.customer === "string" && checkoutSession.customer) {
		await upsertCustomerRecord(ctx, email, checkoutSession.customer);
	}

	const result = await sendMagicLink(routeCtx, ctx, {
		email,
		intent: "signin",
		redirect: sanitizeRedirectPath(body.redirect, settings.accountPath),
	});

	if ("error" in result) return result;
	return {
		ok: true,
		email,
		message: "Check your inbox for a sign-in link to finish unlocking your access.",
	};
}
