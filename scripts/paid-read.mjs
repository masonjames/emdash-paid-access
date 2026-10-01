// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

// Pay for one agent read with test USDC and print what came back as JSON.
// Only Base Sepolia is registered, so a mainnet challenge is refused, not paid.
//
//   PHB_TEST_PRIVATE_KEY=0x… node scripts/paid-read.mjs https://host/agents/posts/slug.md

import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

const url = process.argv[2];
const key = process.env.PHB_TEST_PRIVATE_KEY;
if (!url || !key) {
	console.error("Usage: PHB_TEST_PRIVATE_KEY=0x… node scripts/paid-read.mjs <agent-url>");
	process.exit(2);
}

const client = new x402Client().register("eip155:84532", new ExactEvmScheme(privateKeyToAccount(key)));
const response = await wrapFetchWithPayment(fetch, client)(url, { headers: { "User-Agent": "paid-access-check/1.0" } });
console.log(JSON.stringify({
	status: response.status,
	cacheControl: response.headers.get("cache-control"),
	paymentResponse: Boolean(response.headers.get("payment-response")),
	body: await response.text(),
}));
