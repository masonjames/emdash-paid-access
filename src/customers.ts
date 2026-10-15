// Copyright 2026 Stranger Studios.
// Modified by Mason James, 2026-09-23.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PluginContext } from "emdash/plugin";

import { StripeClient } from "./stripe.js";
import type { CustomerRecord, MigrationCustomerBinding, MigrationCustomerRegistry, PaidAccessSettings } from "./types.js";
import { isRecord, normalizeEmail, nowIso, unwrapStoredRecord } from "./utils.js";

/** Presence, even malformed, must never downgrade a migrated identity to email lookup. */
export function hasMigrationBinding(record: CustomerRecord | null): record is CustomerRecord & { migrationBinding: unknown } {
	return record !== null && Object.hasOwn(record, "migrationBinding");
}

function bindingOf(record: { email: unknown; stripeCustomerId: unknown; migrationBinding?: unknown }, email: string): MigrationCustomerBinding {
	const binding: unknown = record.migrationBinding;
	if (!isRecord(binding) || binding.version !== 1 ||
		Object.keys(binding).some(key => !["version", "accountId", "environment", "sourceSha256", "credentialSha256"].includes(key)) ||
		typeof binding.accountId !== "string" || binding.accountId.trim() !== binding.accountId || !/^(?:acct_[A-Za-z0-9]{1,255}|[A-Za-z0-9]{32})$/.test(binding.accountId) ||
		(binding.environment !== "test" && binding.environment !== "live") ||
		typeof binding.sourceSha256 !== "string" || binding.sourceSha256.length !== 64 || !/^[a-f0-9]{64}$/.test(binding.sourceSha256) ||
		typeof binding.credentialSha256 !== "string" || binding.credentialSha256.length !== 64 || !/^[a-f0-9]{64}$/.test(binding.credentialSha256) ||
		typeof record.stripeCustomerId !== "string" || record.stripeCustomerId.trim() !== record.stripeCustomerId || !/^cus_[A-Za-z0-9]+$/.test(record.stripeCustomerId) ||
		!normalizeEmail(email) || record.email !== normalizeEmail(email)) {
		throw new Error("Migrated customer identity requires review.");
	}
	return { version: 1, accountId: binding.accountId, environment: binding.environment, sourceSha256: binding.sourceSha256, credentialSha256: binding.credentialSha256 };
}

export const MIGRATION_REGISTRY_KEY = "migration:customer-bindings:v1";

async function migrationRegistry(ctx: PluginContext): Promise<MigrationCustomerRegistry | null> {
	const raw: unknown = await ctx.kv.get(MIGRATION_REGISTRY_KEY);
	if (raw == null) return null;
	if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.members) ||
		Object.keys(raw).some(key => key !== "version" && key !== "members") ||
		new TextEncoder().encode(JSON.stringify(raw)).byteLength > 100_000) {
		throw new Error("Migrated customer registry requires review.");
	}
	const members: MigrationCustomerRegistry["members"] = {};
	const ids = new Set<string>();
	for (const [email, value] of Object.entries(raw.members)) {
		if (normalizeEmail(email) !== email || !isRecord(value) || typeof value.stripeCustomerId !== "string" ||
			Object.keys(value).some(key => key !== "stripeCustomerId" && key !== "migrationBinding" && key !== "blocked") ||
			(Object.hasOwn(value, "blocked") && value.blocked !== true) || ids.has(value.stripeCustomerId)) {
			throw new Error("Migrated customer registry requires review.");
		}
		const migrationBinding = bindingOf({ email, ...value, stripeCustomerId: value.stripeCustomerId }, email);
		ids.add(value.stripeCustomerId);
		members[email] = { stripeCustomerId: value.stripeCustomerId, migrationBinding, ...(value.blocked === true ? { blocked: true } : {}) };
	}
	return { version: 1, members };
}

function registryMatch(record: CustomerRecord | null, email: string, registry: MigrationCustomerRegistry | null): void {
	const expected = registry?.members[email];
	if (expected?.blocked) throw new Error("Migrated customer identity is blocked pending review.");
	if (!expected && !hasMigrationBinding(record)) return;
	if (!expected || !hasMigrationBinding(record) || record.stripeCustomerId !== expected.stripeCustomerId ||
		JSON.stringify(bindingOf(record, email)) !== JSON.stringify(expected.migrationBinding)) {
		throw new Error("Migrated customer record no longer matches its registry.");
	}
}

async function verifyMigrationConfiguration(binding: MigrationCustomerBinding, settings?: PaidAccessSettings): Promise<void> {
	if (!settings?.stripeSecretKey || binding.accountId !== settings.stripeAccountId ||
		binding.environment !== settings.stripeEnvironment) {
		throw new Error("Migrated customer configuration requires review.");
	}
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(settings.stripeSecretKey));
	const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
	if (fingerprint !== binding.credentialSha256) throw new Error("Migrated customer configuration requires review.");
}

/** Validate before provider calls; the importer independently verifies the key's account. */
export async function verifyMigratedCustomer(
	record: CustomerRecord, stripe: StripeClient, email: string, settings?: PaidAccessSettings,
): Promise<void> {
	const binding = bindingOf(record, email);
	await verifyMigrationConfiguration(binding, settings);
	const customer = await stripe.getCustomer(record.stripeCustomerId);
	if (!isRecord(customer) || customer.id !== record.stripeCustomerId ||
		(customer.deleted !== undefined && customer.deleted !== false) ||
		normalizeEmail(customer.email) !== record.email || customer.livemode !== (binding.environment === "live")) {
		throw new Error("Migrated customer identity could not be verified.");
	}
}

/** Only email-search access loops may skip this specific foreign association. */
export class ForeignMigratedCustomerError extends Error {
	constructor() { super("Stripe customer belongs to another migrated identity."); }
}

/** Indexed reverse lookup prevents a changed email from creating a second identity. */
async function migratedAssociation(ctx: PluginContext, email: string, customerId: string, settings?: PaidAccessSettings): Promise<CustomerRecord | null> {
	const registry = await migrationRegistry(ctx);
	if (registry?.members[normalizeEmail(email) ?? ""]?.blocked) throw new Error("Migrated customer identity is blocked pending review.");
	const registered = Object.entries(registry?.members ?? {}).find(([, member]) => member.stripeCustomerId === customerId);
	if (registered && registered[0] !== normalizeEmail(email)) {
		if (settings) await verifyMigrationConfiguration(registered[1].migrationBinding, settings);
		throw new ForeignMigratedCustomerError();
	}
	// The separate registry survives deletion or stripping of the customer row.
	if (registered) await getCustomerRecordByEmail(ctx, email);
	const result = await ctx.storage.customers.query({ where: { stripeCustomerId: customerId }, limit: 100 });
	if (result.hasMore) throw new Error("Customer associations require review.");
	let bound: CustomerRecord | null = null;
	for (const item of result.items) {
		const record = unwrapStoredRecord<CustomerRecord>(item);
		if (!hasMigrationBinding(record)) continue;
		registryMatch(record, email, registry);
		bindingOf(record, email);
		if (bound || record.stripeCustomerId !== customerId) throw new Error("Migrated customer associations require review.");
		bound = record;
	}
	return bound;
}

export async function verifyCustomerAssociation(
	ctx: PluginContext, stripe: StripeClient, email: string, customerId: string, settings?: PaidAccessSettings,
): Promise<boolean> {
	const bound = await migratedAssociation(ctx, email, customerId, settings);
	if (bound) await verifyMigratedCustomer(bound, stripe, email, settings);
	return bound !== null;
}

function storedCustomer(record: CustomerRecord, email: string): CustomerRecord {
	return {
		...record,
		// Imported identity must match its own stored email as well as the lookup key.
		email: hasMigrationBinding(record) ? record.email : email,
		updatedAt: record.updatedAt ?? record.createdAt,
	};
}

export async function getCustomerRecordByEmail(ctx: PluginContext, email: string): Promise<CustomerRecord | null> {
	const normalizedEmail = normalizeEmail(email);
	if (!normalizedEmail) {
		return null;
	}

	const registry = await migrationRegistry(ctx);
	const direct = unwrapStoredRecord<CustomerRecord>(await ctx.storage.customers.get(normalizedEmail));
	if (direct) {
		registryMatch(direct, normalizedEmail, registry);
		return storedCustomer(direct, normalizedEmail);
	}

	const queried = await ctx.storage.customers.query({ where: { email: normalizedEmail }, limit: 1 });
	const record = unwrapStoredRecord<CustomerRecord>(queried.items[0]);
	registryMatch(record, normalizedEmail, registry);
	if (!record) {
		return null;
	}

	return storedCustomer(record, normalizedEmail);
}

export async function upsertCustomerRecord(
	ctx: PluginContext,
	email: string,
	stripeCustomerId: string,
): Promise<CustomerRecord> {
	const normalizedEmail = normalizeEmail(email);
	if (!normalizedEmail) {
		throw new Error("A valid customer email is required.");
	}

	const reverse = await migratedAssociation(ctx, normalizedEmail, stripeCustomerId);
	const existing = await getCustomerRecordByEmail(ctx, normalizedEmail);
	if (hasMigrationBinding(existing)) {
		bindingOf(existing, normalizedEmail);
		if (existing.stripeCustomerId !== stripeCustomerId) throw new Error("Migrated customer association cannot be replaced.");
		return existing;
	}
	if (reverse) return reverse;
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
	ctx: PluginContext,
	stripe: StripeClient,
	email: string,
	settings?: PaidAccessSettings,
): Promise<CustomerRecord> {
	const normalizedEmail = normalizeEmail(email);
	if (!normalizedEmail) {
		throw new Error("A valid customer email is required.");
	}

	const existing = await getCustomerRecordByEmail(ctx, normalizedEmail);
	if (hasMigrationBinding(existing)) {
		await verifyMigratedCustomer(existing, stripe, normalizedEmail, settings);
		return existing;
	}
	if (existing?.stripeCustomerId) {
		await verifyCustomerAssociation(ctx, stripe, normalizedEmail, existing.stripeCustomerId, settings);
		return existing;
	}

	const stripeCustomers = await stripe.getCustomersByEmail(normalizedEmail);
	const stripeCustomerId = stripeCustomers.data[0]?.id ?? (await stripe.createCustomer(normalizedEmail)).id;
	await verifyCustomerAssociation(ctx, stripe, normalizedEmail, stripeCustomerId, settings);
	return upsertCustomerRecord(ctx, normalizedEmail, stripeCustomerId);
}
