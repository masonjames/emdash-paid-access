# Configuration reference

[Documentation](../README.md) / Configuration

## Astro integration

```ts
import { paidAccessAstro } from "emdash-paid-access/astro";

paidAccessAstro({
  collections: ["posts"],
  agentRoutePrefix: "/agents",
  accountPath: "/account",
  injectAccountRoutes: true,
  facilitatorUrl: "https://x402.org/facilitator",
  legacyPluginId: "restrict-with-stripe",
});
```

All options are optional; the example shows their defaults.

| Option | Behavior |
| --- | --- |
| `collections` | Nonempty array of collection names allowed on agent routes |
| `agentRoutePrefix` | Absolute path without a trailing slash, query, fragment, or `..` |
| `accountPath` | Same path restrictions; prefix for injected account handlers |
| `injectAccountRoutes` | Set false if the site supplies its own account handlers |
| `facilitatorUrl` | HTTPS endpoint without credentials, query, or fragment; normalized without trailing slashes |
| `legacyPluginId` | ID of the legacy membership plugin used by the companion |

These are build-time settings. Change paths in the companion **and** Advanced
settings in the plugin admin, then rebuild. The admin stores the account path
with a trailing slash; the companion option uses none. Do not inject routes
that collide with account pages already provided by your site.

Admin settings separately hold runtime choices: human mode/plans, secret Stripe
key, excerpt preference, agent mode, rail, network, payout address, and free
Markdown preference. A different payout/network does not change the facilitator
endpoint. [Mainnet configuration limits](../guides/x402-payments.md#mainnet-is-a-separate-configuration)
apply even if the admin lets you select Base.

## Components

Import individual Astro files from `emdash-paid-access/components/`.

| Component | Props | Purpose |
| --- | --- | --- |
| `PaidContent.astro` | `entry`, optional `collection`, `excerpt`, `redirect` | Checks access and renders Portable Text or the locked UI |
| `Pricing.astro` | `redirect: string` | Displays configured Stripe plans and Checkout forms |
| `Paywall.astro` | `decision`, `redirect`, `collection`, `slug` | Default member UI; normally rendered by `PaidContent` |

`PaidContent.entry` is `{ id: string, data: { id?: string, content?: PortableTextBlock[] } }`.
`collection` defaults to `posts`; `redirect` defaults to the current pathname.
The optional excerpt only appears when settings permit excerpts. The component
sets private/no-store on the page response.

```astro
<PaidContent entry={post} collection="posts" excerpt="A public introduction.">
  <section slot="locked">
    <h2>Continue with a membership</h2>
    <a href="/membership/">View plans</a>
  </section>
</PaidContent>
```

The slot replaces the entire default paywall; `/membership/` is a page your site
must provide. Never render the protected body inside the slot or pass it as the
excerpt. To customize colors/shape, set CSS properties such as `--phb-accent`,
`--phb-border`, `--phb-radius`, and `--phb-muted` on an ancestor.

## Server locals

The companion adds `Astro.locals.paidAccess` per request:

| Member | Use |
| --- | --- |
| `access({ collection, id, slug, requiredPlanSlugs? })` | Returns a human access decision, memoized within the request |
| `session()` | Returns `{ authenticated, email }` for a Paid Access member session |
| `plans()` | Public plan labels, empty when unavailable or delegation suppresses them |
| `options` | Resolved companion options |

For a custom renderer, require `decision.hasAccess === true` **and no error**.
Use the exported `canRenderBody` helper from `emdash-paid-access/astro/runtime`
instead of inferring access from `authenticated` or an EmDash staff role.
Preserve the response's private/no-store header in a custom integration.

## Public companion routes

Default paths are below; custom prefixes change them.

| Route | Method | Input / result |
| --- | --- | --- |
| `/agents/{collection}/{slug}.md` | GET, HEAD | Paid/free Markdown according to policy; HEAD never settles |
| `/agents/offers.json` | GET | `limit`, `cursor`; returns offer items and `nextCursor` |
| `/account/sign-in` | POST | Form `email`, `redirect`; sends sign-in link |
| `/account/verify` | GET | `token`, optional `redirect`; establishes session |
| `/account/checkout` | POST | Form `planSlug`, `billingInterval`, `email`, `redirect` |
| `/account/complete` | GET | `session_id`, `redirect`; verifies Checkout and sends link |
| `/account/portal` | GET | Session required; optional `return` path |
| `/account/logout` | POST | Revokes session and removes cookie |

The account routes redirect back with a `phb` query status consumed by the
default paywall. They do not render an account dashboard. Redirect targets are
restricted to local site paths; Stripe destinations are validated separately.

The core's routes under `/_emdash/api/plugins/paid-access/` are an implementation
boundary. Prefer the companion, components, and documented locals over coupling
a theme to internal admin/receipt routes.

Source: [options](../../src/astro/options.ts), [integration](../../src/astro/index.ts),
[components](../../src/components), [runtime](../../src/astro/runtime.ts).
