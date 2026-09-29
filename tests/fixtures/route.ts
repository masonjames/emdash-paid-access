// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PluginContext } from "emdash/plugin";
import type { RouteContext } from "../../src/types.js";

// Exercise the portable request shape and keep plugin context separate.
export function invoke<T>(handler: (route: RouteContext, ctx: PluginContext) => T, mock: object) {
	const { request = new Request("https://site.test/"), input, requestMeta, ui, ...ctx } = mock as {
		request?: Request; input?: unknown; requestMeta?: unknown; ui?: RouteContext["ui"];
	};
	return handler({
		request: { url: request.url, method: request.method, headers: Object.fromEntries(request.headers) },
		input: input ?? Object.fromEntries(new URL(request.url).searchParams), requestMeta, ui
	}, ctx as PluginContext);
}
