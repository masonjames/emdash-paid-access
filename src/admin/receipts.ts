// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { Block, BlockResponse } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash/plugin";
import type { ReceiptRecord } from "../types.js";
import { normalizeAgentPrice, priceMicros } from "../restrictions.js";
import { isRecord } from "../utils.js";
import { allRows, context, loadMore } from "./shared.js";

export function money(micros: bigint): string {
	if (micros > 0n && micros < 10_000n) return `$0.${micros.toString().padStart(6, "0")}`;
	const cents = (micros + 5_000n) / 10_000n;
	return `$${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}
export function receiptTotal(receipts: Pick<ReceiptRecord, "amount">[]): bigint {
	return receipts.reduce((sum, receipt) => sum + priceMicros(receipt.amount), 0n);
}
function receipt(data: unknown): ReceiptRecord | null {
	if (!isRecord(data) || !normalizeAgentPrice(data.amount) || !["slug", "payer", "network", "transaction", "createdAt"].every(key => typeof data[key] === "string") || !Number.isFinite(Date.parse(String(data.createdAt)))) return null;
	return { ...data, amount: normalizeAgentPrice(data.amount)! } as unknown as ReceiptRecord;
}
export async function receiptMetrics(ctx: PluginContext, now = Date.now()) {
	const receipts = (await allRows(ctx.storage.receipts)).map(row => receipt(row.data)).filter((r): r is ReceiptRecord => r !== null);
	return { live: summarize(receipts.filter(r => r.network === "eip155:8453"), now), test: summarize(receipts.filter(r => r.network === "eip155:84532"), now, true) };
}
function summarize(receipts: ReceiptRecord[], now: number, test = false) {
	const start = new Date(now); start.setUTCHours(0, 0, 0, 0); start.setUTCDate(start.getUTCDate() - 29);
	const recent = receipts.filter(r => Date.parse(r.createdAt) >= start.getTime() && Date.parse(r.createdAt) <= now);
	const days = new Map<string, bigint>();
	for (let day = 0; day < 30; day++) days.set(new Date(start.getTime() + day * 86_400_000).toISOString().slice(0, 10), 0n);
	for (const r of recent) { const day = new Date(r.createdAt).toISOString().slice(0, 10); days.set(day, (days.get(day) ?? 0n) + priceMicros(r.amount)); }
	const chart: Block = { type: "chart", config: { chart_type: "timeseries", style: "bar", y_axis_name: test ? "Test USDC" : "Revenue (USD)", series: [{ name: test ? "Test USDC" : "Revenue (USD)", data: [...days].map(([day, amount]) => [Date.parse(day), Number(`${amount / 1_000_000n}.${(amount % 1_000_000n).toString().padStart(6, "0")}`)]) }] } };
	return { receipts, recent, revenue: money(receiptTotal(recent)), allTime: money(receiptTotal(receipts)), payers: new Set(recent.map(r => r.payer.toLowerCase())).size, chart };
}
const short = (value: string) => value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
export async function receiptsPage(ctx: PluginContext, cursor?: string, test = false): Promise<BlockResponse> {
	const totals = await receiptMetrics(ctx);
	const metrics = test ? totals.test : totals.live;
	const pageAction = test ? "receipts:test:more" : "receipts:more";
	const page = await ctx.storage.receipts.query({ where: { network: test ? "eip155:84532" : "eip155:8453" }, limit: 25, orderBy: { createdAt: "desc" }, ...(cursor ? { cursor } : {}) });
	return { blocks: [
		{ type: "header", text: "Receipts" }, context("Every paid agent read, recorded when the payment settles. Test USDC is never counted as revenue."),
		{ type: "actions", elements: [{ type: "button", action_id: "receipts:live", label: "Base · live" }, { type: "button", action_id: "receipts:test", label: "Base Sepolia · test" }] },
		context(test ? "Showing Base Sepolia test payments." : `Showing Base revenue. Base Sepolia test total: ${totals.test.allTime} test USDC.`),
		{ type: "stats", items: [{ label: test ? "Test USDC (30 days)" : "Revenue (30 days)", value: metrics.revenue }, { label: "Reads (30 days)", value: metrics.recent.length }, { label: "Payers (30 days)", value: metrics.payers }, { label: test ? "All-time test USDC" : "All-time revenue", value: metrics.allTime }] },
		...(metrics.receipts.length ? [metrics.chart, {
			type: "table" as const, block_id: "receipts:table", page_action_id: pageAction,
			columns: [{ key: "date", label: "Date", format: "relative_time" as const }, { key: "post", label: "Post" }, { key: "payer", label: "Payer", format: "code" as const }, { key: "amount", label: "Amount" }, { key: "network", label: "Network" }, { key: "transaction", label: "Transaction", format: "element" as const }],
			rows: page.items.flatMap(row => { const r = receipt(row.data); return r ? [{ date: r.createdAt, post: r.slug, payer: short(r.payer), amount: r.amount, network: r.network === "eip155:84532" ? "Base Sepolia" : "Base", transaction: { type: "link", label: short(r.transaction), target: { kind: "external", url: `https://${r.network === "eip155:84532" ? "sepolia." : ""}basescan.org/tx/${encodeURIComponent(r.transaction)}` } } }] : []; }),
		}, ...loadMore(pageAction, page.cursor)] : [{ type: "empty" as const, title: "No paid reads yet", description: "When an AI agent pays for a post, the payment shows up here with a link to the transaction." }]),
	] };
}
