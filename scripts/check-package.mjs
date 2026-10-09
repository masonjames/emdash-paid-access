// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "paid-access-package-"));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const artifacts = join(root, "artifacts");
mkdirSync(artifacts, { recursive: true });
const archive = join(artifacts, `${manifest.name}-${manifest.version}.tgz`);
try {
 execFileSync("pnpm", ["pack", "--out", archive], { cwd: root, stdio: "pipe" });
 const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
 const required = ["README.md", "CHANGELOG.md", "LICENSE", "NOTICE.md", "icon.png", "emdash-plugin.jsonc", "src/plugin.ts", "src/astro/index.ts", "tests/sandbox/runtime.test.ts", "dist/source/lock.yaml", "dist/source/manifest.json", "pnpm-workspace.yaml", "tsconfig.json", "tsdown.config.ts", "vitest.config.ts", "vitest.sandbox.config.ts", "scripts/check-package.mjs", "patches/@emdash-cms__plugin-cli@0.13.3.patch", "docs/README.md", "docs/guides/installation.md"];
 for (const file of required) assert(files.includes(`package/${file}`), `Missing package source or documentation: ${file}`);
 for (const file of files) assert(!/(?:^|\/)(?:\.env(?:\.|$)|node_modules|\.git|artifacts|docs\/(?:plans|reviews))(?:\/|$)/.test(file), `Private or generated material in tarball: ${file}`);
 const installed = join(temp, "node_modules", manifest.name);
 mkdirSync(installed, { recursive: true });
 execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", installed]);
 const packed = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
 assert.equal(packed.version, manifest.version);
 assert.deepEqual(readFileSync(join(installed, "dist/source/manifest.json")), readFileSync(join(root, "package.json")), "Preserved source manifest differs from release source");
 assert.deepEqual(readFileSync(join(installed, "dist/source/lock.yaml")), readFileSync(join(root, "pnpm-lock.yaml")), "Packaged lockfile differs from release source");
 const targets = value => typeof value === "string" ? [value] : Object.values(value).flatMap(targets);
 for (const target of targets(packed.exports)) {
  if (target.includes("*")) { assert(readdirSync(join(installed, dirname(target))).length, `Empty wildcard export: ${target}`); }
  else assert(existsSync(resolve(installed, target)), `Missing export: ${target}`);
 }
 for (const peer of Object.keys(manifest.peerDependencies)) {
  const destination = join(temp, "node_modules", peer);
  mkdirSync(dirname(destination), { recursive: true });
  symlinkSync(join(root, "node_modules", peer), destination, "dir");
 }
 writeFileSync(join(temp, "smoke.mjs"), `
 import assert from 'node:assert/strict';
 import { createRequire } from 'node:module';
 import { existsSync } from 'node:fs';
 import plugin from 'emdash-paid-access';
 import { paidAccessAstro } from 'emdash-paid-access/astro';
 const require = createRequire(import.meta.url);
 assert.equal(typeof plugin, 'object');
 const routes = [];
 let config;
 paidAccessAstro().hooks['astro:config:setup']({ updateConfig(value) { config = value; }, addMiddleware(value) { routes.push(value.entrypoint); }, injectRoute(value) { routes.push(value.entrypoint); } });
 for (const route of routes) assert(existsSync(require.resolve(route)));
 const middleware = [];
 config.integrations[0].hooks['astro:config:setup']({ updateConfig() {}, addMiddleware(value) { middleware.push(value.entrypoint); }, logger: { info() {}, warn() {} } });
 assert(middleware.length > 0);
 for (const entry of middleware) assert(existsSync(entry instanceof URL ? entry : entry.startsWith('file:') ? new URL(entry) : require.resolve(entry)));
 console.log('Packed descriptor, companion exports and x402 middleware resolve from a consumer.');
 `);
 execFileSync(process.execPath, [join(temp, "smoke.mjs")], { cwd: temp, stdio: "inherit" });
 const bundle = join(root, "dist", `paid-access-${manifest.version}.tar.gz`);
 const bundledManifest = JSON.parse(execFileSync("tar", ["-xOf", bundle, "manifest.json"], { encoding: "utf8" }));
 assert.equal(bundledManifest.version, manifest.version);
 assert.deepEqual(execFileSync("tar", ["-xOf", bundle, "backend.js"]), readFileSync(join(root, "dist/plugin.mjs")), "Sandbox bundle and npm core differ");
 copyFileSync(bundle, join(artifacts, `paid-access-${manifest.version}.tar.gz`));
 const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
 writeFileSync(`${archive}.sha256`, `${sha256}  ${manifest.name}-${manifest.version}.tgz\n`);
 console.log(`Package verified: ${archive} (${files.length} files, SHA-256 ${sha256})`);
} finally { rmSync(temp, { recursive: true, force: true }); }
