# Migrate member access

[Documentation](../README.md) / Migration

Paid Access owns its membership settings, sign-in sessions, Stripe checks and
content rules. It does not call, probe, or require Restrict With Stripe at runtime.
That plugin can be an explicit, offline migration source; its code and data remain
under its own maintainer's control.

A saved `delegate` setting or Paid Access's historical
`state:legacyPluginPresent=true` marker becomes **Migration required**, even if
the saved human mode says Off or Stripe. That marker records earlier delegated
protection; it is not a live probe of another plugin. Existing rules and plans
are preserved. Membership mode, plans, the editor and Rules page stay locked
until an explicit reviewed offline migration completes. You can still save
Stripe keys and excerpt preferences; those saves do not complete migration.

## Review the migration before changing a site

1. Record the current build and take a recoverable database backup. Work first
   on a disposable copy with synthetic or sanitized member data.
2. Inventory the source rules, plans and customer associations. Build an explicit
   mapping to Paid Access; do not infer plan equivalence from names or labels.
3. Review the mapping and rehearse its application offline. There is no automatic
   import on plugin installation, page load or sign-in. Do not copy secrets or
   session tokens into a migration report.
4. Configure Paid Access's own Stripe test-mode key through its secret settings
   field and configure an EmDash email provider. Use the intended Stripe account
   and product IDs; a customer's email alone is not a reviewed identity mapping.
5. Configure the site to use Paid Access's own routes, reader protection and
   pricing. Remove old-plugin imports, registration and route calls from the
   candidate build. The separately reviewed offline migration procedure must explicitly clear
   the historical marker and transition member configuration only after
   preserving its protection in native rules. The audit is not an importer;
   a marker-only edit or settings save must never substitute for that procedure.
   Selecting **Off** does not unlock stored member restrictions.
6. Have test members sign in again using Paid Access. Old-plugin sessions are not
   accepted or bridged. Verify eligible, ineligible, canceled and signed-out
   readers, then run the [public-content/cache audit](hosting-and-caching.md).
7. Approve the deployment and recovery procedure separately after the rehearsal.
   Keep the source backup and migration report; do not delete the old plugin's
   records as part of application startup.

| Data | Preserve and verify |
| --- | --- |
| Entry and taxonomy rules | Stable content IDs, locales, inherited policies and required entitlements; no rule may become weaker because another rule is absent |
| Paid Access's older slug-keyed rules | Merge with its entry-ID rules explicitly, retaining the strongest restrictions; these are Paid Access records, not calls to the old plugin |
| Plans and Stripe products | Stable plan IDs and exact product associations, including rules referring to removed plans |
| Customers | Exact Stripe customer IDs and their approved member associations in the intended Stripe account/environment |
| Sessions | New Paid Access sign-in; no imported tokens or cookie bridge |
| Public pricing | The intended products, supported recurring prices and billing intervals |
| Recovery | The prior build and data compatibility proof, with no automatic database restore that discards new member writes |

Free-member entitlements and automatic migration are outside this release. Do
not replace a free-members rule with a paid membership rule and assume sign-in
alone will unlock it. Displaying a trial label does not configure Checkout trials.

Paid Access never refreshes the historical marker by calling another plugin.
If it records earlier delegated protection, retain the migration lock until
that protection has been explicitly mapped and verified. If a migration cannot
be verified, keep the candidate locked and resolve the mapping before proceeding.

## Offline audit and retained-source receipt

This audit currently supports the Mason James imported plan identifiers
(`default-product` and `content-personall-ai`). Other installations need a
separately reviewed mapping; unknown identifiers are refused.

The optional `emdash-paid-access/migration-audit` export inspects an existing
SQLite connection using SELECTs only. It emits counts and action categories;
credentials, session tokens, member identities and content bodies are not read
into the report. Its command-line adapter requires the host's `better-sqlite3`
dependency and a closed standalone database copy:

```sh
node node_modules/emdash-paid-access/scripts/legacy-migration-audit.mjs --offline-database /absolute/path/to/offline-copy.db
```

After independently mapping and rehearsing the native settings and rules,
`--prepare-review` can emit a receipt candidate containing hashes and counts.
Preparation still reports migration pending; it is not approval. Review the
candidate and pin the exact UTF-8 JSON bytes outside plugin settings. The caller
may pass `{ reviewedReceiptJson, approvedReceiptSha256 }` to the audit. Only
matching reviewed source and native protection can clear the review blocker;
unknown rules, unsupported free-member semantics and incomplete mappings remain
blocked. The original plugin records stay intact. No importer or automatic
session/credential transfer is provided.

The Site bootstrap accepts an absolute receipt-file path and its exact file hash
through `PAID_ACCESS_MIGRATION_RECEIPT` and
`PAID_ACCESS_MIGRATION_RECEIPT_SHA256`. Both are trusted deployment inputs; do not
copy them from plugin options. Legacy access drift or changed inherited native
rules requires a new review. Unrelated new native entries and plan display-label
edits do not invalidate that review. Resolve historical delegation mode/markers
only as part of the reviewed offline transition, never to bypass an audit.

[Stripe behavior](stripe-memberships.md) · [Policy reference](../reference/access-policies.md)

## One runtime policy after migration

Before the candidate serves content, the offline audit must prove inherited
restrictions are represented by native rules. Imported visibility and product
labels are historical evidence, never an additional runtime policy. Remove their
access mapping from page wrappers and clearly label retained editor fields as
nonfunctional historical metadata. Native rules then govern pages, core reader
APIs, feeds, and agent routes consistently. Choosing Public in Paid Access is an
intentional access change on all of those surfaces.

While the retained-source receipt is enforced at boot, changing a covered native
rule, product mapping, membership mode, Stripe account/environment, or disconnecting
Stripe requires a fresh reviewed receipt before restarting. Those edits can take
effect immediately; the receipt is a startup migration check, not a runtime lock.
A restart with drift refuses to serve. Recovery is to restore the reviewed
configuration or complete a new offline review and pin its receipt. Never clear
the source records to bypass this check.

### Retained protected metadata is a nonwaivable migration constraint

On a database with historical members/paid metadata, including retained revisions,
changing those entries to Public or Use defaults, switching Members Off,
disconnecting Stripe, or removing/relinking their imported plans is unsupported
until a separately reviewed procedure retires that metadata while preserving its
original evidence. A new receipt alone cannot approve these changes: it only
acknowledges an already valid mapping and never waives missing protection or
configuration. Until that procedure exists and is reviewed, restore the prior
reviewed configuration before restart. Editing historical fields can also block
startup; use Paid Access controls and leave these retained fields unchanged.
