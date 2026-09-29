// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("rename surfaces", () => {
	it("keeps legacy identifiers only in attribution, migration, and coexistence files", () => {
		const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
			encoding: "utf8",
		}).trim().split("\n").filter(Boolean);
		const allowed = (file: string) => file === "NOTICE.md" || file.includes("migration") || file === "src/coexistence.ts";
		const forbidden = ["restrict", "with", "stripe"].join("-");
		const oldPrefix = ["rw", "stripe"].join("");
		const offenders = files.filter((file) => existsSync(file) && !allowed(file)).filter((file) => {
			const text = readFileSync(file, "utf8").toLowerCase();
			return text.includes(forbidden) || text.includes(oldPrefix);
		});
		expect(offenders).toEqual([]);
	});
});
