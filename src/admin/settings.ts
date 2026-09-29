// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { Block, BlockResponse, FormField } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash/plugin";
import { loadSettings, settingsHandler } from "../handlers/settings.js";
import { productsHandler } from "../handlers/products.js";
import type { RouteContext } from "../types.js";
import { banner, confirmButton, context, form, interaction, request, resultToast, str, textField } from "./shared.js";

export async function settingsPage(route: RouteContext, ctx: PluginContext, editSlug?: string, defaultTab = 0, extra: Block[] = []): Promise<BlockResponse> {
	const s = await loadSettings(ctx);
	const legacy = await ctx.kv.get("state:legacyPluginPresent") === true;
	const stripe = { field: "humans_mode", eq: "stripe" };
	const paid = { field: "agents_mode", eq: "paid" };
	const members: Block[] = [
		...(legacy ? [context("Restrict With Stripe controls member access while it is active. Use migration mode, or deactivate it before choosing Stripe memberships.")] : []),
		form("settings:members:save", "Save member settings", [
			{ type: "radio", action_id: "humans_mode", label: "Charge people", ...(legacy && s.humans.mode === "stripe" ? {} : { initial_value: s.humans.mode }), options: [{ value: "off", label: "Off" }, ...(!legacy ? [{ value: "stripe", label: "Stripe memberships" }] : []), { value: "delegate", label: "Use Restrict With Stripe (during migration)" }] },
			{ type: "secret_input", action_id: "stripe_secret_key", label: "Stripe secret key", has_value: Boolean(s.stripeSecretKey), condition: stripe },
			{ ...textField("stripe_publishable_key", "Stripe publishable key", s.stripePublishableKey), condition: stripe },
			{ type: "toggle", action_id: "show_excerpts", label: "Show an excerpt above the paywall", initial_value: s.showExcerpts },
		]), context("Starts with sk_test_ for test mode or sk_live_ for real payments. Stored encrypted."),
	];
	if (s.humans.mode === "stripe") {
		const plan = s.humans.plans.find(p => p.slug === editSlug);
		let productField: FormField = textField("product", "Stripe product", plan?.stripeProductId ?? "", "prod_…");
		if (s.stripeSecretKey) {
			try {
				const products = await productsHandler(request(route, {}, "GET"), ctx);
				if (products.products && (products.products.length || plan?.stripeProductId)) productField = { type: "combobox", action_id: "product", label: "Stripe product", ...(plan?.stripeProductId ? { initial_value: plan.stripeProductId } : {}), options: [...products.products.map(p => ({ value: p.id, label: p.name })), ...(plan?.stripeProductId && !products.products.some(p => p.id === plan.stripeProductId) ? [{ value: plan.stripeProductId, label: `${plan.stripeProductId} (saved product)` }] : [])] };
				if (products.products?.length === 0 && !plan?.stripeProductId) members.push(context("No Stripe products yet. Create a product in Stripe, then enter its ID below."));
			} catch { members.push(banner("Couldn't load Stripe products. Check your key and connection, or enter a product ID below.", "alert")); }
		}
		members.push({ type: "header", text: "Plans" }, ...extra, {
			type: "table", block_id: "plans:table", page_action_id: "plans:page", columns: [{ key: "name", label: "Name" }, { key: "slug", label: "Plan ID", format: "code" }, { key: "product", label: "Stripe product", format: "code" }, { key: "prices", label: "Prices" }, { key: "actions", label: "Actions", format: "element" }],
			rows: s.humans.plans.map(p => ({ name: p.name, slug: p.slug, product: p.stripeProductId ?? "", prices: [p.monthlyLabel, p.yearlyLabel].filter(Boolean).join(" · "), actions: { type: "menu", action_id: `plans:menu:${p.slug}`, label: "Actions", items: [{ label: "Edit", value: "edit" }, { label: "Remove", value: "remove" }] } })),
		}, { type: "header", text: plan ? "Edit plan" : "Add a plan" },
		...(plan ? [{ type: "fields" as const, fields: [{ label: "Plan ID", value: plan.slug }] }] : []),
		form(plan ? `plans:save:${plan.slug}` : "plans:add", "Save plan", [
			textField("name", "Plan name", plan?.name), ...(!plan ? [textField("slug", "Plan ID")] : []), productField,
			textField("monthly", "Monthly price label", plan?.monthlyLabel, "$5/month"), textField("yearly", "Yearly price label", plan?.yearlyLabel),
			textField("trial", "Trial label (optional)", plan?.trialLabel), textField("description", "Description (optional)", plan?.description),
		]), context("Used in rules and URLs. Can't change later."));
	}
	return { blocks: [
		{ type: "header", text: "Paid Access" }, context("Charge people with Stripe memberships and AI agents with x402 payments — separately or together."),
		...(s.humans.mode === "stripe" && !s.emailConfigured ? [banner("Sign-in links can't be sent. Install and configure an email provider plugin, then come back.", "error")] : []),
		...(legacy ? [banner("Restrict With Stripe is active on this site. Member access is delegated to it until you migrate.", "alert")] : []),
		...(s.agents.mode !== "off" && (!s.agents.payTo || !s.agents.network) ? [banner("Agent sales are on but there's no payout wallet. Add one below.", "error")] : []),
		{ type: "tab", block_id: `settings:tabs:${defaultTab}`, default_tab: defaultTab, panels: [
			{ label: "AI agents", blocks: [
				...(s.agents.mode === "tokens-only" ? [{ type: "fields" as const, fields: [{ label: "Sell to AI agents", value: "Subscriber tokens only" }] }, context("Subscriber tokens only is the saved mode. Leave the choice below unchanged to keep it.")] : []),
				form("settings:agents:save", "Save agent settings", [
					{ type: "radio", action_id: "agents_mode", label: "Sell to AI agents", ...(s.agents.mode !== "tokens-only" ? { initial_value: s.agents.mode } : {}), options: [{ value: "off", label: "Off" }, { value: "paid", label: "On — agents pay per read" }] },
					{ type: "select", action_id: "agents_network", label: "Network", condition: paid, initial_value: s.agents.network || "eip155:84532", options: [{ value: "eip155:84532", label: "Base Sepolia (test USDC)" }, { value: "eip155:8453", label: "Base (real USDC)" }] },
					{ ...textField("agents_pay_to", "Payout wallet", s.agents.payTo, "0x…"), condition: paid },
				]), context("USDC goes straight to this address on Base. Use a wallet you control."),
				context(`Agents get each post as Markdown at ${s.agentRoutePrefix}/{collection}/{slug}.md and pay with the x402 protocol. People reading your site see no change.`),
			] },
			{ label: "Members", blocks: members },
			{ label: "Advanced", blocks: [
				form("settings:advanced:save", "Save advanced settings", [textField("agent_route_prefix", "Agent route prefix", s.agentRoutePrefix), textField("account_path", "Account pages path", s.accountPath),
					{ type: "radio", action_id: "rail", label: "Payment rail", initial_value: s.agents.rail, options: [{ value: "origin-x402", label: "This site (recommended)" }, { value: "gateway", label: "Cloudflare Monetization Gateway" }] },
					{ ...textField("edge_trust", "Edge trust method", s.agents.edgeTrust), condition: { field: "rail", eq: "gateway" } },
				]), context("The Gateway rail stays off until the edge trust method below is set."),
				...(s.stripeSecretKey ? [{ type: "actions" as const, elements: [{ ...confirmButton("settings:disconnect", "Disconnect", "Disconnect Stripe?", "Checkout and member checks stop until you add a key again. Existing members keep their Stripe subscriptions."), label: "Disconnect Stripe" }] }] : []),
			] },
		] },
	] };
}

export async function settingsInteraction(route: RouteContext, ctx: PluginContext): Promise<BlockResponse> {
	const { type, action, values: v, value } = interaction(route);
	const s = await loadSettings(ctx);
	if (type === "block_action" && action.startsWith("plans:menu:")) {
		const slug = action.slice("plans:menu:".length);
		if (value === "edit") return settingsPage(route, ctx, slug, 1);
		if (value === "remove") return settingsPage(route, ctx, undefined, 1, [{ type: "actions", elements: [confirmButton(`plans:remove:${slug}`, "Remove", "Remove this plan?", "Posts that require only this plan will be locked for everyone until you pick another plan.")] }]);
	}
	let input: Record<string, unknown>;
	let success: string;
	let tab = 0;
	if (type === "form_submit" && action === "settings:agents:save") {
		if (v.agents_mode === "tokens-only" && s.agents.mode !== "tokens-only") return { ...(await settingsPage(route, ctx)), toast: { type: "error", message: "Choose Off or On — agents pay per read. Subscriber tokens ship later." } };
		input = { agents: { ...s.agents, mode: v.agents_mode ?? s.agents.mode, network: v.agents_network ?? s.agents.network, payTo: v.agents_pay_to ?? s.agents.payTo } }; success = "Agent settings saved.";
	} else if (type === "form_submit" && action === "settings:members:save") {
		input = { humans: { ...s.humans, mode: v.humans_mode }, stripeSecretKey: v.stripe_secret_key, stripePublishableKey: v.stripe_publishable_key, showExcerpts: v.show_excerpts }; success = "Member settings saved."; tab = 1;
	} else if (type === "form_submit" && action === "settings:advanced:save") {
		input = { agentRoutePrefix: v.agent_route_prefix, accountPath: v.account_path, agents: { ...s.agents, rail: v.rail, edgeTrust: v.edge_trust ?? s.agents.edgeTrust } }; success = "Advanced settings saved."; tab = 2;
	} else if (type === "block_action" && action === "settings:disconnect") {
		input = { disconnect: true }; success = "Stripe disconnected."; tab = 2;
	} else if ((type === "form_submit" && (action === "plans:add" || action.startsWith("plans:save:"))) || (type === "block_action" && action.startsWith("plans:remove:"))) {
		tab = 1;
		const editing = action.startsWith("plans:save:");
		const removing = action.startsWith("plans:remove:");
		const slug = removing ? action.slice(13) : editing ? action.slice(11) : str(v.slug).trim();
		const existing = s.humans.plans.find(p => p.slug === slug);
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || ((editing || removing) && !existing) || (!editing && !removing && existing)) {
			return { ...(await settingsPage(route, ctx, editing ? slug : undefined, 1)), toast: { type: "error", message: existing && !editing && !removing ? "That plan ID already exists. Choose a different ID." : "Use an existing plan, or add a lowercase plan ID with dashes." } };
		}
		const plans = s.humans.plans.filter(p => p.slug !== slug);
		if (!removing) plans.push({ ...existing, slug, name: str(v.name), stripeProductId: str(v.product), grantsVisibility: existing?.grantsVisibility ?? [], monthlyLabel: str(v.monthly), yearlyLabel: str(v.yearly), trialLabel: str(v.trial), description: str(v.description) });
		input = { humans: { ...s.humans, plans } }; success = removing ? "Plan removed." : "Plan saved.";
	} else return { ...(await settingsPage(route, ctx)), toast: { type: "error", message: "This action is unavailable. Reload Settings and try again." } };
	const result = await settingsHandler(request(route, input), ctx);
	return { ...(await settingsPage(route, ctx, undefined, tab)), toast: resultToast(result, success) };
}
