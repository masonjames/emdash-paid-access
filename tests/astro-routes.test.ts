// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later
import { beforeEach, expect, it, vi } from "vitest";
import type { APIContext } from "astro";
import { getEmDashEntry } from "emdash";
import { GET, HEAD } from "../src/astro/routes/agent-entry.js";
import { GET as offers } from "../src/astro/routes/offers.js";
vi.mock("emdash", () => ({ getEmDashEntry: vi.fn() }));
const agents = { mode: "paid", rail: "origin-x402", network: "eip155:84532", payTo: "0x1111111111111111111111111111111111111111", edgeTrust: "none" };
const content = [{ _type: "block", style: "normal", children: [{ _type: "span", text: "SENTINEL_BODY", marks: [] }] }];
function setup(rules: unknown[] = []) {
	const handler = vi.fn(async (_id: string, _method: string, path: string, _request: Request) => ({ success: true, data: path === "agent/context" ? { agents, rules, canonicalUrl: "https://site.test/blog/slug/" } : { ok: true } }));
	const enforce = vi.fn(async () => new Response("payment", { status: 402, headers: { "PAYMENT-REQUIRED": "challenge" } }));
	const context = { params: { collection: "posts", slug: "slug" }, request: new Request("https://site.test/agents/posts/slug.md"), locals: { emdash: { handlePluginApiRoute: handler, handlePublicPluginApiRoute: handler }, x402: { enforce } } } as unknown as APIContext;
	return { context, handler, enforce };
}
beforeEach(() => { vi.mocked(getEmDashEntry).mockResolvedValue({ entry: { id: "slug", data: { id: "db-1", status: "published", title: "Title", content } } }); });
it("404s unknown collections, missing entries and preview drafts without a body", async () => {
	const { context } = setup();
	context.params.collection = "private";
	expect((await GET(context)).status).toBe(404);
	expect(getEmDashEntry).not.toHaveBeenCalled();
	context.params.collection = "posts";
	vi.mocked(getEmDashEntry).mockResolvedValueOnce({ entry: undefined });
	expect(await (await GET(context)).text()).toBe("");
	vi.mocked(getEmDashEntry).mockResolvedValueOnce({ entry: { id: "slug", data: { status: "draft", content } } });
	expect((await GET(context)).status).toBe(404);
	vi.mocked(getEmDashEntry).mockResolvedValueOnce({ entry: { id: "slug", data: { status: "published", content } }, isPreview: true });
	expect((await GET(context)).status).toBe(404);
});
it("503s context and entry lookup failures without content", async () => {
	const { context, handler } = setup(); handler.mockRejectedValueOnce(new Error("offline"));
	const response = await GET(context);
	expect(response.status).toBe(503); expect(await response.text()).toBe(""); expect(response.headers.get("Cache-Control")).toBe("private, no-store");
	vi.mocked(getEmDashEntry).mockRejectedValueOnce(new Error("offline"));
	expect((await GET(context)).status).toBe(503);
});
it("serves free Markdown and canonical URL, HEAD omits body", async () => {
	const { context, handler, enforce } = setup([{ policy: "public" }]);
	const response = await GET(context); expect(response.status).toBe(200);
	expect(await response.text()).toContain('canonical: "https://site.test/blog/slug/"');
	expect(await handler.mock.calls[0][3].json()).toEqual({ collection: "posts", contentId: "db-1", slug: "slug" });
	expect(enforce).not.toHaveBeenCalled();
	const head = await HEAD(context); expect(await head.text()).toBe(""); expect(head.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
});
it("passes 402 unchanged, then paid Markdown with a recorded receipt and no-store", async () => {
	const { context, handler, enforce } = setup([{ policy: "agents-pay", agentPrice: "$0.01" }]);
	const challenge = await GET(context); expect(challenge.status).toBe(402); expect(await challenge.text()).toBe("payment");
	expect(challenge.headers.get("PAYMENT-REQUIRED")).toBe("challenge");
	const head = await HEAD(context); expect(head.status).toBe(402); expect(await head.text()).toBe("");
	enforce.mockResolvedValue({ paid: true, skipped: false, payer: agents.payTo, settlement: { success: true, network: agents.network, transaction: "0xabc" }, responseHeaders: { "PAYMENT-RESPONSE": "settled" } } as never);
	const paid = await GET(context); expect(paid.status).toBe(200); expect(await paid.text()).toContain("SENTINEL_BODY");
	expect(paid.headers.get("Cache-Control")).toBe("private, no-store"); expect(paid.headers.get("PAYMENT-RESPONSE")).toBe("settled");
	const receipt = handler.mock.calls.find(call => call[2] === "receipts/record")!;
	expect(await receipt[3].json()).toMatchObject({ entryId: "db-1", amount: "$0.01", transaction: "0xabc" });
});
it("proxies offers via GET, preserving pagination and mapping module-off to 404", async () => {
	const { context, handler } = setup(); context.url = new URL("https://site.test/agents/offers?limit=2&cursor=next");
	handler.mockResolvedValueOnce({ success: true, data: { items: [], nextCursor: "more" } } as never);
	const response = await offers(context); expect(await response.json()).toEqual({ items: [], nextCursor: "more" });
	expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
	expect(handler.mock.calls[0][1]).toBe("GET"); expect(new URL(handler.mock.calls[0][3].url).search).toBe("?limit=2&cursor=next");
	handler.mockResolvedValueOnce({ success: true, data: { ok: false, error: { code: "MODULE_DISABLED" } } } as never);
	expect((await offers(context)).status).toBe(404);
	handler.mockRejectedValueOnce(new Error("offline")); expect((await offers(context)).status).toBe(503);
});
it("never forwards a payment signature on HEAD, so a HEAD can't settle", async () => {
	const { context, enforce } = setup([{ policy: "agents-pay", agentPrice: "$0.01" }]);
	const signed = { ...context, request: new Request("https://site.test/agents/posts/slug.md", { method: "HEAD", headers: { "PAYMENT-SIGNATURE": "signed", "X-PAYMENT": "legacy" } }) } as APIContext;
	const head = await HEAD(signed);
	expect(head.status).toBe(402);
	const forwarded = (enforce.mock.calls[0] as unknown as [Request])[0];
	expect(forwarded.headers.get("payment-signature")).toBeNull();
	expect(forwarded.headers.get("x-payment")).toBeNull();
});
