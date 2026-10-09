# Hosting and cache isolation

[Documentation](../README.md) / Hosting

Paid Access protects content at request time. A theme, export, or cache that
serves the same body without that check can still expose it. Verify the entire
site, not just the paywall's appearance.

## Runtime requirements

- Serve protected pages dynamically with a compatible Astro adapter. Do not
  prerender member-dependent pages or their content into static output.
- Keep EmDash's storage durable across restarts; rules, sessions, and receipts
  must survive a deployment.
- Configure the canonical site URL and HTTPS correctly so cookies, sign-in links,
  and Stripe return URLs use the intended host.
- Keep test and production credentials and payout settings distinct. The initial
  deployment target is Node; a passing sandbox test does not certify every
  Cloudflare/Workers host or proxy arrangement.

## Cache rules

| Surface | Application behavior | Host requirement |
| --- | --- | --- |
| Page using `PaidContent` | `Cache-Control: private, no-store` | Do not cache HTML that depends on a member session |
| `/agents/{collection}/{slug}.md` | Private/no-store, including denied responses | Bypass shared caches; do not replay a paid body to an unpaid request |
| Successful account redirects | Private/no-store | Bypass `/account/*`; never cache sign-in/verification responses |
| `/agents/offers.json` | `public, max-age=300` | Public metadata only; allow up to five minutes of offer staleness |
| Static assets | Host-managed | Ordinary static caching may remain enabled |

An explicit `/agents/*` bypass is a simple conservative policy even though the
offers list can be cached. If you make an exception for the list, match that
exact path, not all `.json` or Markdown responses. Do not route paid content
through an extension-based public cache rule. Use your CDN/proxy's own rule
ordering semantics to ensure the bypass wins over a broad cache-everything rule.

Do not place session tokens or payment signatures in cache keys, analytics, or
request logs. A URL with no query string can still be a personalized response.

## Audit every public representation

Choose a synthetic, unmistakable marker in the protected body, such as
`PAID_ACCESS_PRIVATE_BODY_CHECK`. Keep the title/excerpt different so the test is
not confused by deliberately public metadata.

Check these surfaces while signed out and without a payment:

- Human HTML and page source, including embedded JSON and client hydration data.
- Alternate Markdown or content-negotiated responses.
- RSS/Atom feeds, archive cards, search results, and search indexes.
- Public REST/GraphQL/content APIs used by the site.
- Preview routes, static builds, sitemap extensions, and generated exports that
  might carry more than public metadata.

The protected marker should be absent everywhere the viewer lacks access.
Disable, redact, or apply the same access decision to any public surface that
currently exposes the body. `PaidContent` only controls its own rendering.

For `agents-pay`, the human HTML is intentionally public; use `members` if human
readers must also have an entitlement. Crawler user-agent strings do not change
these policies.

## Prove paid-then-unpaid isolation

1. Request the exact protected URL without a session/payment; record status,
   cache headers, and whether the marker is absent.
2. Read it with a valid test membership or testnet payment; confirm the marker
   is present and the response is private/no-store.
3. Request the **same URL** again from a fresh client with no cookies or payment
   headers; the marker must still be absent.
4. Repeat through the public CDN/proxy, not only against a local origin. Inspect
   any cache-status/Age headers the provider adds.
5. Repeat after a restart and after the relevant membership expires or is removed.

Preserve sanitized results with the tested artifact hash and host configuration.
Do not store real subscriber bodies, cookies, signatures, or credentials as evidence.

## Rollback

Keep the previous plugin artifact and a database backup before changing a live
site. Disable agent sales to stop new agent reads, and restore a known-good
build/configuration if needed. Turning the human module off **does not unlock**
members rules and may lock out paying readers. Removing `PaidContent` can expose
content; it is not a safe generic rollback.

[Architecture](../reference/architecture-and-security.md) ·
[Troubleshooting](../reference/troubleshooting.md)
