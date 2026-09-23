// Copyright 2026 Stranger Studios.
// Modified by Mason James, 2026-09-23.
// SPDX-License-Identifier: GPL-2.0-or-later

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface StripeProduct {
	id: string;
	name: string;
	description: string | null;
	default_price: string | null;
	active: boolean;
	images: string[];
}

export interface StripePrice {
	id: string;
	product: string;
	active: boolean;
	currency: string;
	unit_amount: number | null;
	type: "one_time" | "recurring";
	recurring: { interval: string; interval_count: number } | null;
}

interface StripeSubscriptionList {
	data?: Array<{
		status?: string;
		items?: {
			data?: Array<{
				price?: {
					product?: string;
				};
			}>;
		};
	}>;
}

interface StripeInvoiceList {
	data?: Array<{
		subscription?: string | null;
		metadata?: Record<string, string>;
		lines?: {
			data?: Array<{
				price?: {
					product?: string;
				};
			}>;
		};
	}>;
}

export interface StripeCheckoutSession {
	id: string;
	status?: string | null;
	payment_status?: string | null;
	customer?: string | null;
	customer_email?: string | null;
	customer_details?: {
		email?: string | null;
	} | null;
}

export class StripeClient {
	constructor(
		private readonly secretKey: string,
		private readonly fetchFn: FetchFn,
	) {}

	private async request<T>(path: string, method = "GET", body?: Record<string, string | undefined>): Promise<T> {
		const searchParams = new URLSearchParams();
		if (body) {
			for (const [key, value] of Object.entries(body)) {
				if (typeof value === "string") {
					searchParams.set(key, value);
				}
			}
		}

		const response = await this.fetchFn(`https://api.stripe.com/v1${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${this.secretKey}`,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: method === "GET" ? undefined : searchParams.toString(),
		});

		const data = (await response.json()) as T & { error?: { message?: string } };
		if (!response.ok) {
			throw new Error(data.error?.message || `Stripe error ${response.status}`);
		}
		return data;
	}

	async getAllProducts(): Promise<{ data: StripeProduct[] }> {
		return this.request<{ data: StripeProduct[] }>("/products?active=true&limit=100");
	}

	async getPrice(id: string): Promise<StripePrice> {
		return this.request<StripePrice>(`/prices/${encodeURIComponent(id)}`);
	}

	async listPricesForProduct(productId: string): Promise<{ data: StripePrice[] }> {
		return this.request<{ data: StripePrice[] }>(
			`/prices?product=${encodeURIComponent(productId)}&active=true&limit=100`,
		);
	}

	async findRecurringPriceForProduct(productId: string, interval: "monthly" | "yearly"): Promise<StripePrice | null> {
		const prices = await this.listPricesForProduct(productId);
		const expectedInterval = interval === "monthly" ? "month" : "year";

		return (
			prices.data.find(
				(price) =>
					price.active &&
					price.type === "recurring" &&
					price.recurring?.interval === expectedInterval &&
					price.recurring.interval_count === 1,
			) ?? null
		);
	}

	async createCustomer(email: string): Promise<{ id: string }> {
		return this.request<{ id: string }>("/customers", "POST", { email });
	}

	async updateCustomerEmail(customerId: string, email: string): Promise<void> {
		await this.request(`/customers/${encodeURIComponent(customerId)}`, "POST", { email });
	}

	async getCustomersByEmail(email: string): Promise<{ data: Array<{ id: string }> }> {
		return this.request<{ data: Array<{ id: string }> }>(
			`/customers?email=${encodeURIComponent(email)}&limit=10`,
		);
	}

	async createCheckoutSession(params: {
		priceId: string;
		customerId: string;
		successUrl: string;
		cancelUrl: string;
	}): Promise<{ url: string }> {
		const price = await this.getPrice(params.priceId);
		const mode = price.type === "recurring" ? "subscription" : "payment";

		return this.request<{ url: string }>("/checkout/sessions", "POST", {
			"line_items[0][price]": params.priceId,
			"line_items[0][quantity]": "1",
			customer: params.customerId,
			success_url: params.successUrl,
			cancel_url: params.cancelUrl,
			mode,
		});
	}

	async createPortalSession(customerId: string, returnUrl: string): Promise<{ url: string }> {
		return this.request<{ url: string }>("/billing_portal/sessions", "POST", {
			customer: customerId,
			return_url: returnUrl,
		});
	}

	async getCheckoutSession(id: string): Promise<StripeCheckoutSession> {
		return this.request<StripeCheckoutSession>(`/checkout/sessions/${encodeURIComponent(id)}`);
	}

	async customerHasProduct(customerId: string, productIds: string[]): Promise<boolean> {
		if (!customerId || productIds.length === 0) {
			return false;
		}

		const subscriptions = await this.request<StripeSubscriptionList>(
			`/subscriptions?customer=${encodeURIComponent(customerId)}&status=all&limit=100`,
		);
		for (const subscription of subscriptions.data || []) {
			if (subscription.status !== "active" && subscription.status !== "trialing") {
				continue;
			}
			for (const item of subscription.items?.data || []) {
				if (productIds.includes(item.price?.product || "")) {
					return true;
				}
			}
		}

		const invoices = await this.request<StripeInvoiceList>(
			`/invoices?customer=${encodeURIComponent(customerId)}&status=paid&limit=100`,
		);
		for (const invoice of invoices.data || []) {
			if (invoice.subscription || invoice.metadata?.phbIgnore) {
				continue;
			}
			for (const line of invoice.lines?.data || []) {
				if (productIds.includes(line.price?.product || "")) {
					return true;
				}
			}
		}

		return false;
	}
}
