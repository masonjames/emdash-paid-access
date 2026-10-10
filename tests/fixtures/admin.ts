// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { Block, BlockResponse } from "@emdash-cms/blocks";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import { expect } from "vitest";
import { adminHandler, editorHandler } from "../../src/admin/index.js";
import { invoke } from "./route.js";

// Revisions for compare-and-set, like EmDash's plugin storage and KV.
export function store(seed: Record<string, unknown> = {}) {
	const data = new Map(Object.entries(seed));
	const revisions = new Map<string, string>(); let next = 0;
	const revision = (key: string) => data.has(key) ? revisions.get(key) ?? "0" : null;
	const set = async (key: string, value: unknown) => { data.set(key, value); revisions.set(key, String(++next)); };
	return { data, set, get: async (key: string) => data.get(key) ?? null,
		delete: async (key: string) => { revisions.delete(key); return data.delete(key); },
		getVersioned: async (key: string) => data.has(key) ? { value: data.get(key), revision: revision(key)! } : null,
		compareAndSet: async (key: string, expected: string | null, value: unknown) => {
			if (revision(key) !== expected) return { applied: false };
			await set(key, value); return { applied: true, revision: revision(key)! };
		},
		compareAndDelete: async (key: string, expected: string) => {
			if (revision(key) !== expected) return { applied: false };
			revisions.delete(key); data.delete(key); return { applied: true };
		},
	};
}
function collection() {
	const s = store();
	return { ...s, put: s.set,
		query: async ({ limit = 200, cursor = "0", orderBy, where }: { limit?: number; cursor?: string; orderBy?: Record<string, string>; where?: Record<string, string> } = {}) => {
		let rows = [...s.data].map(([id, data]) => ({ id, data }));
		if (where) rows = rows.filter(row => Object.entries(where).every(([key, value]) => (row.data as Record<string, unknown>)[key] === value));
		if (orderBy) { const [key, direction] = Object.entries(orderBy)[0]; rows = rows.sort((a, b) => String((a.data as Record<string, unknown>)[key]).localeCompare(String((b.data as Record<string, unknown>)[key])) * (direction === "desc" ? -1 : 1)); }
		const offset = Number(cursor); const items = rows.slice(offset, offset + limit); const more = offset + limit < rows.length;
		return { items, cursor: more ? String(offset + limit) : undefined, hasMore: more };
	} };
}
export const paid = { agentsMode: "paid", agentsNetwork: "eip155:84532", agentsPayTo: `0x${"1".repeat(40)}` };
// `emvb_pages` stands in for a visual builder's pages, edited in the builder's own canvas;
// the plugin content API lists it like any other collection. An unknown collection throws, as EmDash does.
const entries: Record<string, Array<{ id: string; slug: string | null; locale: string | null; status: string; data: Record<string, unknown> }>> = {
	posts: [{ id: "1", slug: "hello", locale: null, status: "published", data: { title: "Hello" } }],
	emvb_pages: [
		{ id: "01PRICING", slug: "pricing", locale: null, status: "published", data: { title: "Pricing" } },
		{ id: "01TARIFS", slug: "pricing", locale: "fr", status: "published", data: { title: "Tarifs" } },
		{ id: "01DRAFT", slug: "draft", locale: null, status: "draft", data: { title: "Draft" } },
	],
};
export function fixture(seed: Record<string, unknown> = {}) {
	return { settings: store(seed), kv: store(), storage: { restrictions: collection(), taxonomy_restrictions: collection(), receipts: collection() },
		content: { get: async () => ({ id: "1", slug: "hello", status: "published", data: { title: "Hello" } }),
			list: async (name: string, { where }: { where?: { status?: string }; limit?: number } = {}) => {
				const items = entries[name]; if (!items) throw new Error(`Unknown collection: ${name}`);
				return { items: items.filter(e => !where?.status || e.status === where.status), hasMore: false };
			} },
		taxonomies: { getAll: async () => [{ name: "category", label: "Categories", labelSingular: "Category" }], getTerms: async () => [{ id: "premium", taxonomy: "category", label: "Premium" }], getEntryTerms: async () => [{ id: "premium", taxonomy: "category", label: "Premium" }] },
		http: { fetch: async () => new Response(JSON.stringify({ data: [{ id: "prod_one", name: "Membership" }], has_more: false }), { headers: { "Content-Type": "application/json" } }) },
	};
}
export function valid(response: BlockResponse) {
	expect(validateBlockResponse(response, { pluginPagePaths: ["/settings", "/rules", "/receipts"] })).toEqual({ valid: true, errors: [] });
	return response;
}
export async function admin(ctx: ReturnType<typeof fixture>, input: unknown) {
	return valid(await invoke(adminHandler, { ...ctx, input, request: new Request("https://site.test/admin", { method: "POST" }) }));
}
export async function editor(ctx: ReturnType<typeof fixture>, input: unknown) {
	return valid(await invoke(editorHandler, { ...ctx, input, ui: { surface: "content-editor-panel", extensionId: "paid-access", locale: "en", direction: "ltr", entry: { collection: "posts", id: "1", locale: null, version: 1 } } }));
}
export function flatten(blocks: Block[]): Block[] {
	return blocks.flatMap(b => [b, ...(b.type === "tab" ? b.panels.flatMap(p => flatten(p.blocks)) : b.type === "accordion" ? flatten(b.blocks) : [])]);
}
export const submit = (action_id: string, values: Record<string, unknown>) => ({ type: "form_submit", action_id, values });
export const action = (action_id: string, value?: unknown) => ({ type: "block_action", action_id, value });
export const page = (page: string) => ({ type: "page_load", page });
export const rule = { contentId: "1", collectionSlug: "posts", slug: "hello", title: "Hello", policy: "agents-pay", agentPrice: "$0.05", createdAt: "2026-09-29T00:00:00.000Z", updatedAt: "2026-09-29T00:00:00.000Z" };
export const receipt = (amount = "$0.05", createdAt = new Date().toISOString()) => ({ entryId: "1", collectionSlug: "posts", slug: "hello", payer: `0x${"1".repeat(40)}`, transaction: `0x${"2".repeat(64)}`, rail: "origin-x402", network: "eip155:84532", amount, createdAt });
