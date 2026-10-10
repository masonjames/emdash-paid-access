# Changelog

## Unreleased

### Added

- `Astro.locals.paidAccess.segments({ entry? })` returns sorted audience
  segments for visual builders: `member` (signed in, not a paid entitlement),
  `plan:<slug>` for each owned plan, and `entitled` when the entry may render.
  It costs one entitlement check per request and returns `[]` when anything
  can't be verified.
- A private `entitlements` core route, called only by the companion, that
  reports the human mode and the reader's owned plans. It writes nothing to
  storage, apart from clearing an expired session.
- **Paid Access Rules → Add a rule for a page** adds a members-only rule for a
  published entry you edit outside EmDash's standard editor, such as a page
  built in a visual builder's own canvas. Page rules restrict people only and
  are never sold to AI agents. The form only adds a rule, never overwrites one,
  and needs no new permission. A page rule takes effect only when the site's
  route for those pages checks Paid Access.

### Changed

- Settings now refuse a new or renamed plan ID that can't form a
  `plan:<slug>` segment. A plan saved earlier with such an ID still loads,
  doesn't block saving other member settings, and can still be removed or
  renamed. `segments()` leaves it out.

### Fixed

- In stripe mode, an access check that requires an unknown or removed plan now
  fails closed, even beside a configured plan. It used to drop the unknown plan
  and could grant access. Off and delegate modes pass the plans through unchanged.
- HTML and every other `no-store` response, including paid agent Markdown and
  account redirects, now opt out of Astro's route cache. Before, a page hint or a
  configured route rule could still let Astro store such a response and replay it,
  for example a paid agent read to an unpaid agent. Sites without a cache
  provider are unaffected.

## 0.1.0-beta.1 — 2026-10-09

First standalone Paid Access beta, derived from Restrict With Stripe for EmDash
by Stranger Studios, released on npm with the `beta` tag. The EmDash
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
- Response middleware applies private/no-store to HTML, including streamed
  component responses. Non-HTML caching stays unchanged. Public HTML also
  bypasses shared caches in this beta.

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
