# Reader protection integration

Reader protection is opt-in and requires the core reader-access export and a compatible trusted server provider. Existing installations without bindings keep their current read behavior.

For Paid Access, merge these options into the site's existing integrations. Keep the plugin's existing registration and settings.

```ts
import emdash from "emdash/astro";
import { paidAccessAstro } from "emdash-paid-access/astro";

// Inside defineConfig({ integrations: [...] }):
emdash({
  // Existing database, plugins, storage and other options.
  readerProtection: {
    posts: {
      provider: "paid-access",
      revision: "reader-v1",
      publicFields: ["title", "excerpt"],
    },
  },
}),
paidAccessAstro({
  // Existing companion options.
  readerProtection: true,
}),
```

The EmDash binding applies to every locale in the collection and remains in host configuration when a provider is unavailable or removed. Do not remove it when disabling Paid Access. Missing providers, invalid metadata, timeouts and failures deny reads. Paid Access remains the policy authority; the binding stores no membership rules. Only explicitly approved scalar fields appear in previews; nested JSON, layout, body, references and arbitrary envelope fields are excluded. Choose preview fields that contain public text. Check `readerAccess === "preview"` before accessing fields omitted from the configured projection.

The companion option automatically registers its reader middleware after its normal middleware. EmDash registers a response guard before its configured outer middleware. Astro runs pre middleware, site middleware, then post middleware; responses unwind in reverse order. Place EmDash before other integrations that register header-rewriting pre middleware. The core guard therefore overrides late feed/site public headers and works even if Paid Access is absent. With any binding, origin responses use private, no-store and route caching is disabled conservatively, including responses that may stream protected reads later.

## Activation and existing caches

Deploying the binding starts origin gating. It does not remove old route-cache or CDN responses. Before describing protection as effective, use `activateReaderProtection` from `emdash/reader-access` with host-owned durable persistence and verified cache invalidation:

```ts
const result = await activateReaderProtection("posts", {
  persist: saveActivationState,
  invalidate: invalidateAndVerifyHostCaches,
});
```

These callbacks are host functions, not supplied cache adapters. `persist` receives collection, revision and pending/failed/active state. `invalidate` must return `{ routeCache: "purged" | "disabled", edgeCache: "purged" | "disabled", confirmation: string }` only after confirming both caches, including feeds and pages that embed the collection. The helper persists pending first and records active only after acknowledgement and successful persistence. Failure cannot yield an active result. Until confirmation, block any Active/protection-effective claim. No CDN operation is performed by this helper. Keep the gate enabled through subsequent policy changes and do not roll back to a build without it while protection is required.

## Read boundaries

Public entries, lists, referenced entries, plugin content reads and search use the gate. Public and entitled search matches remain visible; preview and denied matches expose no snippets or counts. Search examines at most 200 protected candidates per operation with at most 16 concurrent decisions; pagination covers that bounded candidate window, not every match in a large collection.

Paid Access combines restrictions across translation siblings, including required plans and inherited policies, without copying rules. Unknown, incomplete or oversized translation groups deny access. Public translation metadata, archive dates, direct taxonomy/byline assignments and SEO peek data are conservatively unavailable for bound collections. Trusted editorial and policy reads retain server authorization. Unbound collections retain their content cache path.

`withTrustedContent` is a server-only capability for policy resolution and native payment handlers that separately authorize release. Never expose it through request fields. Raw rows can exist inside trusted server processing; the gate protects public returns before serialization, not SQL loading itself. Existing public media URLs and arbitrary direct database access are outside this contract. Static output and independently cached endpoints require host review.

The native Paid Access route reads trusted raw content so a preview is not mistaken for the full paid body. Its existing quote/protection checks still determine release. This integration does not implement payment settlement changes.
