// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { defineConfig } from "tsdown";
export default defineConfig({
	entry: ["src/astro/index.ts", "src/astro/middleware.ts", "src/astro/runtime.ts", "src/astro/routes/*.ts"],
	outDir: "dist/astro", format: "esm", outExtensions: () => ({ js: ".mjs", dts: ".d.mts" }),
	dts: true, clean: true, deps: { neverBundle: [/^virtual:/, /^astro(?:[/:]|$)/, /^emdash(?:\/|$)/, /^@emdash-cms\/x402/] },
});
