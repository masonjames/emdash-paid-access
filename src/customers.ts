// Copyright 2026 Stranger Studios.
// Modified by Mason James, 2026-09-23.
// SPDX-License-Identifier: GPL-2.0-or-later

import { StripeClient } from "./stripe.js";
import type { CustomerRecord } from "./types.js";
import { normalizeEmail, nowIso, unwrapStoredRecord } from "./utils.js";

export async function getCustomerRecordByEmail(ctx: any, email: string): Promise<CustomerRecord | null> {
	const normalizedEmail = normalizeEmail(email);
	if (!normalizedEmail) {
		return null;
	}

	const direct = unwrapStoredRecord<CustomerRecord>(await ctx.storage.customers.get(normalizedEmail));
	if (direct) {
		return {
			email: normalizedEmail,
			stripeCustomerId: direct.stripeCustomerId,
			createdAt: direct.createdAt,
			updatedAt: direct.updatedAt ?? direct.createdAt,
		};
	}

	const queried = await ctx.storage.customers.query({ where: { email: normalizedEmail }, limit: 1 });
	const record = unwrapStoredRecord<CustomerRecord>(queried.items[0]);
	if (!record) {
		return null;
	}

	return {
		email: normalizedEmail,
		stripeCustomerId: record.stripeCustomerId,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt ?? record.createdAt,
	};
}

export async function upsertCustomerRecord(
	ctx: any,
	email: string,
	stripeCustomerId: string,
): Promise<CustomerRecord> {
	const normalizedEmail = normalizeEmail(email);
	if (!normalizedEmail) {
		throw new Error("A valid customer email is required.");
	}

	const existing = await getCustomerRecordByEmail(ctx, normalizedEmail);
	const record: CustomerRecord = {
		email: normalizedEmail,
		stripeCustomerId,
		createdAt: existing?.createdAt ?? nowIso(),
		updatedAt: nowIso(),
	};

	await ctx.storage.customers.put(normalizedEmail, record);
	return record;
}

export async function findOrCreateCustomerRecord(
	ctx: any,
	stripe: StripeClient,
	email: string,
): Promise<CustomerRecord> {
	const normalizedEmail = normalizeEmail(email);
	if (!normalizedEmail) {
		throw new Error("A valid customer email is required.");
	}

	const existing = await getCustomerRecordByEmail(ctx, normalizedEmail);
	if (existing?.stripeCustomerId) {
		return existing;
	}

	const stripeCustomers = await stripe.getCustomersByEmail(normalizedEmail);
	const stripeCustomerId = stripeCustomers.data[0]?.id ?? (await stripe.createCustomer(normalizedEmail)).id;
	return upsertCustomerRecord(ctx, normalizedEmail, stripeCustomerId);
}
