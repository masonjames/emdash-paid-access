// Copyright 2026 Stranger Studios.
// Modified by Mason James, 2026-09-23.
// SPDX-License-Identifier: GPL-2.0-or-later

export function nowIso(): string {
	return new Date().toISOString();
}

export function generateToken(prefix = "", length = 48): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	const randomValues = new Uint8Array(length);
	globalThis.crypto.getRandomValues(randomValues);
	let token = prefix;
	for (let index = 0; index < length; index += 1) {
		token += chars[randomValues[index] % chars.length];
	}
	return token;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeEmail(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}

	const normalized = value.trim().toLowerCase();
	if (!normalized || !normalized.includes("@")) {
		return null;
	}

	return normalized;
}

export function sanitizeRedirectPath(value: unknown, fallback = "/"): string {
	if (typeof value !== "string") {
		return fallback;
	}

	const trimmed = value.trim();
	if (!trimmed) {
		return fallback;
	}

	if (trimmed.startsWith("//")) {
		return fallback;
	}

	if (trimmed.startsWith("/")) {
		return trimmed;
	}

	try {
		const url = new URL(trimmed);
		if (url.pathname.startsWith("/") && !url.pathname.startsWith("//")) {
			return `${url.pathname}${url.search}${url.hash}`;
		}
	} catch {
		// Ignore invalid absolute URLs and fall back below.
	}

	return fallback;
}

export function getCookieValue(request: Request, name: string): string | null {
	const cookieHeader = request.headers.get("cookie") || "";
	for (const part of cookieHeader.split(";")) {
		const [rawName, ...rawValue] = part.trim().split("=");
		if (rawName !== name) {
			continue;
		}
		return decodeURIComponent(rawValue.join("="));
	}
	return null;
}

export function unwrapStoredRecord<T>(record: unknown): T | null {
	if (!record) {
		return null;
	}

	if (isRecord(record) && "data" in record) {
		return (record.data as T | null | undefined) ?? null;
	}

	return record as T;
}

export function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

export function uniqueStrings(values: Iterable<string | null | undefined>): string[] {
	const seen = new Set<string>();
	for (const value of values) {
		if (!value) {
			continue;
		}
		seen.add(value);
	}
	return [...seen];
}

export function parsePlanSlugs(value: unknown, validSlugs?: Iterable<string>): string[] {
	const allowed = validSlugs ? new Set(validSlugs) : null;
	return uniqueStrings(normalizeStringArray(value)).filter((slug) => !allowed || allowed.has(slug));
}
