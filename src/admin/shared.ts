// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { Block, BlockResponse, ButtonElement, FormField, LinkElement } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash/plugin";
import type { AccessPolicy, PaidAccessSettings, RouteContext } from "../types.js";
import { isRecord } from "../utils.js";

export const AGENTS_PAY_WARNING = "The full post stays in this page's HTML, so scrapers can still read it for free. Block unverified bots at your CDN if that matters to you.";
export const context = (text: string): Block => ({ type: "context", text });
export const banner = (description: string, variant: "default" | "alert" | "error" = "default"): Block => ({ type: "banner", description, variant });
export const link = (label: string, path: string): LinkElement => ({ type: "link", label, target: { kind: "plugin-page", path } });
export const textField = (action_id: string, label: string, initial_value = "", placeholder?: string): FormField => ({ type: "text_input", action_id, label, initial_value, ...(placeholder ? { placeholder } : {}) });
// EmDash 1.0.1 seeds form state only on mount; remount after a server render.
export const form = (action_id: string, label: string, fields: FormField[]): Block => ({ type: "form", block_id: `${action_id}/${crypto.randomUUID()}`, fields, submit: { action_id, label } });
export const confirmButton = (action_id: string, label: string, title: string, text: string, value?: unknown): ButtonElement => ({ type: "button", action_id, label, value, style: "danger", confirm: { title, text, confirm: label, deny: "Cancel", style: "danger" } });
export const str = (value: unknown): string => typeof value === "string" ? value : "";
export function interaction(route: RouteContext) {
	const input = isRecord(route.input) ? route.input : {};
	return { type: str(input.type), action: str(input.action_id) || str(input.block_id).split("/")[0], page: str(input.page), value: input.value, values: isRecord(input.values) ? input.values : {} };
}
export function request(route: RouteContext, input: unknown, method = "POST"): RouteContext {
	return { ...route, input, request: { ...route.request, method } };
}
export function resultToast(result: unknown, success: string): BlockResponse["toast"] {
	return isRecord(result) && result.ok === false
		? { type: "error", message: str(result.error) || "Couldn't save. Check the fields and try again." }
		: { type: "success", message: success };
}
export function failure(message = "Couldn't load Paid Access. Reload this page and try again."): BlockResponse {
	return { blocks: [banner(message, "error")], toast: { type: "error", message } };
}
export class AdminInputError extends Error {}
export function policyFromAnswers(people: unknown, agents: unknown): AccessPolicy {
	if (people === "anyone" && agents === "subscribers") throw new AdminInputError("For posts anyone can read, choose Free or Pay per read for AI agents. To offer agents nothing, remove the rule.");
	if (people === "members" && agents === "free") throw new AdminInputError("Members-only posts can't be free for AI agents. Choose Pay per read or Not sold to agents.");
	if (people === "anyone" && agents === "free") return "public";
	if (people === "anyone" && agents === "pay") return "agents-pay";
	if (people === "members" && agents === "pay") return "members";
	if (people === "members" && agents === "subscribers") return "members-only";
	throw new AdminInputError("Choose who can read for free and how AI agents get access, then save again.");
}
export function answers(policy: AccessPolicy) {
	return { people: policy === "members" || policy === "members-only" ? "members" : "anyone", agents: policy === "public" ? "free" : policy === "members-only" ? "subscribers" : "pay" };
}
export function summary(rule: { policy: AccessPolicy; agentPrice?: string | null }) {
	const a = answers(rule.policy);
	return { people: a.people === "members" ? "Members only" : "Anyone", agents: a.agents === "free" ? "Free" : a.agents === "subscribers" ? "Not sold" : `${rule.agentPrice || "Price not set"} per read` };
}
// In delegate mode another plugin decides who reads for free, so rules only price agents.
export function ruleFields(settings: PaidAccessSettings, rule?: { policy: AccessPolicy; agentPrice?: string | null; requiredPlanSlugs?: string[] }): FormField[] {
	const a = answers(rule?.policy ?? "public");
	if (settings.humans.mode === "delegate") return [
		{ type: "radio", action_id: "agents", label: "What do AI agents get?", initial_value: a.agents === "subscribers" ? "pay" : a.agents, options: [{ value: "free", label: "Free — they read it as Markdown" }, { value: "pay", label: "Pay per read (x402, USDC)" }] },
		{ ...textField("price", "Price per read (USD)", rule?.agentPrice ?? "", "$0.05"), condition: { field: "agents", eq: "pay" } },
	];
	return [
		{ type: "radio", action_id: "people", label: "Who can read it for free?", initial_value: a.people, options: [{ value: "anyone", label: "Anyone" }, { value: "members", label: "Members only" }] },
		{ type: "radio", action_id: "agents", label: "What about AI agents?", initial_value: a.agents, options: [{ value: "free", label: "Free — they read it as Markdown" }, { value: "pay", label: "Pay per read (x402, USDC)" }, { value: "subscribers", label: "Not sold to agents (members only)" }] },
		{ ...textField("price", "Price per read (USD)", rule?.agentPrice ?? "", "$0.05"), condition: { field: "agents", eq: "pay" } },
		...(settings.humans.plans.length ? [{ type: "checkbox" as const, action_id: "plans", label: "Plans that include it", options: settings.humans.plans.map(p => ({ value: p.slug, label: p.name })), initial_value: rule?.requiredPlanSlugs ?? [], condition: { field: "people", eq: "members" } }] : []),
	];
}
export function ruleHelp(settings: PaidAccessSettings, policy?: AccessPolicy): Block[] {
	return [context("Agents pay this in USDC before they get the full post. Up to six decimals."),
		...(!settings.humans.plans.length && settings.humans.mode === "stripe" ? [context("Add a plan under Paid Access → Settings → Members first.")] : []),
		...(policy === "agents-pay" ? [banner(AGENTS_PAY_WARNING, "alert")] : [])];
}
export function ruleInput(values: Record<string, unknown>, delegated = false) {
	const policy = policyFromAnswers(delegated ? "anyone" : values.people, values.agents);
	return { policy, agentPrice: values.agents === "pay" ? values.price : null, requiredPlanSlugs: values.people === "members" ? values.plans ?? [] : [], productIds: [] };
}
export async function allRows(collection: PluginContext["storage"][string]) {
	const items: Array<{ id: string; data: unknown }> = [];
	let cursor: string | undefined;
	// ponytail: scan for exact totals; use stored aggregates if ledger size makes this slow.
	do {
		const page = await collection.query({ limit: 200, ...(cursor ? { cursor } : {}) });
		items.push(...page.items);
		cursor = page.cursor;
	} while (cursor);
	return items;
}
export function loadMore(action_id: string, cursor?: string): Block[] {
	return cursor ? [{ type: "actions", elements: [{ type: "button", action_id, label: "Load more", value: cursor }] }] : [];
}
