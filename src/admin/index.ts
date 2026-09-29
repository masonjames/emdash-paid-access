// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { BlockResponse } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash/plugin";
import type { RouteContext } from "../types.js";
import { isRecord, routeError } from "../utils.js";
import { editorPanel } from "./editor.js";
import { overview } from "./overview.js";
import { receiptsPage } from "./receipts.js";
import { rulesInteraction, rulesPage } from "./rules.js";
import { settingsInteraction, settingsPage } from "./settings.js";
import { failure, interaction, str } from "./shared.js";

export async function adminHandler(route: RouteContext, ctx: PluginContext): Promise<BlockResponse> {
	try {
		const i = interaction(route);
		if (i.type === "page_load") {
			if (i.page === "/settings") return await settingsPage(route, ctx);
			if (i.page === "/rules") return await rulesPage(ctx);
			if (i.page === "/receipts") return await receiptsPage(ctx);
			if (i.page === "widget:overview") return await overview(ctx);
		}
		if (i.type === "form_submit" || i.type === "block_action") {
			if (i.action.startsWith("settings:") || i.action.startsWith("plans:")) return await settingsInteraction(route, ctx);
			if (i.action.startsWith("rules:")) return await rulesInteraction(route, ctx);
			if (i.type === "block_action" && i.action === "receipts:more") return await receiptsPage(ctx, str(i.value));
		}
		return failure("This action is unavailable. Reload Paid Access and try again.");
	} catch { return failure(); }
}
export async function editorHandler(route: RouteContext, ctx: PluginContext): Promise<BlockResponse> {
	try { return await editorPanel(route, ctx); }
	catch { return failure("Couldn't load access for this post. Reload the editor and try again."); }
}
export async function coexistenceReport(route: RouteContext, ctx: PluginContext) {
	if (route.request.method !== "POST" || !isRecord(route.input) || typeof route.input.legacyPluginPresent !== "boolean") return routeError("BAD_REQUEST", "Report legacyPluginPresent as true or false, then try again.");
	await ctx.kv.set("state:legacyPluginPresent", route.input.legacyPluginPresent);
	return { ok: true };
}
