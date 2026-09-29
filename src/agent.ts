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

// An agent that can't have the post gets what a paywall gives people: why, where
// to read it, and what it can buy instead.
function notForSale(entry: AgentEntry, status: number, offersUrl?: string): Response {
	const body = [
		"---",
		`title: ${JSON.stringify(entry.title)}`,
		`canonical: ${JSON.stringify(entry.canonicalUrl)}`,
		"---",
		"",
		status === 403 ? "This post is for subscribers. It isn't sold to AI agents." : "This post isn't offered to AI agents.",
		"",
		`- Read it on the site: ${entry.canonicalUrl}`,
		...(offersUrl ? [`- Posts AI agents can buy, with prices: ${offersUrl}`] : []),
		"",
	].join("\n");
	return new Response(body, { status, headers: { "Cache-Control": "private, no-store", "Content-Type": "text/markdown; charset=utf-8" } });
}

function markdownResponse(body: string, extraHeaders: Record<string, string> = {}): Response {
	return new Response(body, {
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
	log?: { error(message: string, data?: unknown): void; warn(message: string, data?: unknown): void };
	/** Absolute URL of the offers list, linked when this entry isn't for sale. */
	offersUrl?: string;
}): Promise<Response> {
	if (new URL(input.request.url).pathname.endsWith(".json")) return empty(404);
	const policies = input.rules.map((rule) => rule.policy);
	const initial = resolveAccess({ policies, audience: "agent", agentsMode: input.settings.mode, freeByDefault: input.settings.freeByDefault });
	if (initial.status === 200) return markdownResponse(markdown(input.entry, "$0"));
	if ((initial.status === 403 || initial.status === 404) && input.settings.mode !== "off") return notForSale(input.entry, initial.status, input.offersUrl);
	if (initial.status !== 402) return empty(initial.status);

	const price = highestAgentPrice(input.rules);
	if (!price || !input.settings.payTo || !input.settings.network) return empty(503);
	if (input.settings.rail === "gateway") return empty(401);
	if (!input.enforcer) return empty(503);
	let body: string;
	try {
		body = markdown(input.entry, price);
	} catch (error) {
		input.log?.error("Failed to build agent Markdown", error);
		return empty(503);
	}

	let enforced: Awaited<ReturnType<X402Enforcer["enforce"]>>;
	try {
		enforced = await input.enforcer.enforce(input.request, {
			price,
			payTo: input.settings.payTo,
			network: input.settings.network,
			description: input.entry.title,
			mimeType: "text/markdown",
		});
	} catch (error) {
		input.log?.error("Agent payment enforcement failed", error);
		return empty(503);
	}
	if (enforced instanceof Response) {
		enforced.headers.set("Cache-Control", "private, no-store");
		return enforced;
	}
	const result = enforced as EnforceResult;
	const settlement = result.settlement;
	if (!settlement?.success || !settlement.transaction) return empty(503);
	if (settlement.network !== input.settings.network) input.log?.warn("Settlement network differs from configured network", settlement);
	const payer = result.payer ?? settlement.payer ?? "unknown";
	if (payer === "unknown") input.log?.warn("Settled agent payment has no payer", settlement);
	try {
		const receipt: ReceiptRecord = {
			entryId: input.entry.id,
			collectionSlug: input.entry.collectionSlug,
			slug: input.entry.slug,
			rail: "origin-x402",
			payer,
			amount: price,
			network: settlement.network,
			transaction: settlement.transaction,
			createdAt: new Date().toISOString(),
		};
		await input.receipts.put(`receipt:${settlement.transaction}`, receipt);
	} catch (error) {
		input.log?.error("Failed to record settled agent payment", error);
	}
	return markdownResponse(body, result.responseHeaders);
}
