// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { createHash } from "node:crypto";
import { invoke } from "./fixtures/route.js";

import { describe, expect, it, vi } from "vitest";

import { createSession, getSessionEmail, sessionHandler, logoutHandler, sendLinkHandler, sendMagicLink, verifyHandler } from "../src/handlers/auth.js";
import { sanitizeRedirectPath } from "../src/utils.js";

function context() {
	const tokens = new Map<string, Record<string, unknown>>();
	const sessions = new Map<string, Record<string, unknown>>();
	const counters = new Map<string, { value: number[]; revision: string }>();
	const send = vi.fn(async () => undefined);
	const ctx = {
		settings: { get: async () => null },
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
			auth_tokens: {
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
		const sent = await sendMagicLink({ request: { url: ctx.request.url, method: "POST", headers: {} }, input: {} }, ctx, { email: "User@example.com", intent: "subscribe-free", redirect: "https://evil.example" });
		const token = new URL(sent.verifyUrl).searchParams.get("token")!;
		expect(sent.redirect).toBe("/");
		expect([...tokens.keys()]).toEqual([hash(token)]);
		expect(JSON.stringify([...tokens.values()])).not.toContain(token);
		expect(send.mock.calls[0][0].html).toContain("&lt;img");
		expect(send.mock.calls[0][0].html).not.toContain("<img");
		const session = await createSession(ctx, "user@example.com");
		expect([...sessions.keys()]).toEqual([hash(session.sessionToken)]);
		expect(JSON.stringify([...sessions.values()])).not.toContain(session.sessionToken);
		await expect(getSessionEmail(ctx, session.sessionToken)).resolves.toBe("user@example.com");
	});

	it("limits repeated email and client IP requests before invalidating a token", async () => {
		const { ctx, tokens, send } = context();
		await expect(invoke(sendLinkHandler, ctx)).resolves.toMatchObject({ ok: true });
		const original = [...tokens.keys()][0];
		await expect(invoke(sendLinkHandler, ctx)).resolves.toEqual({ ok: false, error: "Please wait a minute before requesting another link." });
		expect([...tokens.keys()]).toEqual([original]);
		expect(send).toHaveBeenCalledTimes(1);
		await expect(invoke(sendLinkHandler, { ...ctx, input: { email: "other@example.com" } })).resolves.toEqual({ ok: false, error: "Please wait a minute before requesting another link." });
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("limits an email after five links within an hour", async () => {
		const { ctx, counters, send } = context();
		counters.set(`link-rate:email:${hash("user@example.com")}`, { value: Array(5).fill(Date.now() - 120_000), revision: "5" });
		await expect(invoke(sendLinkHandler, ctx)).resolves.toEqual({ ok: false, error: "Please wait a minute before requesting another link." });
		expect(send).not.toHaveBeenCalled();
	});

	it("uses compare-and-set before creating a session", async () => {
		const { ctx, sessions } = context();
		const sent = await sendMagicLink({ request: { url: ctx.request.url, method: "POST", headers: {} }, input: {} }, ctx, { email: "user@example.com", intent: "signin", redirect: "/" });
		const token = new URL(sent.verifyUrl).searchParams.get("token")!;
		ctx.storage.auth_tokens.compareAndSet.mockResolvedValueOnce({ applied: false });
		const verifyCtx = { ...ctx, input: { token }, request: new Request(`https://site.test/auth/verify?token=${token}`) };
		await expect(invoke(verifyHandler, verifyCtx)).resolves.toMatchObject({ ok: false, code: "USED_TOKEN" });
		expect(sessions.size).toBe(0);
		await expect(invoke(verifyHandler, verifyCtx)).resolves.toMatchObject({ ok: true });
		expect(sessions.size).toBe(1);
	});
});


describe("portable auth", () => {
	it("requires the explicit session token, ignores cookies, and deletes its hash on logout", async () => {
		const { ctx, sessions } = context();
		const session = await createSession(ctx, "user@example.com");
		const request = new Request("https://site.test/session", { method: "POST", headers: { cookie: `phb_session=${session.sessionToken}` } });
		await expect(invoke(sessionHandler, { ...ctx, request, input: {} })).resolves.toEqual({ authenticated: false, email: null });
		const withToken = { ...ctx, request, input: { sessionToken: session.sessionToken } };
		await expect(invoke(sessionHandler, withToken)).resolves.toEqual({ authenticated: true, email: "user@example.com" });
		await expect(invoke(logoutHandler, withToken)).resolves.toEqual({ ok: true });
		expect(sessions.size).toBe(0);
	});
	it("uses accountPath for links and accepts verification only from the body", async () => {
		const { ctx } = context();
		const configured = { ...ctx, settings: { get: async (key: string) => key === "accountPath" ? "/members/" : null } };
		const sent = await sendMagicLink({ request: { url: ctx.request.url, method: "POST", headers: {} }, input: {} }, configured, { email: "user@example.com", intent: "signin", redirect: "/safe" });
		expect(new URL(sent.verifyUrl).pathname).toBe("/members/verify/");
		const token = new URL(sent.verifyUrl).searchParams.get("token");
		await expect(invoke(verifyHandler, { ...configured, input: {}, request: new Request(sent.verifyUrl) })).resolves.toMatchObject({ ok: false, code: "INVALID_TOKEN" });
		await expect(invoke(verifyHandler, { ...configured, input: { token, redirect: "//evil.test" } })).resolves.toMatchObject({ ok: true, redirect: "/safe" });
	});
});
