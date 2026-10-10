# Paid Access documentation

Paid Access combines a standard-format EmDash core with an Astro companion.
The public npm beta is `0.1.0-beta.1`; the EmDash registry remains unpublished.
The installation guide covers npm and building from source. The
[live demo](https://masonjames.com/blog/paid-access-demo/) uses Stripe memberships
for people and Base Sepolia test USDC for agents.

## Set up a site

1. [Install the plugin and companion](guides/installation.md), then gate the body.
2. Configure [Stripe memberships](guides/stripe-memberships.md),
   [x402 paid reads](guides/x402-payments.md), or both.
3. Choose [access policies](reference/access-policies.md).
4. Verify [hosting, public content surfaces, and caching](guides/hosting-and-caching.md).

Already running Restrict With Stripe? Start with
[coexistence and migration](guides/migration.md) before changing member access.

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
