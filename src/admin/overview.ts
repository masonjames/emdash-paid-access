// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { BlockResponse } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash/plugin";
import { loadSettings } from "../handlers/settings.js";
import { normalizeContentRestriction } from "../restrictions.js";
import { allRows, banner, context, link } from "./shared.js";
import { receiptMetrics } from "./receipts.js";

export async function overview(ctx: PluginContext): Promise<BlockResponse> {
	const s = await loadSettings(ctx);
	if (s.agents.mode === "off" && s.humans.mode === "off") return { blocks: [{ type: "empty", title: "Paid Access is off", description: "Charge people, AI agents, or both. Nothing changes on your site until you turn one on.", actions: [link("Open settings", "/settings")] }] };
	const totals = await receiptMetrics(ctx);
	const metrics = totals.live;
	const rules = (await allRows(ctx.storage.restrictions)).filter(row => normalizeContentRestriction(row.data));
	const agents = s.agents.mode === "off" ? "Off" : s.agents.network === "eip155:84532" ? "On — Base Sepolia test network" : "On — Base";
	const humans = s.humans.mode === "off" ? "Off" : s.humans.mode === "delegate" ? "Restrict With Stripe" : s.stripeEnvironment === "test" ? "Stripe (test mode)" : "Stripe";
	return { blocks: [
		{ type: "stats", items: [{ label: "Agent revenue (30 days)", value: metrics.revenue }, { label: "Paid agent reads (30 days)", value: metrics.recent.length }, { label: "Posts with rules", value: rules.length }] },
		...(s.agents.mode !== "off" && metrics.receipts.length ? [metrics.chart] : []),
		context(`Agents: ${agents} · Members: ${humans}`),
		...(totals.test.receipts.length ? [context(`Base Sepolia test payments (30 days): ${totals.test.revenue} test USDC across ${totals.test.recent.length} reads. Excluded from revenue.`)] : []),
		...(s.agents.network === "eip155:84532" ? [banner("Test mode: agents pay with test USDC on Base Sepolia. Before using Base, configure a production facilitator in the Astro companion and rebuild the site.")] : []),
		{ type: "actions", elements: [link("Rules", "/rules"), link("Receipts", "/receipts")] },
	] };
}
