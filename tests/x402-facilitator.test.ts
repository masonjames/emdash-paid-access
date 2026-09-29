// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { X402Enforcer } from "@emdash-cms/x402";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { serveAgentEntry } from "../src/agent.js";
import type { AgentSettings, ContentRestrictionRecord } from "../src/types.js";

const mocks = vi.hoisted(() => ({
	build: vi.fn(),
	createRequired: vi.fn(),
	decode: vi.fn(),
	encodeRequired: vi.fn(),
	encodeResponse: vi.fn(),
	find: vi.fn(),
	initialize: vi.fn(),
	register: vi.fn(),
	settle: vi.fn(),
	verify: vi.fn(),
}));

vi.mock("@x402/core/server", () => ({
	HTTPFacilitatorClient: vi.fn(),
	x402ResourceServer: vi.fn(function () {
		return {
			buildPaymentRequirements: mocks.build,
			createPaymentRequiredResponse: mocks.createRequired,
			findMatchingRequirements: mocks.find,
			initialize: mocks.initialize,
			register: mocks.register,
			settlePayment: mocks.settle,
			verifyPayment: mocks.verify,
		};
	}),
}));

vi.mock("@x402/core/http", () => ({
	decodePaymentSignatureHeader: mocks.decode,
	encodePaymentRequiredHeader: mocks.encodeRequired,
	encodePaymentResponseHeader: mocks.encodeResponse,
}));

vi.mock("@x402/evm/exact/server", () => ({ ExactEvmScheme: vi.fn() }));

const requirements = [{
	scheme: "exact",
	network: "eip155:84532",
	asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7c",
	amount: "10000",
	payTo: "0x1111111111111111111111111111111111111111",
	maxTimeoutSeconds: 60,
	extra: {},
}];

const settings: AgentSettings = {
	mode: "paid",
	rail: "origin-x402",
	payTo: requirements[0].payTo,
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

const rule: ContentRestrictionRecord = {
	contentId: entry.id,
	collectionSlug: entry.collectionSlug,
	slug: entry.slug,
	policy: "agents-pay",
	agentPrice: "$0.01",
	passEligible: false,
	createdAt: "2026-09-23T00:00:00.000Z",
};

let enforcer: X402Enforcer;

async function response(headers?: HeadersInit, put = vi.fn()) {
	return {
		put,
		response: await serveAgentEntry({
			request: new Request("https://example.test/agents/posts/paid-post.md", { headers }),
			entry,
			rules: [rule],
			settings,
			enforcer,
			receipts: { put },
		}),
	};
}

describe("@emdash-cms/x402 facilitator failures", () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		mocks.initialize.mockResolvedValue(undefined);
		mocks.register.mockReturnThis();
		mocks.build.mockResolvedValue(requirements);
		mocks.createRequired.mockImplementation(async (_requirements, resource, error) => ({
			x402Version: 2,
			error,
			resource,
			accepts: requirements,
		}));
		mocks.encodeRequired.mockReturnValue("encoded-payment-required");
		mocks.encodeResponse.mockReturnValue("encoded-payment-response");
		const context = { locals: {} as { x402?: X402Enforcer } };
		const { onRequest } = await import("@emdash-cms/x402/middleware");
		await (onRequest as any)(context, async () => new Response(null));
		enforcer = context.locals.x402 as X402Enforcer;
	});

	it("returns the x402 402 shape and per-request overrides", async () => {
		const { response: result } = await response();
		expect(result.status).toBe(402);
		expect(result.headers.get("payment-required")).toBe("encoded-payment-required");
		expect(await result.json()).toMatchObject({ x402Version: 2, error: "Payment required" });
		expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({
			price: "0.01",
			payTo: settings.payTo,
			network: settings.network,
		}));
	});

	it("fails closed with no body for a malformed signature", async () => {
		mocks.decode.mockImplementation(() => { throw new Error("bad signature"); });
		const { response: result } = await response({ "payment-signature": "bad" });
		expect(result.status).toBe(503);
		expect(await result.text()).toBe("");
	});

	it("returns a fresh 402 after facilitator verification failure without content", async () => {
		mocks.decode.mockReturnValue({ x402Version: 2, payload: {} });
		mocks.find.mockReturnValue(requirements[0]);
		mocks.verify.mockResolvedValue({ isValid: false, invalidReason: "invalid payment" });
		const { response: result } = await response({ "payment-signature": "invalid" });
		const body = await result.text();
		expect(result.status).toBe(402);
		expect(body).toContain("invalid payment");
		expect(body).not.toContain("Secret body");
	});

	it("fails closed with no body when settlement fails", async () => {
		mocks.decode.mockReturnValue({ x402Version: 2, payload: {} });
		mocks.find.mockReturnValue(requirements[0]);
		mocks.verify.mockResolvedValue({ isValid: true, payer: "0x2222222222222222222222222222222222222222" });
		mocks.settle.mockRejectedValue(new Error("facilitator unavailable"));
		const { response: result } = await response({ "payment-signature": "valid" });
		expect(result.status).toBe(503);
		expect(await result.text()).toBe("");
	});

	it("stores the settlement and returns PAYMENT-RESPONSE on success", async () => {
		mocks.decode.mockReturnValue({ x402Version: 2, payload: {} });
		mocks.find.mockReturnValue(requirements[0]);
		mocks.verify.mockResolvedValue({ isValid: true, payer: "0x2222222222222222222222222222222222222222" });
		mocks.settle.mockResolvedValue({
			success: true,
			transaction: "0xsettled",
			network: "eip155:84532",
			payer: "0x2222222222222222222222222222222222222222",
		});
		const put = vi.fn();
		const { response: result } = await response({ "payment-signature": "valid" }, put);
		expect(result.status).toBe(200);
		expect(result.headers.get("payment-response")).toBe("encoded-payment-response");
		expect(await result.text()).toContain("Secret body");
		expect(put).toHaveBeenCalledWith("receipt:0xsettled", expect.objectContaining({ transaction: "0xsettled" }));
	});
});
