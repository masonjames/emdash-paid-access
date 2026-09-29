// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { defineMiddleware } from "astro:middleware";
import options from "virtual:paid-access/config";
import { createPaidAccess } from "./runtime.js";

export const onRequest = defineMiddleware((context, next) => {
	context.locals.paidAccess = createPaidAccess(context.locals, context.request, context.cookies.get("phb_session")?.value ?? null, options);
	return next();
});
