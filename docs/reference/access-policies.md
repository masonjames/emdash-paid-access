# Access policies

[Documentation](../README.md) / Policies

Entry rules and taxonomy rules are combined. A page cannot loosen a stronger
rule inherited from a category or tag by adding a public rule.

## Decision matrix

This table assumes the relevant modules are enabled, the content is published,
and price/plan/provider configuration is valid.

| Effective policy | Human without entitlement | Human with matching entitlement | Agent in paid mode |
| --- | --- | --- | --- |
| `public` | Full body | Full body | Free Markdown for an explicit rule |
| `agents-pay` | Full body | Full body | x402 payment required |
| `members` | Paywall | Full body | x402 payment required |
| `members-only` | Paywall | Full body | 403; not for sale in this beta |
| No rule | Full body unless another integration restricts it | Same | 404 by default |

`agents-pay` does not protect the human HTML from scrapers. It provides a paid
Markdown service for agents. A membership does not grant an agent a free read;
subscriber tokens and passes are not implemented.

Human denied/error decisions render a paywall with HTTP 200 through
`PaidContent`. A member's identity is distinct from entitlement: being signed in,
or having an EmDash admin role, is not by itself permission to read a members post.

## Combining rules

Policy strength is:

```text
members-only > members > agents-pay > public
```

For agent-sold policies, the highest valid price among matching `members` and
`agents-pay` rules applies. `members-only` prevents sale regardless of that price.
Prices must be positive and have at most six decimal places.

For humans, matching members rules contribute their plan/product requirements.
The combined product set is an **OR**: any matching configured product can grant
access, not all selected plans at once. Entitlements may come from active/trialing
subscriptions or eligible paid standalone invoices; see [Stripe behavior](../guides/stripe-memberships.md#what-grants-access).
Unknown/empty plan mappings cannot create a free-member entitlement. In stripe
mode, `access({ requiredPlanSlugs })` that names any unknown or removed plan is
denied, even when it also names a configured one. Off mode returns its usual
error, and delegate mode forwards the slugs for the legacy plugin to enforce.

During legacy delegation, the reader must satisfy each plugin's restrictions;
Paid Access does not let a successful legacy response silently discard its
requirements. Free agent access is suppressed while legacy presence/delegation
is active. See [migration](../guides/migration.md).

## Safe defaults and disabled modes

- Both modules default off. Agent mode off returns 404.
- Entries without rules do not get agent Markdown unless `freeByDefault` is
  explicitly enabled, and legacy protection can still suppress it.
- Turning human access off does not unlock existing members rules.
- Missing required product configuration, unavailable entitlement checks, and
  uncertain legacy state deny the body.
- The agent endpoint rejects draft/preview content even when the host supports previews.
- An unavailable price, payout wallet, network, enforcer, or payment service can
  return 503 instead of content.

## Agent HTTP responses

| Status | Meaning |
| --- | --- |
| 200 | Free permitted content or a successfully settled paid read |
| 402 | Payment required; x402 describes the offer in response headers |
| 403 | Subscriber-only/not-for-sale policy in this beta |
| 404 | Disabled, not offered, missing, unpublished, or disallowed collection |
| 503 | Access/payment configuration or a required service is unavailable |

A saved obsolete Gateway configuration may return 401; recover by choosing the
origin rail in Advanced settings. New Gateway settings are rejected. Protocol
validation errors may also be returned by the x402 integration; inspect the
sanitized response rather than treating every denial as a missing post.

Agent content responses are `text/markdown; charset=utf-8` and private/no-store.
403/404 explanatory Markdown can include the title/canonical URL but not the paid
body. [Cache behavior](../guides/hosting-and-caching.md#cache-rules) differs for
the public offers list.

Source: [resolver](../../src/resolver.ts), [rule combination](../../src/restrictions.ts),
[human access](../../src/handlers/access.ts), [agent serving](../../src/agent.ts).
