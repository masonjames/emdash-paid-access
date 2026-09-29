// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { APIContext, APIRoute } from "astro";
import { sanitizeRedirectPath } from "../../utils.js";
import { callPlugin } from "../runtime.js";

export const prerender = false;
function redirect(path: unknown, state?: string): Response {
	const url = new URL(sanitizeRedirectPath(path), "https://paid-access.invalid");
	if (state) url.searchParams.set("phb", state);
	return new Response(null, { status: 303, headers: { Location: `${url.pathname}${url.search}${url.hash}`, "Cache-Control": "private, no-store" } });
}
function stripeRedirect(value: unknown, host: string): Response | null {
	if (typeof value !== "string") return null;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.hostname !== host || url.username || url.password || url.port) return null;
		return new Response(null, { status: 303, headers: { Location: url.href, "Cache-Control": "private, no-store" } });
	} catch { return null; }
}
function cookieOptions(url: URL) {
	return { path: "/", httpOnly: true, secure: !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)), sameSite: "lax" as const };
}
async function handle(context: APIContext): Promise<Response> {
	const { locals, request, url, cookies } = context;
	const action = url.pathname.replace(/\/$/, "").split("/").at(-1);
	const sessionToken = cookies.get("phb_session")?.value ?? null;
	const post = ["sign-in", "logout", "checkout"].includes(action ?? "");
	if (request.method !== (post ? "POST" : "GET")) return new Response(null, { status: 405, headers: { Allow: post ? "POST" : "GET" } });
	let path = "/";
	try {
		if (action === "logout") {
			await callPlugin(locals, "auth/logout", { sessionToken }, request);
			cookies.delete("phb_session", cookieOptions(url));
			return redirect("/", "signed-out");
		}
		const form = post ? await request.formData() : url.searchParams;
		path = sanitizeRedirectPath(form.get("redirect"));
		if (action === "sign-in") {
			const result = await callPlugin(locals, "auth/send-link", { email: form.get("email"), redirect: path, intent: "signin" }, request);
			return redirect(path, result.ok ? "link-sent" : "link-error");
		}
		if (action === "verify") {
			const result = await callPlugin(locals, "auth/verify", { token: form.get("token"), ...(form.has("redirect") ? { redirect: path } : {}) }, request);
			if (!result.ok || typeof result.data.sessionToken !== "string" || !result.data.sessionToken) return redirect("/", "link-invalid");
			cookies.set("phb_session", result.data.sessionToken, { ...cookieOptions(url), maxAge: 2592000 });
			return redirect(result.data.redirect, "signed-in");
		}
		if (action === "checkout") {
			const result = await callPlugin(locals, "checkout", { planSlug: form.get("planSlug"), billingInterval: form.get("billingInterval"), email: form.get("email"), redirectUrl: path }, request);
			return result.ok && stripeRedirect(result.data.url, "checkout.stripe.com") || redirect(path, "checkout-error");
		}
		if (action === "complete") {
			const result = await callPlugin(locals, "checkout/complete", { sessionId: form.get("session_id"), redirect: path }, request);
			return redirect(path, result.ok ? "check-email" : "checkout-error");
		}
		if (action === "portal") {
			if (!sessionToken) return redirect("/", "sign-in-required");
			const result = await callPlugin(locals, "portal", { sessionToken, returnUrl: sanitizeRedirectPath(form.get("return")) }, request);
			return result.ok && stripeRedirect(result.data.url, "billing.stripe.com") || redirect("/", "sign-in-required");
		}
		return new Response(null, { status: 404 });
	} catch {
		return redirect(action === "verify" ? "/" : path, action === "verify" ? "link-invalid" : action === "sign-in" ? "link-error" : "checkout-error");
	}
}
export const GET: APIRoute = handle;
export const POST: APIRoute = handle;
