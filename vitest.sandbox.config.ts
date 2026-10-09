// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later
import { emdashPluginTest } from "@emdash-cms/plugin-test/config";
import { defineConfig } from "vitest/config";

export default defineConfig({
 plugins: [emdashPluginTest()],
 test: { include: ["tests/sandbox/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 30_000 },
});
