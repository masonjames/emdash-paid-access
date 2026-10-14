// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { defineMiddleware } from "astro:middleware";
import { withReaderProvider, withTrustedPolicyMetadata, withTrustedContent, protectReaderResponse } from "emdash/reader-access";

/** Install after the Paid Access companion; host bindings remain in EmDash config. */
export const onRequest = defineMiddleware(async (context, next) => {
	const paid = context.locals.paidAccess;
	if (!paid) return protectReaderResponse(await next(), context.cache);
	paid.trustedContent = withTrustedContent;
	paid.trustedPolicyMetadata = withTrustedPolicyMetadata;
	const access = paid.access;
	const segments = paid.segments;
	paid.access = input => withTrustedPolicyMetadata(() => access(input));
	paid.segments = input => withTrustedPolicyMetadata(() => segments(input));
	const provider = paid.readerProvider();
	return withReaderProvider({
		id: provider.id,
		decide: resource => withTrustedPolicyMetadata(() => provider.decide(resource)),
	}, async () => protectReaderResponse(await next(), context.cache));
});
