// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later
import type { PluginContext } from "emdash/plugin";
import type { RouteContext } from "../types.js";
import { isRecord } from "../utils.js";

export async function readerGroupHandler(route: RouteContext, ctx: PluginContext) {
	const input = isRecord(route.input) ? route.input : {};
	if (typeof input.collection !== "string" || typeof input.id !== "string" || !ctx.content?.getTranslations) return { ok: false };
	const group = await readTranslationGroup(ctx, input.collection, input.id);
	return { ok: true, group: group.translationGroup, entries: group.translations.map(item => ({ id: item.id, slug: item.slug, locale: item.locale })) };
}

export async function readTranslationGroup(ctx: Pick<PluginContext, "content">, collection: string, id: string) {
	if (!ctx.content?.getTranslations) throw new Error("Translation metadata is unavailable");
	const group = await ctx.content.getTranslations(collection, id);
	if (!group?.translationGroup || !Array.isArray(group.translations) || !group.translations.length || group.translations.length > 100 || !group.translations.some(item => item.id === id) || !group.translations.every(item => typeof item.id === "string" && item.id && typeof item.locale === "string" && item.locale && (item.slug === null || typeof item.slug === "string"))) throw new Error("Translation metadata is invalid");
	if (new Set(group.translations.map(item => item.id)).size !== group.translations.length || new Set(group.translations.map(item => item.locale)).size !== group.translations.length) throw new Error("Translation metadata is ambiguous");
	return group;
}
