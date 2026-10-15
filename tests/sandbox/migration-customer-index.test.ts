// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, it } from "vitest";
import { createPluginRuntimeTestHost } from "@emdash-cms/plugin-test";

const hash = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, "0")).join("");

it("uses the declared customer-ID index through core storage and retains the binding across restart", async () => {
	const host = await createPluginRuntimeTestHost();
	try {
		const email = "index@example.invalid";
		const secret = "sk_test_synthetic_index_only";
		for (const [key, value] of Object.entries({ humansMode: "stripe", humansPlans: [{ slug: "plus", name: "Plus", stripeProductId: "prod_plus", grantsVisibility: [] }], stripeAccountId: "acct_fixture", stripeEnvironment: "test", stripeSecretKey: secret })) await host.fixtures.plugin.setting(key, value);
		const common = { email, stripeCustomerId: "cus_reviewed", createdAt: "2026-10-15", updatedAt: "2026-10-15" };
		const bound = { ...common, migrationBinding: { version: 1, accountId: "acct_fixture", environment: "test", sourceSha256: "a".repeat(64), credentialSha256: await hash(secret) } };
		// The sandbox bridge stores KV in __kv; native createKVAccess uses options.
		await host.fixtures.plugin.kv("migration:customer-bindings:v1", { version: 1, members: { [email]: { stripeCustomerId: bound.stripeCustomerId, migrationBinding: bound.migrationBinding } } });
		await host.fixtures.plugin.storage("customers", "retained-import-key", bound);
		await host.fixtures.plugin.storage("sessions", await hash("session-fixture"), { email, expiresAt: "2999-01-01T00:00:00.000Z" });
		await host.fixtures.plugin.storage("restrictions", "posts:one", { contentId: "one", collectionSlug: "posts", policy: "members", requiredPlanSlugs: ["plus"] });
		for (let attempt = 0; attempt < 2; attempt++) {
			await host.http.respond("https://api.stripe.com/v1/customers/cus_reviewed", Response.json({ id: "cus_reviewed", email, livemode: false }));
			await host.http.respond("https://api.stripe.com/v1/subscriptions?customer=cus_reviewed&status=all&limit=100", Response.json({ data: [{ status: "active", items: { data: [{ price: { product: "prod_plus" } }] } }] }));
			const response = await host.actions.routes.request("access", { method: "POST", headers: { "X-EmDash-Request": "1" }, body: { collectionSlug: "posts", contentId: "one", sessionToken: "session-fixture" } });
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ success: true, data: { hasAccess: true } });
			expect(await host.inspect.storage.get("customers", "retained-import-key")).toEqual(bound);
			if (attempt === 0) await host.restart();
		}
		// An unrelated native customer still traverses the declared reverse ID index.
		await host.fixtures.plugin.storage("customers", "ordinary@example.invalid", { ...common, email: "ordinary@example.invalid", stripeCustomerId: "cus_ordinary" });
		await host.fixtures.plugin.storage("sessions", await hash("ordinary-fixture"), { email: "ordinary@example.invalid", expiresAt: "2999-01-01T00:00:00.000Z" });
		await host.http.respond("https://api.stripe.com/v1/subscriptions?customer=cus_ordinary&status=all&limit=100", Response.json({ data: [{ status: "active", items: { data: [{ price: { product: "prod_plus" } }] } }] }));
		const ordinary = await host.actions.routes.request("access", { method: "POST", headers: { "X-EmDash-Request": "1" }, body: { collectionSlug: "posts", contentId: "one", sessionToken: "ordinary-fixture" } });
		expect(await ordinary.json()).toMatchObject({ success: true, data: { hasAccess: true } });
		await host.fixtures.plugin.storage("sessions", await hash("alias-fixture"), { email: "alias@example.invalid", expiresAt: "2999-01-01T00:00:00.000Z" });
		await host.fixtures.plugin.storage("customers", "alias@example.invalid", { ...common, email: "alias@example.invalid" });
		host.http.clear();
		const denied = await host.actions.routes.request("access", { method: "POST", headers: { "X-EmDash-Request": "1" }, body: { collectionSlug: "posts", contentId: "one", sessionToken: "alias-fixture" } });
		expect(await denied.json()).toMatchObject({ success: true, data: { hasAccess: false } });
		expect(host.http.requests()).toEqual([]);
	} finally { await host.dispose(); }
});
