// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, it } from "vitest";
import { failClosedAgentResult, failClosedHumanDecision, unionAccessDecisions } from "../src/decisions.js";
import type { AccessDecision } from "../src/types.js";
const open: AccessDecision = { restricted: false, authenticated: false, hasAccess: true, email: null, requiredPlanSlugs: [], requiredProductIds: [] };
it("denies content when either translated entry requires an unmet entitlement", () => {
 const denied = { ...open, restricted: true, hasAccess: false, requiredPlanSlugs: ["plus"] };
 for (const [left, right] of [[open, denied], [denied, open]]) {
  expect(unionAccessDecisions(left, right)).toMatchObject({ restricted: true, hasAccess: false, requiredPlanSlugs: ["plus"] });
 }
});
it("requires all restricted entries and deduplicates their requirements", () => {
 const plus = { ...open, restricted: true, authenticated: true, hasAccess: true, requiredPlanSlugs: ["plus"], requiredProductIds: ["product"] };
 const pro = { ...plus, requiredPlanSlugs: ["plus", "pro"] };
 expect(unionAccessDecisions(plus, pro)).toMatchObject({ hasAccess: true, requiredPlanSlugs: ["plus", "pro"], requiredProductIds: ["product"] });
 expect(unionAccessDecisions(plus, { ...pro, hasAccess: false }).hasAccess).toBe(false);
});
it("retains errors and returns no body when a provider is unavailable", () => {
 expect(unionAccessDecisions(open, failClosedHumanDecision("offline"))).toMatchObject({ restricted: true, hasAccess: false, error: "offline" });
 expect(failClosedAgentResult()).toEqual({ status: 503, body: null });
});
