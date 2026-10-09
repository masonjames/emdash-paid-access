// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { fileURLToPath } from "node:url";

import { getViteConfig } from "astro/config";

export default getViteConfig({
	test: { include: ["tests/*.test.ts"] },
	server: { host: "127.0.0.1", deps: { inline: ["@emdash-cms/x402"] } },
	ssr: { noExternal: ["@emdash-cms/x402"] },
	resolve: {
		alias: {
			"emdash-paid-access/astro/runtime": fileURLToPath(new URL("./src/astro/runtime.ts", import.meta.url)),
			"virtual:emdash/block-components": fileURLToPath(new URL("./tests/fixtures/emdash-virtual.ts", import.meta.url)),
			"virtual:emdash/config": fileURLToPath(new URL("./tests/fixtures/emdash-virtual.ts", import.meta.url)),
			"astro:middleware": fileURLToPath(new URL("./tests/fixtures/astro-middleware.ts", import.meta.url)),
			"virtual:paid-access/config": fileURLToPath(new URL("./tests/fixtures/paid-access-config.ts", import.meta.url)),
			"virtual:x402/config": fileURLToPath(new URL("./tests/fixtures/x402-config.ts", import.meta.url)),
		},
	},
});
