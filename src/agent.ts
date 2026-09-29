// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { EnforceResult, X402Enforcer } from "@emdash-cms/x402";
import { portableTextToMarkdown, type PortableTextBlock } from "emdash/client";

import { CONTENT_SIGNAL, resolveAccess } from "./resolver.js";
import { highestAgentPrice } from "./restrictions.js";
import type {
	AccessPolicy,
	AgentSettings,
	ContentRestrictionRecord,
	ReceiptRecord,
	TaxonomyRestrictionRecord,
} from "./types.js";

type Rule = ContentRestrictionRecord | TaxonomyRestrictionRecord;

export type AgentEntry = {
	id: string;
	collectionSlug: string;
	slug: string;
	title: string;
	canonicalUrl: string;
	content: PortableTextBlock[];
};

export type ReceiptStore = { put(id: string, receipt: ReceiptRecord): Promise<void> };

function empty(status: number): Response {
	return new Response(null, { status, headers: { "Cache-Control": "private, no-store" } });
}

function markdown(entry: AgentEntry, pricePaid: string): string {
	return [
		"---",
		`title: ${JSON.stringify(entry.title)}`,
		`canonical: ${JSON.stringify(entry.canonicalUrl)}`,
		`price_paid: ${JSON.stringify(pricePaid)}`,
		`content_signal: ${JSON.stringify(CONTENT_SIGNAL)}`,
		"---",
		"",
		portableTextToMarkdown(entry.content).trim(),
		"",
	].join("\n");
}

function markdownResponse(entry: AgentEntry, pricePaid: string, extraHeaders: Record<string, string> = {}): Response {
	return new Response(markdown(entry, pricePaid), {
		status: 200,
		headers: {
			...extraHeaders,
			"Cache-Control": "private, no-store",
			"Content-Signal": CONTENT_SIGNAL,
			"Content-Type": "text/markdown; charset=utf-8",
		},
	});
}

export async function serveAgentEntry(input: {
	request: Request;
	entry: AgentEntry;
	rules: Rule[];
	settings: AgentSettings;
	enforcer?: X402Enforcer;
	receipts: ReceiptStore;
}): Promise<Response> {
	if (new URL(input.request.url).pathname.endsWith(".json")) return empty(404);
	const policies = input.rules.map((rule) => rule.policy);
	const initial = resolveAccess({ policies, audience: "agent", agentsMode: input.settings.mode });
	if (initial.status === 200) return markdownResponse(input.entry, "$0");
	if (initial.status !== 402) return empty(initial.status);

	const price = highestAgentPrice(input.rules);
	if (!price || !input.settings.payTo || !input.settings.network) return empty(503);
	if (input.settings.rail === "gateway") return empty(401);
	if (!input.enforcer) return empty(503);

	try {
		const enforced = await input.enforcer.enforce(input.request, {
			price,
			payTo: input.settings.payTo,
			network: input.settings.network,
			description: input.entry.title,
			mimeType: "text/markdown",
		});
		if (enforced instanceof Response) return enforced;
		const result = enforced as EnforceResult;
		const settlement = result.settlement;
		const payer = result.payer || settlement?.payer;
		if (
			!result.paid
			|| !settlement?.success
			|| !settlement.transaction
			|| settlement.network !== input.settings.network
			|| !payer
		) return empty(503);
		const receipt: ReceiptRecord = {
			entryId: input.entry.id,
			collectionSlug: input.entry.collectionSlug,
			slug: input.entry.slug,
			rail: "origin-x402",
			payer,
			amount: price,
			network: input.settings.network,
			transaction: settlement.transaction,
			createdAt: new Date().toISOString(),
		};
		await input.receipts.put(`receipt:${settlement.transaction}`, receipt);
		return markdownResponse(input.entry, price, result.responseHeaders);
	} catch {
		return empty(503);
	}
}
