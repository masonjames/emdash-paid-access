// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { createRequire } from "node:module";
import { existsSync } from "node:fs";

import { expect, it } from "vitest";

// Astro resolves injected routes with CommonJS require.resolve from the site
// root, so every companion entrypoint needs a condition CJS resolution accepts.
it("resolves every companion entrypoint the way Astro's route manifest does", () => {
	const require = createRequire(import.meta.url);
	for (const entry of [
		"emdash-paid-access/astro",
		"emdash-paid-access/astro/middleware",
		"emdash-paid-access/astro/runtime",
		"emdash-paid-access/astro/routes/agent-entry",
		"emdash-paid-access/astro/routes/offers",
		"emdash-paid-access/astro/routes/account",
	]) {
		const resolved = require.resolve(entry);
		expect(resolved.endsWith(".mjs"), entry).toBe(true);
		expect(existsSync(resolved), entry).toBe(true);
	}
});
