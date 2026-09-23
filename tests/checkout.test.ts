// Copyright 2026 Stranger Studios.
// Modified by Mason James, 2026-09-23.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";

import { checkoutCompleteHandler, checkoutHandler } from "../src/handlers/checkout.js";
import { StripeClient } from "../src/stripe.js";
import { MASONJAMES_PLANS } from "./fixtures/masonjames-plans.js";

const TEST_PLANS = MASONJAMES_PLANS.map((plan) => ({
	...plan,
	stripeProductId:
		plan.slug === "default-product"
			? "prod_default"
			: plan.slug === "content-personall-ai"
				? "prod_all_access"
				: null,
}));

function createStorageCollection<T>() {
	const records = new Map<string, T>();
	return {
		records,
		get: vi.fn(async (id: string) => {
			const data = records.get(id);
			return data ? { id, data } : null;
		}),
		put: vi.fn(async (id: string, data: T) => {
			records.set(id, data);
		}),
		query: vi.fn(async (options?: { where?: Record<string, unknown> }) => {
			const items = [...records.entries()]
				.map(([id, data]) => ({ id, data }))
				.filter((item) => {
					if (!options?.where) return true;
					return Object.entries(options.where).every(([key, value]) => {
						const record = item.data as Record<string, unknown>;
						return record[key] === value;
					});
				});
			return { items, hasMore: false };
		}),
	};
}

function createCtx(options: {
	input?: Record<string, unknown>;
	requestUrl?: string;
	relativeUrls?: boolean;
	kvSeed?: Record<string, unknown>;
	email?: {
		send?: ReturnType<typeof vi.fn>;
	};
}) {
	const kvStore = new Map<string, unknown>(Object.entries(options.kvSeed ?? {}));
	const customers = createStorageCollection<Record<string, unknown>>();
	const sessions = createStorageCollection<Record<string, unknown>>();
	const authTokens = createStorageCollection<Record<string, unknown>>();

	return {
		input: options.input ?? {},
		request: new Request(
			options.requestUrl ?? "https://site.test/_emdash/api/plugins/paid-access/checkout",
		),
		storage: {
			customers,
			sessions,
			authTokens,
		},
		kv: {
			get: async <T>(key: string): Promise<T | null> => ((kvStore.get(key) as T | undefined) ?? null),
			set: async (key: string, value: unknown) => {
				kvStore.set(key, value);
			},
		},
		http: {
			fetch: vi.fn(),
		},
		email: options.email,
		site: {
			name: "Mason James",
		},
		log: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
		url(path: string) {
			if (options.relativeUrls) {
				return path;
			}
			return new URL(path, "https://site.test").toString();
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("checkoutHandler", () => {
	it("builds a checkout success URL that requires verified email completion instead of minting an app session", async () => {
		let captured:
			| {
				priceId: string;
				customerId: string;
				successUrl: string;
				cancelUrl: string;
			}
			| undefined;

		vi.spyOn(StripeClient.prototype, "findRecurringPriceForProduct").mockResolvedValue({
			id: "price_default_monthly",
			product: "prod_default",
			active: true,
			currency: "usd",
			unit_amount: 500,
			type: "recurring",
			recurring: { interval: "month", interval_count: 1 },
		});
		vi.spyOn(StripeClient.prototype, "getCustomersByEmail").mockResolvedValue({ data: [] });
		vi.spyOn(StripeClient.prototype, "createCustomer").mockResolvedValue({ id: "cus_123" });
		vi.spyOn(StripeClient.prototype, "createCheckoutSession").mockImplementation(async (params) => {
			captured = params;
			return { url: "https://checkout.stripe.com/pay/cs_test_123" };
		});

		const ctx = createCtx({
			input: {
				planSlug: "default-product",
				billingInterval: "monthly",
				email: "member@example.com",
				redirectUrl: "/resources/#subscribe",
			},
			kvSeed: {
				stripe_secret_key: "sk_test_123",
				humans_plans: TEST_PLANS,
			},
			email: {
				send: vi.fn(async () => undefined),
			},
			relativeUrls: true,
		});

		const result = await checkoutHandler(ctx);

		expect(result).toEqual({ ok: true, url: "https://checkout.stripe.com/pay/cs_test_123" });
		expect(ctx.storage.sessions.put).not.toHaveBeenCalled();
		expect(captured?.successUrl).toMatch(/^https:\/\/site\.test\/account\/complete\//);
		expect(captured?.successUrl).toContain("session_id=%7BCHECKOUT_SESSION_ID%7D");
		expect(captured?.successUrl).toContain("redirect=%2Fresources%2F%23subscribe");
		expect(captured?.successUrl).not.toContain("session=");
		expect(captured?.cancelUrl).toBe("https://site.test/resources/#subscribe");
	});

	it("refuses to start checkout when the selected email provider is not delivery-ready", async () => {
		const ctx = createCtx({
			input: {
				planSlug: "default-product",
				billingInterval: "monthly",
				email: "member@example.com",
				redirectUrl: "/resources/#subscribe",
			},
			kvSeed: {
				stripe_secret_key: "sk_test_123",
				humans_plans: TEST_PLANS,
			},
		});

		await expect(checkoutHandler(ctx)).resolves.toEqual({
			ok: false,
			error: "Email delivery is not configured for this site yet.",
		});
	});
});

describe("checkoutCompleteHandler", () => {
	it("verifies the Stripe checkout session and emails a magic link instead of creating a session", async () => {
		const send = vi.fn(async () => undefined);
		vi.spyOn(StripeClient.prototype, "getCheckoutSession").mockResolvedValue({
			id: "cs_test_123",
			status: "complete",
			payment_status: "paid",
			customer: "cus_123",
			customer_details: { email: "member@example.com" },
		});

		const ctx = createCtx({
			requestUrl:
				"https://site.test/_emdash/api/plugins/paid-access/checkout/complete?session_id=cs_test_123&redirect=%2Fresources%2F%23subscribe",
			kvSeed: {
				stripe_secret_key: "sk_test_123",
			},
			email: { send },
		});

		const result = await checkoutCompleteHandler(ctx);

		expect(result).toMatchObject({
			ok: true,
			email: "member@example.com",
		});
		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({
				to: "member@example.com",
				subject: expect.stringContaining("Sign in"),
			}),
		);
		expect(ctx.storage.sessions.put).not.toHaveBeenCalled();
		expect(ctx.storage.authTokens.put).toHaveBeenCalledTimes(1);
		expect(ctx.storage.customers.put).toHaveBeenCalledWith(
			"member@example.com",
			expect.objectContaining({ stripeCustomerId: "cus_123" }),
		);
		const authToken = ctx.storage.authTokens.records.values().next().value as Record<string, unknown>;
		expect(authToken.redirect).toBe("/resources/#subscribe");
	});
});
