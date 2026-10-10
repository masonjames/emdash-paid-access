# Install in an EmDash site

[Documentation](../README.md) / Installation

This guide starts with a working **server-rendered EmDash 1.2 site on Node**.
Paid Access does not create the host site or configure its database, storage,
email provider, or deployment adapter.

## 1. Choose a package

The public npm beta is `0.1.0-beta.2`. The EmDash registry remains unpublished. An npm installation on
Node includes the core descriptor and companion and does not need a registry
listing.

Install the exact beta in your site:

```sh
pnpm add emdash-paid-access@0.1.0-beta.2 @emdash-cms/x402@1.2.0
```

The site must satisfy these peer requirements: `emdash ^1.2.0`,
`astro ^6.1.3 || ^7.3.5`, and `@emdash-cms/x402 ^1.2.0`.
The installed runtime supports Node 22.12+.

### Build from source

Use Node 22.18+ to build the source and the pnpm version declared in `package.json`.
Use this path when evaluating or modifying the source:

```sh
git clone https://github.com/masonjames/emdash-paid-access.git
cd emdash-paid-access
pnpm install --frozen-lockfile
pnpm release:check
```

The command writes a checked npm archive under `artifacts/`. In your site:

```sh
pnpm add /path/to/emdash-paid-access/artifacts/emdash-paid-access-0.1.0-beta.2.tgz @emdash-cms/x402@1.2.0
```

Record the source commit and archive checksum you evaluated. A source build
and a future npm upload with the same version are only equivalent when their
contents match.

## 2. Register the core and companion

Merge this into `astro.config.mjs`, retaining your adapter, database, storage,
and other plugins. This is an integration example, not a complete host config.

```js
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import paidAccessPlugin from "emdash-paid-access";
import { paidAccessAstro } from "emdash-paid-access/astro";

export default defineConfig({
  output: "server",
  // Keep your existing Node adapter.
  integrations: [
    paidAccessAstro({
      collections: ["posts"],
      facilitatorUrl: "https://x402.org/facilitator",
    }),
    emdash({
      // Keep your existing database, storage, and other options.
      plugins: [paidAccessPlugin],
    }),
  ],
});
```

`paidAccessPlugin` is a descriptor, **not a factory**. Do not call it.
`paidAccessAstro` registers the x402 integration for its own endpoints; adding a
second x402 integration for those endpoints is unnecessary.

| Mode | Core | Companion |
| --- | --- | --- |
| npm on Node | Descriptor in `plugins` as above | `paidAccessAstro` plus theme components |
| Registry, after publication and host verification | Installed in EmDash | Still installed from npm |

Install the core once. A registry installation replaces the descriptor in the
host's `plugins` array, not the companion or theme integration. A core installed
by itself can supply admin/storage features but cannot protect the public body.

For `Astro.locals.paidAccess` type completion, add to the site's `src/env.d.ts`:

```ts
import type {} from "emdash-paid-access/astro/runtime";
```

## 3. Render the protected body once

In the server-rendered post template, use the entry already loaded by the page:

```astro
---
import PaidContent from "emdash-paid-access/components/PaidContent.astro";
// `post` is the EmDash entry fetched by your page.
---
<PaidContent entry={post} collection="posts" />
```

The entry has the shape `{ id, data: { id?, content? } }`: `id` is the slug,
`data.id` is the content ID when present, and `content` is Portable Text.
`PaidContent` performs the decision and renders Portable Text only when allowed.
Do not additionally render the same body, place it in hydrated props, or pass it
as an excerpt. Do not prerender a member-dependent page at build time.

See [component options](../reference/configuration.md#components) for excerpts,
a custom locked slot, pricing, and styling variables.

## 4. Configure one module and one rule

Both modules are off on a fresh install. Choose one route to a first test:

- **Agent test:** configure [Base Sepolia paid reads](x402-payments.md), then give
  a published test post an `agents-pay` rule and a price. Its human HTML stays public.
- **Member test:** configure [Stripe test memberships](stripe-memberships.md),
  then give a published test post a `members` rule with a configured plan.

Set rules in the editor's **Paid access** panel or **Paid Access Rules**. Staff
using the editor panel need `content:publish_any`; settings and receipt access
require `plugins:manage`.

## 5. Verify the host boundary

With the companion enabled, the beta sets `Cache-Control: private, no-store` on
HTML responses, including public pages. Shared HTML caching is unavailable in
this configuration. Configure your proxy/CDN to honor those headers and clear
any HTML cached before enabling the integration. Include the extra origin
traffic in your hosting plan.

For a locked post, a signed-out page should show the paywall without the paid
body in HTML or embedded data. An entitled reader should see the body. For an
agent-paid post, an unpaid agent GET should return 402 without the body.

Then complete the [hosting/cache checks](hosting-and-caching.md), including feeds,
content APIs, search, alternate Markdown, and a paid-then-unpaid request to the
same URL. These are required site checks; the plugin's component tests cannot
verify your theme or CDN.

Next: [Stripe](stripe-memberships.md) · [x402](x402-payments.md) ·
[Troubleshooting](../reference/troubleshooting.md)
