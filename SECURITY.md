# Security

Report access-control bypasses, session issues, secret exposure, or payment
verification flaws to **hi@masonjames.com**, subject **Paid Access security report**.
Do not open public issues with exploit details or private data. The maintainer's
published contact is https://masonjames.com/.well-known/security.txt.

Include plugin/EmDash/Astro versions, installation mode, affected route, expected
and observed behavior, and a minimal reproduction using synthetic content.
Redact API keys, cookies, magic links, personal data, and private keys. Use Stripe
test mode and Base Sepolia for reproductions.

Only the current beta line is being prepared for maintenance. There is no
guaranteed response time or supported production release yet. Fixes will be
documented in a new version; do not assume a published tarball can be replaced.

Paid Access depends on the theme using the server-side access decision. The
README describes the required public-route and cache review. A client-side
hidden body or UI-only paywall is not access control.
