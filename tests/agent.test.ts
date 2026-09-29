// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { X402Enforcer } from "@emdash-cms/x402";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import {
	encodePaymentRequiredHeader,
	encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentRequired, SchemeNetworkClient } from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";

import { serveAgentEntry } from "../src/agent.js";
import type { AgentSettings, ContentRestrictionRecord } from "../src/types.js";

const settings: AgentSettings = {
	mode: "paid",
	rail: "origin-x402",
	payTo: "0x1111111111111111111111111111111111111111",
	network: "eip155:84532",
	edgeTrust: "none",
};

const entry = {
	id: "post-1",
	collectionSlug: "posts",
	slug: "paid-post",
	title: "Paid post",
	canonicalUrl: "https://example.test/blog/paid-post/",
	content: [{ _type: "block", style: "normal", markDefs: [], children: [{ _type: "span", text: "Secret body", marks: [] }] }],
};

function rule(policy: ContentRestrictionRecord["policy"], agentPrice: string | null = "$0.01"): ContentRestrictionRecord {
	return {
		contentId: entry.id,
		collectionSlug: entry.collectionSlug,
		slug: entry.slug,
		policy,
		agentPrice,
		passEligible: false,
		createdAt: "2026-09-23T00:00:00.000Z",
	};
}

describe("agent Markdown response", () => {
	it("serves public Portable Text as Markdown with required metadata", async () => {
		const response = await serveAgentEntry({
			request: new Request("https://example.test/agents/posts/paid-post.md"),
			entry,
			rules: [rule("public", null)],
			settings,
			receipts: { put: vi.fn() },
		});
		const body = await response.text();
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("content-signal")).toBe("ai-train=no, search=yes, ai-input=yes");
		expect(body).toContain("title: \"Paid post\"");
		expect(body).toContain("canonical: \"https://example.test/blog/paid-post/\"");
		expect(body).toContain("price_paid: \"$0\"");
		expect(body).toContain("Secret body");
	});

	it("never serves paid content at a .json path", async () => {
		const response = await serveAgentEntry({
			request: new Request("https://example.test/agents/posts/paid-post.json"),
			entry,
			rules: [rule("public", null)],
			settings,
			receipts: { put: vi.fn() },
		});
		expect(response.status).toBe(404);
		expect(await response.text()).toBe("");
	});

	it("lets @x402/fetch negotiate 402 then receive paid Markdown and stores a receipt", async () => {
		const put = vi.fn();
		const paymentRequired: PaymentRequired = {
			x402Version: 2,
			resource: { url: "/agents/posts/paid-post.md", mimeType: "text/markdown" },
			accepts: [{
				scheme: "exact",
				network: "eip155:84532",
				asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7c",
				amount: "10000",
				payTo: settings.payTo,
				maxTimeoutSeconds: 60,
				extra: {},
			}],
		};
		const settlement = {
			success: true,
			transaction: "0xtesttransaction",
			network: "eip155:84532" as const,
			payer: "0x2222222222222222222222222222222222222222",
		};
		const enforcer = {
			enforce: vi.fn(async (request: Request) => request.headers.has("payment-signature")
				? { paid: true, skipped: false, payer: settlement.payer, settlement, responseHeaders: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settlement) } }
				: new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired) } })),
		} as unknown as X402Enforcer;
		const routeFetch = async (input: RequestInfo | URL, init?: RequestInit) => serveAgentEntry({
			request: new Request(input, init),
			entry,
			rules: [rule("agents-pay")],
			settings,
			enforcer,
			receipts: { put },
		});

		const unpaid = await routeFetch("https://example.test/agents/posts/paid-post.md");
		expect(unpaid.status).toBe(402);

		const scheme: SchemeNetworkClient = {
			scheme: "exact",
			async createPaymentPayload(x402Version) {
				return { x402Version, payload: { signature: "test-only" } };
			},
		};
		const paidFetch = wrapFetchWithPayment(
			routeFetch as typeof fetch,
			new x402Client().setSpendControls(false).register("eip155:84532", scheme),
		);
		const paid = await paidFetch("https://example.test/agents/posts/paid-post.md");
		expect(paid.status).toBe(200);
		expect(paid.headers.get("payment-response")).toBeTruthy();
		expect(await paid.text()).toContain("Secret body");
		expect(put).toHaveBeenCalledWith("receipt:0xtesttransaction", expect.objectContaining({
			entryId: "post-1",
			amount: "$0.01",
			network: "eip155:84532",
			transaction: "0xtesttransaction",
		}));
	});
});
