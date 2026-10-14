// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, expect, it } from "vitest";
import { canReadPolicyMetadata, canReadTrustedContent, configureReaderProtection, protectReaderEntry } from "emdash/reader-access";
import { onRequest } from "../src/astro/reader-middleware.js";

afterEach(() => configureReaderProtection(undefined));
it.each([
 ["GET", "/_emdash/api/plugins/paid-access/offers", true],
 ["POST", "/_emdash/api/plugins/paid-access/offers", false],
 ["GET", "/_emdash/api/plugins/paid-access/other", false],
] as const)("limits discovery metadata scope to %s %s", async (method, path, metadata) => {
 configureReaderProtection({ posts: { provider: "paid-access", revision: "v1", publicFields: ["title"] } });
 const context = { request: new Request("https://site.test" + path, { method }), locals: { paidAccess: {
  access: async () => ({}), segments: async () => [], readerProvider: () => ({ id: "paid-access", decide: async () => "preview" as const }),
 } } };
 await onRequest(context as unknown as Parameters<typeof onRequest>[0], async () => {
  expect(canReadPolicyMetadata("posts", "one")).toBe(metadata);
  expect(canReadTrustedContent("posts", "one")).toBe(false);
  const safe = await protectReaderEntry("posts", { id: "one", data: { id: "one", slug: "one", locale: "en", status: "published", title: "Preview", content: "SECRET" } });
  expect(JSON.stringify(safe)).not.toContain("SECRET");
  return new Response("ok");
 });
 expect(canReadPolicyMetadata("posts", "one")).toBe(false);
});
