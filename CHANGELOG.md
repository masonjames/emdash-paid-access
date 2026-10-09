# Changelog

## 0.1.0-beta.1 — npm beta candidate

First standalone Paid Access beta, derived from Restrict With Stripe for EmDash
by Stranger Studios. npm publication is pending release acceptance. The EmDash
registry remains unpublished and is a separate distribution step.

### Added

- Independent Stripe membership and x402 payment modules, both off by default.
- Per-entry and taxonomy policies: public, agent paid reads, members, members only.
- Block Kit settings, rules, editor controls, and receipt pages.
- Stripe plan catalog, Checkout, portal, and magic-link sessions.
- Astro companion with server-side body gating, pricing/paywall components,
  account handlers, agent Markdown, and offer discovery.
- Origin x402 settlement and receipts, with Base Sepolia for development.
- Delegated access checks while Restrict With Stripe remains installed.
- Hybrid npm/standard-plugin packaging, attribution, and listing artwork.
- A complete GPL plugin without license keys, paid feature tiers, or a transaction
  percentage. Setup, migration, hosting, and support are separate services.

### Hardened

- Unsupported Gateway configuration is rejected, with a recovery path for saved
  Gateway settings. The known test facilitator is refused for Base mainnet reads.
- Receipts separate Base mainnet from Base Sepolia, and overview revenue excludes
  test USDC.
- Private routes declare permissions explicitly; real settlement testing requires
  an explicit opt-in.
- Repeatable release checks validate built exports, bundled files, and sandbox
  behavior before publication.

### Compatibility

- Targets EmDash 1.2 and x402 1.2, with Astro 6.1.3 / 7.3.5 validation targets.
- Registry installation requires the npm Astro companion and theme integration.
- npm and registry artifacts share a source version; registry discovery remains
  a separate publication/approval step.

### Beta limitations

- No Gateway verification, subscriber agent tokens, passes, free-member entitlement,
  automated migration, or checkout trial configuration.
- Initial target is Node; a successful local build does not certify payment,
  cache, or deployment acceptance. Registry core plus companion and
  Cloudflare/Workers require separate host verification before being offered.
- Themes, APIs, feeds, search, and caching require a protected-content audit.

Earlier commits remain in Git history, including the original Restrict With
Stripe release and the changes described in [NOTICE.md](NOTICE.md).
