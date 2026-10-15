# Paid Access documentation

Paid Access combines a standard-format EmDash core with an Astro companion.
This source revision prepares beta.3 and requires the matching reviewed core
and host setup. See the [beta.3 compatibility gate](releases/0.1.0-beta.3.md);
source availability does not mean npm or production availability.
The recorded npm beta, `0.1.0-beta.2`
([historical verification](releases/0.1.0-beta.2.md)), and existing demo do not
qualify this candidate. The installation guide distinguishes that beta from
building an exact source revision.

## Set up a site

1. [Install the plugin and companion](guides/installation.md), then gate the body.
2. Configure [Stripe memberships](guides/stripe-memberships.md),
   [x402 paid reads](guides/x402-payments.md), or both.
3. Choose [access policies](reference/access-policies.md).
4. Verify [hosting, public content surfaces, and caching](guides/hosting-and-caching.md).

Already running Restrict With Stripe? Start with
[the offline migration guide](guides/migration.md) before changing member access.

Building pages in a visual builder? See [visual builders](guides/visual-builders.md)
for audience segments, teasers, page rules, and pricing.

## Reference

| Document | Covers |
| --- | --- |
| [Configuration](reference/configuration.md) | Integration options, components, locals, and account routes |
| [Access policies](reference/access-policies.md) | Precedence, prices, entitlements, and safe defaults |
| [Architecture and security](reference/architecture-and-security.md) | Core/companion boundary, permissions, storage, and failure behavior |
| [Troubleshooting](reference/troubleshooting.md) | HTTP responses, login, Checkout, editor, and cache symptoms |

## Build and maintain

- [Testing and releases](guides/testing-and-releases.md): commands, artifacts,
  live-test opt-in, rebuilds, and the distinction between release checks and host acceptance.
- [Contributing](../CONTRIBUTING.md), [changelog](../CHANGELOG.md),
  [support](../SUPPORT.md), and [security reporting](../SECURITY.md).

Examples use synthetic content, Stripe test mode, and Base Sepolia. Configure
real accounts and production payment services only after proving the site with
test data. No demo server or payment service is started by the build commands.

[Back to the project](../README.md)
