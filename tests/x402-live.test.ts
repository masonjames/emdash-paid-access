// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { X402Enforcer } from "@emdash-cms/x402";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";

import { serveAgentEntry } from "../src/agent.js";
import type { AgentSettings, ContentRestrictionRecord } from "../src/types.js";

const payTo = process.env.PHB_TEST_PAY_TO;
const privateKey = process.env.PHB_TEST_PRIVATE_KEY;

describe.skipIf(process.env.PAID_ACCESS_LIVE_TEST !== "1" || !payTo || !privateKey)("live Base Sepolia x402", () => {
	it("pays test USDC, receives Markdown and stores a receipt", async () => {
		const context = { locals: {} as { x402?: X402Enforcer } };
		const { onRequest } = await import("@emdash-cms/x402/middleware");
		await (onRequest as any)(context, async () => new Response(null));
		const enforcer = context.locals.x402 as X402Enforcer;
		const settings: AgentSettings = {
			mode: "paid",
			rail: "origin-x402",
			payTo: payTo as string,
			network: "eip155:84532",
			edgeTrust: "none",
		};
		const entry = {
			id: "live-test-post",
			collectionSlug: "posts",
			slug: "live-test-post",
			title: "Live x402 test post",
			canonicalUrl: "https://example.test/blog/live-test-post/",
			content: [{ _type: "block", style: "normal", markDefs: [], children: [{ _type: "span", text: "Live paid body", marks: [] }] }],
		};
		const rule: ContentRestrictionRecord = {
			contentId: entry.id,
			collectionSlug: entry.collectionSlug,
			slug: entry.slug,
			policy: "agents-pay",
			agentPrice: "$0.001",
			passEligible: false,
			createdAt: new Date().toISOString(),
		};
		const put = vi.fn();
		const routeFetch = async (input: RequestInfo | URL, init?: RequestInit) => serveAgentEntry({
			request: new Request(input, init),
			entry,
			rules: [rule],
			settings,
			enforcer,
			receipts: { put },
		});

		const unpaid = await routeFetch("https://example.test/agents/posts/live-test-post.md");
		expect(unpaid.status).toBe(402);
		const account = privateKeyToAccount(privateKey as `0x${string}`);
		const client = new x402Client().register("eip155:84532", new ExactEvmScheme(account));
		const paid = await wrapFetchWithPayment(routeFetch as typeof fetch, client)(
			"https://example.test/agents/posts/live-test-post.md",
		);
		expect(paid.status).toBe(200);
		expect(paid.headers.get("payment-response")).toBeTruthy();
		expect(await paid.text()).toContain("Live paid body");
		expect(put).toHaveBeenCalledOnce();
	}, 60_000);
});
