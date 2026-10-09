// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later
import { copyFileSync, mkdirSync } from "node:fs";
// Package managers omit pnpm-lock.yaml at packing time. Preserve its bytes
// under a neutral filename so recipients can restore the exact build lockfile.
const source = new URL("../dist/source/", import.meta.url);
mkdirSync(source, { recursive: true });
copyFileSync(new URL("../pnpm-lock.yaml", import.meta.url), new URL("lock.yaml", source));

// pnpm also removes publish lifecycle hooks and packageManager from the manifest.
copyFileSync(new URL("../package.json", import.meta.url), new URL("manifest.json", source));
