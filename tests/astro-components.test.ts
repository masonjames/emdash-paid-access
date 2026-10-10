// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, it } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import PaidContent from "../src/components/PaidContent.astro";
import { resolveOptions } from "../src/astro/options.js";

it.each([false, true])("renders the actual PaidContent component with access=%s", async hasAccess => {
	const container = await AstroContainer.create();
	const body = "BODY_SENTINEL_MUST_REMAIN_SECRET";
	const html = await container.renderToString(PaidContent, {
		props: { entry: { id: "test", data: { id: "db-1", content: [{ _type: "block", style: "normal", children: [{ _type: "span", text: body, marks: [] }] }] } }, excerpt: "Public excerpt" },
		locals: { paidAccess: { options: resolveOptions(), sessionToken: null, access: async () => ({ restricted: true, hasAccess, authenticated: hasAccess, email: null, requiredPlanSlugs: [], requiredProductIds: [], showExcerpts: true }), plans: async () => [], segments: async () => [], session: async () => ({ authenticated: false, email: null }) } },
	});
	expect(html.includes(body)).toBe(hasAccess);
	expect(html.includes('data-phb-state="locked"')).toBe(!hasAccess);
	if (!hasAccess) { expect(html).toContain("Public excerpt"); expect(html).toContain("This post is for members"); }
});

it("fails closed on error decisions and hides excerpts when disabled", async () => {
	const container = await AstroContainer.create();
	const html = await container.renderToString(PaidContent, {
		props: { entry: { id: "test", data: { content: [{ _type: "block", children: [{ _type: "span", text: "ERROR_SECRET" }] }] } }, excerpt: "HIDDEN_EXCERPT" },
		locals: { paidAccess: { options: resolveOptions(), sessionToken: null, access: async () => ({ restricted: true, hasAccess: true, error: "unavailable", authenticated: false, email: null, requiredPlanSlugs: [], requiredProductIds: [], showExcerpts: false }), plans: async () => [], segments: async () => [], session: async () => ({ authenticated: false, email: null }) } },
	});
	expect(html).not.toContain("ERROR_SECRET"); expect(html).not.toContain("HIDDEN_EXCERPT"); expect(html).toContain('data-phb-state="locked"');
});
it("renders configured pricing, labelled forms, status messages and agent links", async () => {
	const container = await AstroContainer.create();
	const html = await container.renderToString(PaidContent, {
		request: new Request("https://site.test/post?phb=link-sent"),
		props: { entry: { id: "test", data: {} } },
		locals: { paidAccess: { options: resolveOptions({ accountPath: "/members", agentRoutePrefix: "/bots" }), sessionToken: null,
			access: async () => ({ restricted: true, hasAccess: false, authenticated: false, email: null, requiredPlanSlugs: [], requiredProductIds: [], agentsSold: true }),
			plans: async () => [{ slug: "plus", name: "Plus", description: "Member access", monthlyLabel: "$5", yearlyLabel: "$50" }], segments: async () => [], session: async () => ({ authenticated: false, email: null }) } },
	});
	for (const expected of ['action="/members/sign-in"', 'action="/members/checkout"', 'role="status"', "Monthly $5", "Yearly $50", "Check your email", "/bots/posts/test.md"]) expect(html).toContain(expected);
});
