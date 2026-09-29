// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { createSession, getSessionEmail, sendLinkHandler, sendMagicLink, verifyHandler } from "../src/handlers/auth.js";
import { sanitizeRedirectPath } from "../src/utils.js";

function context() {
	const tokens = new Map<string, Record<string, unknown>>();
	const sessions = new Map<string, Record<string, unknown>>();
	const counters = new Map<string, { value: number[]; revision: string }>();
	const send = vi.fn(async () => undefined);
	const ctx = {
		input: { email: "User@example.com", intent: "subscribe-free" },
		request: new Request("https://site.test/auth/send-link"),
		requestMeta: { ip: "192.0.2.1" },
		kv: {
			getVersioned: async (key: string) => counters.get(key) ?? null,
			compareAndSet: async (key: string, revision: string | null, value: number[]) => {
				if ((counters.get(key)?.revision ?? null) !== revision) return { applied: false };
				counters.set(key, { value, revision: String(Number(revision ?? 0) + 1) });
				return { applied: true };
			},
		},
		storage: {
			authTokens: {
				query: async () => ({ items: [...tokens].map(([id, data]) => ({ id, data })).filter(({ data }) => data.email === "user@example.com") }),
				put: vi.fn(async (key: string, value: Record<string, unknown>) => { tokens.set(key, value); }),
				delete: vi.fn(async (key: string) => { tokens.delete(key); }),
				getVersioned: async (key: string) => tokens.has(key) ? { value: tokens.get(key), revision: "1" } : null,
				compareAndSet: vi.fn(async (key: string, _revision: string, value: Record<string, unknown>) => { tokens.set(key, value); return { applied: true }; }),
			},
			sessions: {
				put: vi.fn(async (key: string, value: Record<string, unknown>) => { sessions.set(key, value); }),
				get: async (key: string) => sessions.get(key) ?? null,
				delete: async (key: string) => { sessions.delete(key); },
			},
		},
		email: { send },
		site: { name: '<img src=x onerror="alert(1)">' },
		url: (path: string) => `https://site.test${path}`,
	};
	return { ctx, tokens, sessions, send, counters };
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

describe("member auth boundaries", () => {
	it.each([
		["/\\evil.example", "/"], ["//evil.example", "/"], ["/\t/evil.example", "/"],
		["https://evil.example", "/"], ["/ok/path?x=1#y", "/ok/path?x=1#y"],
	])("sanitizes redirect %s", (value, expected) => {
		expect(sanitizeRedirectPath(value)).toBe(expected);
	});

	it("stores only hashes, escapes email HTML, and defaults both intents to root", async () => {
		const { ctx, tokens, sessions, send } = context();
		const sent = await sendMagicLink(ctx, { email: "User@example.com", intent: "subscribe-free", redirect: "https://evil.example" });
		const token = new URL(sent.verifyUrl).searchParams.get("token")!;
		expect(sent.redirect).toBe("/");
		expect([...tokens.keys()]).toEqual([hash(token)]);
		expect(JSON.stringify([...tokens.values()])).not.toContain(token);
		expect(send.mock.calls[0][0].html).toContain("&lt;img");
		expect(send.mock.calls[0][0].html).not.toContain("<img");
		const session = await createSession(ctx, "user@example.com");
		expect([...sessions.keys()]).toEqual([hash(session.sessionToken)]);
		expect(JSON.stringify([...sessions.values()])).not.toContain(session.sessionToken);
		await expect(getSessionEmail({ ...ctx, request: new Request("https://site.test/", { headers: { cookie: `phb_session=${session.sessionToken}` } }) })).resolves.toBe("user@example.com");
	});

	it("limits repeated email and client IP requests before invalidating a token", async () => {
		const { ctx, tokens, send } = context();
		await expect(sendLinkHandler(ctx)).resolves.toMatchObject({ ok: true });
		const original = [...tokens.keys()][0];
		await expect(sendLinkHandler(ctx)).resolves.toEqual({ ok: false, error: "Please wait a minute before requesting another link." });
		expect([...tokens.keys()]).toEqual([original]);
		expect(send).toHaveBeenCalledTimes(1);
		await expect(sendLinkHandler({ ...ctx, input: { email: "other@example.com" } })).resolves.toEqual({ ok: false, error: "Please wait a minute before requesting another link." });
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("limits an email after five links within an hour", async () => {
		const { ctx, counters, send } = context();
		counters.set(`link-rate:email:${hash("user@example.com")}`, { value: Array(5).fill(Date.now() - 120_000), revision: "5" });
		await expect(sendLinkHandler(ctx)).resolves.toEqual({ ok: false, error: "Please wait a minute before requesting another link." });
		expect(send).not.toHaveBeenCalled();
	});

	it("uses compare-and-set before creating a session", async () => {
		const { ctx, sessions } = context();
		const sent = await sendMagicLink(ctx, { email: "user@example.com", intent: "signin", redirect: "/" });
		const token = new URL(sent.verifyUrl).searchParams.get("token")!;
		ctx.storage.authTokens.compareAndSet.mockResolvedValueOnce({ applied: false });
		const verifyCtx = { ...ctx, request: new Request(`https://site.test/auth/verify?token=${token}`) };
		await expect(verifyHandler(verifyCtx)).resolves.toMatchObject({ ok: false, code: "USED_TOKEN" });
		expect(sessions.size).toBe(0);
		await expect(verifyHandler(verifyCtx)).resolves.toMatchObject({ ok: true });
		expect(sessions.size).toBe(1);
	});
});
