// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("rename surfaces", () => {
	it("keeps legacy runtime identifiers only in the coexistence seam", () => {
		const files = ["emdash-plugin.jsonc", ...readdirSync("src", { recursive: true, encoding: "utf8" }).map(file => `src/${file}`)]
			.filter(file => statSync(file).isFile());
		const allowed = (file: string) => file === "NOTICE.md" || file.includes("migration") || file === "src/coexistence.ts";
		const forbidden = ["restrict", "with", "stripe"].join("-");
		const oldPrefix = ["rw", "stripe"].join("");
		const offenders = files.filter((file) => !allowed(file)).filter((file) => {
			const text = readFileSync(file, "utf8").toLowerCase();
			return text.includes(forbidden) || text.includes(oldPrefix);
		});
		expect(offenders).toEqual([]);
	});
});
