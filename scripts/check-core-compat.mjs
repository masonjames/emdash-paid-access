// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
try {
 for (const name of ["emdash/reader-access", "emdash/plugin-payments"]) require.resolve(name);
} catch {
 console.error("Paid Access beta.3 requires the reviewed EmDash core reader-access and plugin-payments APIs. Stock EmDash 1.2.0 is incompatible. See docs/releases/0.1.0-beta.3.md; npm publication is blocked until a compatible core is installable.");
 process.exitCode = 1;
}
