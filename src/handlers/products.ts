// Copyright 2026 Stranger Studios.
// Modified by Mason James, 2026-09-23.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PluginContext } from "emdash/plugin";
import type { RouteContext } from "../types.js";

import { StripeClient } from "../stripe.js";
import { loadSettings } from "./settings.js";

export async function productsHandler(routeCtx: RouteContext, ctx: PluginContext) {
	const settings = await loadSettings(ctx);
	if (!settings.stripeSecretKey) {
		return { ok: false, error: "Stripe is not configured yet." };
	}

	const stripe = new StripeClient(settings.stripeSecretKey, ctx.http!.fetch);
	const products = await stripe.getAllProducts();
	return { ok: true, products: products.data };
}
