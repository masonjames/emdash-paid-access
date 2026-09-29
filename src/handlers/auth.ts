// Copyright 2026 Stranger Studios.
// Modified by Mason James, 2026-09-23.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AuthTokenRecord, MemberSessionState, SessionRecord } from "../types.js";
import { generateToken, getCookieValue, isRecord, normalizeEmail, nowIso, sanitizeRedirectPath, unwrapStoredRecord } from "../utils.js";

export const SESSION_TOKEN_PREFIX = "phb_s_";
export const MAGIC_LINK_TOKEN_PREFIX = "phb_ml_";
export const AGENT_TOKEN_PREFIX = "phb_at_";

const AUTH_TOKEN_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE_NAME = "phb_session";
const RATE_ERROR = "Please wait a minute before requesting another link.";

async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function claimLinkRate(ctx: any, key: string): Promise<boolean> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const current = await ctx.kv.getVersioned(key);
		const now = Date.now();
		const times: number[] = Array.isArray(current?.value)
			? current.value.filter((time: unknown): time is number => typeof time === "number" && time > now - 3_600_000)
			: [];
		if (times.length >= 5 || times.some((time) => time > now - 60_000)) return false;
		if ((await ctx.kv.compareAndSet(key, current?.revision ?? null, [...times, now])).applied) return true;
	}
	return false;
}

export async function isEmailReady(ctx: any): Promise<boolean> {
	// emdash >= 0.16: ctx.email is undefined until an email:deliver provider
	// is configured, and exposes only send() — presence means ready.
	return Boolean(ctx.email);
}

async function invalidateAuthTokensForEmail(ctx: any, email: string) {
	const tokens = await ctx.storage.authTokens.query({ where: { email }, limit: 100 });
	await Promise.all(tokens.items.map((item: { id: string }) => ctx.storage.authTokens.delete(item.id)));
}

export async function createSession(ctx: any, email: string): Promise<SessionRecord & { sessionToken: string }> {
	const sessionToken = generateToken(SESSION_TOKEN_PREFIX, 32);
	const session: SessionRecord = {
		email,
		expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
		createdAt: nowIso(),
	};
	await ctx.storage.sessions.put(await hashToken(sessionToken), session);
	return { ...session, sessionToken };
}

export async function getSessionRecord(ctx: any): Promise<SessionRecord | null> {
	const sessionToken = getCookieValue(ctx.request, SESSION_COOKIE_NAME);
	if (!sessionToken) {
		return null;
	}

	const key = await hashToken(sessionToken);
	const session = unwrapStoredRecord<SessionRecord>(await ctx.storage.sessions.get(key));
	if (!session) {
		return null;
	}

	if (new Date(session.expiresAt).getTime() <= Date.now()) {
		await ctx.storage.sessions.delete(key);
		return null;
	}

	return session;
}

export async function getSessionEmail(ctx: any): Promise<string | null> {
	return (await getSessionRecord(ctx))?.email ?? null;
}

export async function getSessionState(ctx: any): Promise<MemberSessionState> {
	const session = await getSessionRecord(ctx);
	return {
		authenticated: Boolean(session?.email),
		email: session?.email ?? null,
	};
}

function buildVerifyUrl(ctx: any, token: string, redirect: string): string {
	// ctx.url() prefixes the configured site URL; when that setting is empty
	// (fresh/dev databases) it returns a bare path — fall back to the
	// request origin so magic links still resolve.
	const absolute = ctx.url("/account/verify/");
	const base = ctx.request ? new URL(ctx.request.url).origin : undefined;
	const verifyUrl = new URL(absolute, base);
	verifyUrl.searchParams.set("token", token);
	verifyUrl.searchParams.set("redirect", redirect);
	return verifyUrl.toString();
}

function buildEmailMessage(ctx: any, verifyUrl: string, intent: "signin" | "subscribe-free") {
	const siteName = ctx.site?.name || "EmDash";
	const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] || character);
	const actionLabel = intent === "subscribe-free" ? "Confirm your subscription" : "Sign in";
	const subject = intent === "subscribe-free" ? `Confirm your subscription to ${siteName}` : `Sign in to ${siteName}`;
	const text = [
		`${actionLabel} for ${siteName}`,
		"",
		`Open this link to continue: ${verifyUrl}`,
		"",
		"This link expires in 15 minutes.",
	].join("\n");
	const html = [
		`<p>${escapeHtml(actionLabel)} for <strong>${escapeHtml(siteName)}</strong>.</p>`,
		`<p><a href="${escapeHtml(verifyUrl)}" style="display:inline-block;padding:10px 20px;background:#111827;color:#ffffff;text-decoration:none;border-radius:999px;font-weight:600">${escapeHtml(actionLabel)}</a></p>`,
		"<p style=\"color:#6b7280;font-size:13px\">This link expires in 15 minutes.</p>",
	].join("");

	return { subject, text, html };
}

export async function sendMagicLink(
	ctx: any,
	options: {
		email: string;
		intent: "signin" | "subscribe-free";
		redirect: string;
	},
) {
	const email = normalizeEmail(options.email);
	if (!email) {
		throw new Error("A valid email address is required.");
	}
	if (!(await isEmailReady(ctx))) {
		throw new Error("Email delivery is not configured for this site yet.");
	}

	const redirect = sanitizeRedirectPath(options.redirect);
	const token = generateToken(MAGIC_LINK_TOKEN_PREFIX, 40);
	const authToken: AuthTokenRecord = {
		email,
		redirect,
		intent: options.intent,
		expiresAt: new Date(Date.now() + AUTH_TOKEN_TTL_MS).toISOString(),
		used: false,
		createdAt: nowIso(),
	};

	await invalidateAuthTokensForEmail(ctx, email);
	await ctx.storage.authTokens.put(await hashToken(token), authToken);

	const verifyUrl = buildVerifyUrl(ctx, token, redirect);
	const message = buildEmailMessage(ctx, verifyUrl, options.intent);
	await ctx.email.send({
		to: email,
		subject: message.subject,
		text: message.text,
		html: message.html,
	});

	return {
		email,
		redirect,
		authToken,
		verifyUrl,
		message,
		responseMessage:
			options.intent === "subscribe-free"
				? "Check your inbox to confirm your subscription."
				: "Check your inbox for a sign-in link.",
	};
}

export async function sendLinkHandler(ctx: any) {
	const body = isRecord(ctx.input) ? ctx.input : {};
	const email = normalizeEmail(body.email);
	if (!email) {
		return { ok: false, error: "A valid email address is required." };
	}
	if (!(await isEmailReady(ctx))) {
		return { ok: false, error: "Email delivery is not configured for this site yet." };
	}

	const intent = body.intent === "subscribe-free" ? "subscribe-free" : "signin";
	const redirect = sanitizeRedirectPath(body.redirect);
	const emailKey = `link-rate:email:${await hashToken(email)}`;
	if (!(await claimLinkRate(ctx, emailKey))) return { ok: false, error: RATE_ERROR };
	if (typeof ctx.requestMeta?.ip === "string" && ctx.requestMeta.ip) {
		if (!(await claimLinkRate(ctx, `link-rate:ip:${await hashToken(ctx.requestMeta.ip)}`))) return { ok: false, error: RATE_ERROR };
	}
	const result = await sendMagicLink(ctx, { email, intent, redirect });

	return {
		ok: true,
		message: result.responseMessage,
	};
}

export async function verifyHandler(ctx: any) {
	const url = new URL(ctx.request.url);
	const token = url.searchParams.get("token")?.trim();
	if (!token) {
		return { ok: false, code: "INVALID_TOKEN", error: "Invalid sign-in link." };
	}

	const key = await hashToken(token);
	const versioned = await ctx.storage.authTokens.getVersioned(key);
	const authToken = unwrapStoredRecord<AuthTokenRecord>(versioned?.value);
	if (!authToken) {
		return { ok: false, code: "INVALID_TOKEN", error: "Sign-in link not found or already expired." };
	}
	if (authToken.used) {
		return { ok: false, code: "USED_TOKEN", error: "This sign-in link has already been used." };
	}
	if (new Date(authToken.expiresAt).getTime() <= Date.now()) {
		await ctx.storage.authTokens.delete(key);
		return { ok: false, code: "EXPIRED_TOKEN", error: "This sign-in link has expired." };
	}

	if (!(await ctx.storage.authTokens.compareAndSet(key, versioned.revision, { ...authToken, used: true })).applied) {
		return { ok: false, code: "USED_TOKEN", error: "This sign-in link has already been used." };
	}
	const session = await createSession(ctx, authToken.email);

	return {
		ok: true,
		sessionToken: session.sessionToken,
		expiresAt: session.expiresAt,
		redirect: sanitizeRedirectPath(url.searchParams.get("redirect") || authToken.redirect, authToken.redirect),
	};
}

export async function sessionHandler(ctx: any) {
	return getSessionState(ctx);
}

export async function logoutHandler(ctx: any) {
	const sessionToken = getCookieValue(ctx.request, SESSION_COOKIE_NAME);
	if (sessionToken) {
		await ctx.storage.sessions.delete(await hashToken(sessionToken));
	}
	return { ok: true };
}
