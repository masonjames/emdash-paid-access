// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
	server: { deps: { inline: ["@emdash-cms/x402"] } },
	ssr: { noExternal: ["@emdash-cms/x402"] },
	resolve: {
		alias: {
			"astro:middleware": fileURLToPath(new URL("./tests/fixtures/astro-middleware.ts", import.meta.url)),
			"virtual:x402/config": fileURLToPath(new URL("./tests/fixtures/x402-config.ts", import.meta.url)),
		},
	},
});
