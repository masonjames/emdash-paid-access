// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from "vitest";
import { money, receiptTotal } from "../src/admin/receipts.js";
import { action, admin, fixture, page, paid, receipt, rule } from "./fixtures/admin.js";

describe("receipts and overview", () => {
	it("adds dollar strings in integer micro-dollars", () => {
		expect(money(receiptTotal([receipt(), receipt(), receipt()]))).toBe("$0.15");
		expect(money(receiptTotal([receipt("$0.000001"), receipt("$0.000002")]))).toBe("$0.000003");
		expect(money(0n)).toBe("$0.00"); expect(money(15_000n)).toBe("$0.02");
	});
	it("renders the off widget and empty receipt ledger", async () => {
		const ctx = fixture(); expect((await admin(ctx, page("widget:overview"))).blocks).toMatchObject([{ type: "empty", title: "Paid Access is off", actions: [{ label: "Open settings", target: { kind: "plugin-page", path: "/settings" } }] }]);
		expect(JSON.stringify(await admin(ctx, page("/receipts")))).toContain("No paid reads yet");
	});
	it("separates test USDC from live revenue, including charts, payers and network links", async () => {
		const ctx = fixture({ ...paid, humansMode: "stripe", stripeEnvironment: "test" });
		for (let i = 0; i < 3; i++) await ctx.storage.receipts.put(String(i), receipt());
		await ctx.storage.receipts.put("old", { ...receipt("$1", "2020-01-01T00:00:00Z"), network: "eip155:8453" });
		await ctx.storage.restrictions.put("posts:1", rule);
		const live = await admin(ctx, page("/receipts"));
		expect(live.blocks.find(b => b.type === "stats")).toMatchObject({ items: [{ value: "$0.00" }, { value: 0 }, { value: 0 }, { value: "$1.00" }] });
		expect(JSON.stringify(live)).not.toContain("https://sepolia.basescan.org/tx/");
		expect(JSON.stringify(live)).toContain("https://basescan.org/tx/");
		const result = await admin(ctx, action("receipts:test"));
		expect(result.blocks.find(b => b.type === "stats")).toMatchObject({ items: [{ label: "Test USDC (30 days)", value: "$0.15" }, { value: 3 }, { value: 1 }, { value: "$0.15" }] });
		expect(result.blocks.find(b => b.type === "chart")).toMatchObject({ config: { style: "bar", series: [{ data: expect.any(Array) }] } });
		expect(JSON.stringify(result)).toContain("https://sepolia.basescan.org/tx/"); expect(JSON.stringify(result)).not.toContain("https://basescan.org/tx/");
		const widget = await admin(ctx, page("widget:overview")); expect(widget.blocks.find(b => b.type === "stats")).toMatchObject({ items: [{ value: "$0.00" }, { value: 0 }, { value: 1 }] });
		expect(JSON.stringify(widget)).toContain("Test mode: agents pay with test USDC"); expect(JSON.stringify(widget)).toContain("Members: Stripe (test mode)");
	});
	it("paginates without truncating all-time totals", async () => {
		const ctx = fixture(paid); const createdAt = new Date().toISOString(); for (let i = 0; i < 205; i++) await ctx.storage.receipts.put(String(i), { ...receipt("$0.000001", createdAt), slug: `post-${i}` });
		const result = await admin(ctx, action("receipts:test")); expect(result.blocks.find(b => b.type === "stats")).toMatchObject({ items: [{ value: "$0.000205" }, { value: 205 }, { value: 1 }, { value: "$0.000205" }] });
		expect(result.blocks.filter(b => b.type === "actions").at(-1)).toMatchObject({ elements: [{ label: "Load more", value: "25" }] });
		const next = await admin(ctx, action("receipts:test:more", "25")); expect(next.blocks.find(b => b.type === "table")).toMatchObject({ rows: expect.arrayContaining([expect.objectContaining({ post: "post-25" })]) });
	});
});

// The existing receipt writer accepts whitespace around otherwise valid amounts.
it("reads normalized amounts without changing stored receipts", async () => {
	const ctx = fixture(paid); await ctx.storage.receipts.put("padded", receipt(" $0.05 "));
	const result = await admin(ctx, action("receipts:test"));
	expect(result.blocks.find(b => b.type === "stats")).toMatchObject({ items: [{ value: "$0.05" }, { value: 1 }, { value: 1 }, { value: "$0.05" }] });
	expect(await ctx.storage.receipts.get("padded")).toMatchObject({ amount: " $0.05 " });
});
