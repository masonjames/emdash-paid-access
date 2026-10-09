# Troubleshooting

[Documentation](../README.md) / Troubleshooting

Start with the exact package version, EmDash/Astro versions, installation mode,
and the URL/status involved. Keep customer data, cookies, magic links, payment
signatures, and private keys out of screenshots and logs shared for support.

## Installation and rendering

| Symptom | Check |
| --- | --- |
| Plugin descriptor is not callable | Pass the default `paidAccessPlugin` export directly to `plugins`; it is not a factory |
| `Astro.locals.paidAccess` is missing | Add the `paidAccessAstro` integration and restart/rebuild; add the runtime type import for editor-only errors |
| Admin exists but public paywall does not | Install the companion and render `PaidContent` in the server-rendered theme |
| Routes conflict after installation | Existing `/account/*` pages may require `injectAccountRoutes: false` and your own handlers |
| Duplicate core registration | Use either the npm descriptor or a registry core installation, once |
| Locked body is still in page source | Remove duplicate rendering/serialized props and audit other body representations |
| A previously denied visitor sees paid content | Stop exposure and inspect CDN/proxy/static output using the hosting checklist |

## Members and Checkout

| Symptom | Check |
| --- | --- |
| Every member sees a paywall | Verify session, selected plan/product mapping, matching Stripe entitlement, and core availability |
| Signed-in free member is denied | Free-member entitlements are outside this beta; a members rule needs a configured product |
| No sign-in email | Configure an EmDash email provider; check delivery with test data and the canonical site URL |
| Link is invalid or expired | Links are one-use and expire after 15 minutes; request a new one |
| Link requests are throttled | Wait at least a minute; the implementation also limits repeated requests over an hour |
| Checkout will not start | Test/live key must match the product; an active monthly/yearly recurring price and email provider are required |
| Price button is missing | The plan needs a corresponding monthly/yearly display label |
| Charge differs from the label | The active Stripe price controls the charge; align display labels and remove ambiguous active prices |
| Trial label does not create a trial | This beta does not set Checkout trial parameters |
| Portal fails | Check the session, linked customer, and Stripe portal configuration |
| Canceled subscriber retains access | Check other matching products and eligible paid standalone invoices; entitlement is not session expiry |
| Own Stripe mode cannot be enabled | Use delegation while Restrict With Stripe is active |

See [Stripe setup and entitlement semantics](../guides/stripe-memberships.md).

## Agent requests

| Symptom | Check |
| --- | --- |
| 404 | Correct prefix/collection/slug, published non-preview entry, agent mode on, applicable rule or deliberate free opt-in |
| 403 | `members-only` is not sold to agents; subscriber tokens are not implemented |
| 402 after a plain GET | Expected for a paid entry; the client must understand and satisfy x402 |
| 401 with old settings | Saved Gateway configuration is unsupported; select the origin rail |
| 503 | Price, public payout address, network, compatible facilitator, x402 middleware, and core availability |
| Base mainnet fails before payment | Default facilitator is deliberately blocked for Base; configure a compatible production endpoint and rebuild |
| Free Markdown disappears with legacy plugin | Free agent reads are suppressed while legacy protection is active |
| Offer price looks stale | Offers cache publicly for up to five minutes; the purchase route resolves current rules |
| Paid read has no matching receipt | Settlement can succeed before storage fails; inspect sanitized server errors and reconcile the transaction |
| Test receipts do not appear in revenue | Select Base Sepolia in Receipts; overview revenue deliberately excludes test USDC |

The facilitator option supports an HTTPS URL, not custom auth headers. Neither a
query-token URL nor a Gateway trust string makes an unsupported provider work.

## Editor and rule changes

Use EmDash 1.2 for its editor form/select fixes. The panel requires
`content:publish_any`; settings and receipts require `plugins:manage`. Reader
membership does not grant either permission. If a public rule appears ignored,
check inherited taxonomy rules and their [precedence](access-policies.md#combining-rules).

Changes to route prefixes must match in admin and `paidAccessAstro`, followed by
a site rebuild. Restart the process after adding/removing the legacy plugin to
refresh cached presence.

## Ask for help

Open a [bug report](https://github.com/masonjames/emdash-paid-access/issues/new?template=bug_report.yml)
with minimal synthetic reproduction steps and the expected/observed result.
State which local and host checks passed; do not equate a successful build with
a successful real payment. For paid integration help, see [support](../../SUPPORT.md).
Send security reports [privately](../../SECURITY.md).
