# Visual builders

[Documentation](../README.md) / Visual builders

A visual builder decides on the server which elements, theme parts and pages
a reader sees. Paid Access tells your host code who the reader is, in a form
the builder's audience rules can match, without either package importing the
other. Use this after [installing the companion](installation.md).

## What a builder gets

`Astro.locals.paidAccess.segments()` returns a plain `string[]`. Your host code
passes it to the builder. The builder needs no import from this package, and
Paid Access knows nothing about the builder: the list is the whole contract.

The vocabulary is closed:

- `member`: the reader is signed in with a verified email. It isn't a paid
  entitlement, because anyone can sign in with a magic link.
- `plan:<slug>`: the reader owns the Stripe product of that configured plan.
- `entitled`: only when you pass `entry`, and only when that entry's body may
  render for this reader. An entry without a Paid Access rule counts (in
  delegate mode, unless the legacy plugin restricts it).

The list is sorted and deduplicated, and each call returns its own array. It is
`[]` whenever anything can't be verified, including the entry's access
decision; `segments()` doesn't throw. Each request makes one entitlement check
however often you call it, so a layout and a page can each call it. The
[configuration reference](../reference/configuration.md#segments) has the
signature and the plan ID rules.

## Modes and failure

| Human mode | `member` | `plan:<slug>` | `entitled` (only with `entry`) |
| --- | --- | --- | --- |
| `stripe` | A valid Paid Access session | Each configured plan whose Stripe product the member owns | `canRenderBody(await access(entry))`, so unrestricted entries qualify |
| `delegate` | The legacy plugin's session, read with the forwarded cookie | Never: the legacy plugin owns plans, and `plans()` is `[]` | From the already-delegated `access(entry)` |
| `off` | Never | Never | Follows `access(entry)`: an unrestricted entry is entitled; a restricted one returns an error, so the list is `[]` |

In every mode, an unavailable or malformed answer from the core, the legacy
plugin or Stripe gives `[]`. In stripe mode without a Stripe key, a signed-in
reader gets `member` and no plans, or `[]` if you pass a restricted `entry`.

### "Only" and "Everyone except"

Builders usually offer two kinds of audience rule. Read each against an empty
list, because that is what every reader gets when Paid Access can't verify
something:

| Rule | Shows the element when the list | With `[]` | Use it for |
| --- | --- | --- | --- |
| Only `member` (or `plan:<slug>`, `entitled`) | Contains the segment | Hidden: it fails closed | Content for members and plan holders |
| Everyone except `member` | Lacks the segment | Shown | A teaser, sign-in prompt or call to action |

Put paid content only under "Only". "Everyone except" shows when the host sends
nothing, which is the safe direction for a teaser and the wrong one for
anything you sell. "Only `member`" is a sign-in wall, not a paywall; use
`plan:<slug>` or `entitled` for paid content.

These rules protect content only when the builder leaves a hidden element out
of the HTML. If it hides elements with CSS or client script, the content is
still in the page source.

## Host recipes

The examples use placeholder names for the builder's side, such as
`loadBuilderPage` and `BuilderPage`. Substitute your builder's own resolver and
component; Paid Access only supplies the list. A builder usually keeps its
pages in its own collection, for example `emvb_pages`.

### Pages

Get the list in the page route and hand it to the builder's page resolver:

```astro
---
const segments = await Astro.locals.paidAccess.segments();
const entry = await loadBuilderPage(Astro, { segments }); // your builder's page lookup
---
<BuilderPage entry={entry} />
```

### Theme parts and layout fragments

If the builder resolves headers, footers or other parts separately from the
page, hand them the same list. A second `segments()` call in the layout reuses
the request's entitlement check, so you don't need to pass the list down as a
prop.

```astro
---
// src/layouts/Site.astro
const segments = await Astro.locals.paidAccess.segments();
const parts = await loadBuilderParts(Astro, { segments }); // your builder's theme-part lookup
---
<BuilderPart part={parts.header} />
<slot />
<BuilderPart part={parts.footer} />
```

A header can then show an **Account** link under "Only `member`" and a
**Subscribe** link under "Everyone except `member`".

### Per-entry gating in a post template

Pass `entry` to add `entitled` for that entry. A post template can then show the
body to `entitled` readers and an excerpt with a call to action to everyone
else:

```astro
---
const entry = { collection: "posts", id: String(post.data.id ?? post.id), slug: post.id };
const segments = await Astro.locals.paidAccess.segments({ entry });
const template = await loadBuilderTemplate(Astro, { segments }); // your builder's post template
---
<BuilderTemplate template={template} post={post} />
```

In the template, put the body element under "Only `entitled`" and the excerpt
and call to action under "Everyone except `entitled`".

- `entry` takes the same object as `access()`. Pass the identity `PaidContent`
  uses: the content ID as `id` and the entry's route ID as `slug`. The decision
  is shared with an `access()` call for the same input in the same request.
- `entitled` follows the entry's rules. An entry without a Paid Access rule is
  entitled for everyone (in delegate mode, unless the legacy plugin restricts
  it), so give the post a `members` or `members-only` rule. In stripe mode the
  rule needs at least one plan: without one, the decision can't be verified
  and the list is `[]` for every reader.
- When the entry's decision can't be verified, the whole list is `[]`, not just
  missing `entitled`, so the reader sees the teaser.

If the template only needs to render the body as Portable Text, `PaidContent`
already does this without a builder rule.

## Teasers need no rule

Element-level gating is the builder's own audience rule, fed by `segments()`.
It needs no Paid Access rule. On an otherwise public page, show the full guide
under "Only `plan:plus`" and a summary with a link to your pricing page under
"Everyone except `plan:plus`". The page stays unrestricted, so every reader
gets the page and the builder chooses which block each one sees.

## Whole-page gating

To keep an entire builder page out of the HTML for readers without access,
give its entry a page rule and check it in the page route. Both steps are in
[Rules for pages of any collection](../reference/access-policies.md#rules-for-pages-of-any-collection).
Page rules restrict people only: they are always `members-only` and are never
sold to AI agents. In stripe mode, choose at least one plan for the rule.

## Caching duties

Segments make a response personal. Paid Access covers HTML; you cover anything
else that uses them.

- **HTML** needs nothing extra. The middleware sets `Cache-Control: private,
  no-store` and keeps the response out of Astro's route cache, as it does for
  every `no-store` response.
- **Non-HTML responses**, such as a JSON endpoint or a route that returns
  another format, must set `Cache-Control: private, no-store` themselves when
  they call `segments()`. The middleware then keeps them out of the route cache
  too.
- **Never serialize segments** into HTML, JSON or a data attribute. Use them on
  the server to decide what to render. A list in the page reveals the reader's
  plans, and client code shouldn't trust it.
- **A site middleware that wraps Paid Access** must not set a cache hint after
  its own `next()` for these responses, because a later hint turns the route
  cache back on. See [cache rules](hosting-and-caching.md#cache-rules).

Then run the [paid-then-unpaid checks](hosting-and-caching.md#prove-paid-then-unpaid-isolation)
on a builder page as well as a post.

## Delegate mode

When Members uses Restrict With Stripe (delegate mode), or a site set to
stripe mode is downgraded to delegate because Restrict With Stripe is active,
segments are narrower:

- `member` comes from the legacy plugin's session, read with the reader's
  forwarded cookie. A Paid Access session doesn't count.
- There are no `plan:*` segments, because the legacy plugin owns plans. Use
  `entitled` with an entry instead.
- `entitled` comes from the delegated `access()` decision, so the reader must
  satisfy both plugins' rules.

See [coexistence and migration](migration.md).

## Pricing without a mirror

Paid Access doesn't copy its plans into a collection for a builder's loop or
query element. The sandboxed core can't create collections, a builder loop
can't render the Checkout form, and a copy would be a second source of truth
for prices.

Render pricing from host code instead. `Pricing.astro` renders every configured
plan with its Checkout form. Place it in a host slot around the builder's
output, or in a region of a theme part that your host code fills, if the
builder offers one:

```astro
---
import Pricing from "emdash-paid-access/components/Pricing.astro";
const segments = await Astro.locals.paidAccess.segments();
const entry = await loadBuilderPage(Astro, { segments }); // your builder's page lookup
---
<BuilderPage entry={entry} />
{!segments.includes("plan:plus") && <Pricing redirect={Astro.url.pathname} />}
```

For your own markup, `Astro.locals.paidAccess.plans()` returns each plan's
public `slug`, `name`, `description`, `monthlyLabel`, `yearlyLabel` and
`trialLabel`. A Checkout form posts `planSlug`, `billingInterval`, `email` and
`redirect` to `<accountPath>/checkout` (`/account/checkout` by default;
`accountPath` is an integration option); see the
[public companion routes](../reference/configuration.md#public-companion-routes).
Outside stripe mode, `plans()` is `[]` and `Pricing` renders nothing.

## What the builder never sees

Segments carry only the vocabulary above. They never include:

- the reader's email address;
- session tokens or cookies;
- EmDash staff roles, because segments never read `Astro.locals.user`;
- Stripe customer or product IDs.

[Configuration](../reference/configuration.md#segments) ·
[Access policies](../reference/access-policies.md) ·
[Hosting and caching](hosting-and-caching.md)
