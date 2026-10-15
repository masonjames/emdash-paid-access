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
V1 preparation and approval are available only for sites without legacy customers.
Member migration requires a reviewed v2 receipt plus a valid pinned account
attestation through the API described below.
Preparation still reports migration pending; it is not approval. Review the
candidate and pin the exact UTF-8 JSON bytes outside plugin settings. The caller
may pass `{ reviewedReceiptJson, approvedReceiptSha256 }` to the audit. Only
matching reviewed source and native protection can clear the review blocker;
unknown rules, unsupported free-member semantics and incomplete mappings remain
blocked. The original plugin records stay intact. No importer or automatic
session/credential transfer is provided.

The Site bootstrap accepts absolute evidence-file paths and their exact file hashes
through these complete environment input pairs:

- Receipt: `PAID_ACCESS_MIGRATION_RECEIPT` / `PAID_ACCESS_MIGRATION_RECEIPT_SHA256`.
- Account attestation: `PAID_ACCESS_ACCOUNT_ATTESTATION` / `PAID_ACCESS_ACCOUNT_ATTESTATION_SHA256`.

The attestation pair cannot be used without the receipt pair. These are trusted
deployment inputs; do not copy them from plugin options. This wiring does not
establish deployed or provider readiness. Legacy access drift or changed inherited native
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
original evidence. Only explicit `public` visibility treats empty plain-object
`ghost_product_slugs` (`{}` or its JSON text) as no labels, for current rows and
retained revisions. Database bytes stay intact; explicit rules still apply.
Other object forms or visibilities remain blocked. A new receipt alone cannot approve these changes: it only
acknowledges an already valid mapping and never waives missing protection or
configuration. Until that procedure exists and is reviewed, restore the prior
reviewed configuration before restart. Editing historical fields can also block
startup; use Paid Access controls and leave these retained fields unchanged.

## Narrow attestation for a missing or exactly matching historical account

An externally reviewed account attestation supports either **no** historical
`stripe_account_id` row or exactly one present row whose decoded value satisfies
the account ID shape below and strictly equals the attestation's `accountId`.
Present empty, null, malformed or different values and duplicate rows refuse this
path; attestation cannot override them. Neither the reader nor the audit writes
or changes the original settings. The source descriptor hashes the exact existing
account row, so adding, removing, clearing or changing it requires fresh source
binding and review of valid evidence; repinning attestation alone is insufficient.
Native account/environment must match the attestation, and the legacy environment
must also match (absent environment means live; test and sandbox normalize to
test). This does not waive any rule, current/revision metadata, taxonomy OR-grant,
unknown-setting or other migration blocker.

The audit API accepts these two complete option pairs (preparation uses only the
attestation pair):

```js
const accountOptions = {
  reviewedAccountAttestationJson,    // Exact reviewed UTF-8 JSON text
  approvedAccountAttestationSha256,  // Independently pinned lower-case SHA-256
};
const snapshot = readLegacyMigrationSnapshot(db, { includeIdentityBinding: true });
const candidate = createMigrationReviewCandidate(snapshot, accountOptions);
// Candidate preparation still leaves legacy_migration_review_required.
// After separate review and pinning of the candidate's exact JSON bytes:
const report = auditLegacyDatabase(db, {
  ...accountOptions,
  reviewedReceiptJson,
  approvedReceiptSha256,
});
```

Unknown options and partial pairs are refused. Preparation accepts the attestation
pair only, never an approval receipt. An attestation alone can resolve a missing
account comparison or validate an exactly matching historical account, but cannot
clear `legacy_migration_review_required`. The v2
receipt includes the exact attestation byte digest and the identity descriptor
below, alongside all existing review hashes/counts. Both inputs must remain pinned
and supplied on subsequent audits. Any retained legacy customer requires valid
attestation and v2 review, including when the historical account is present and
matches. Missing native rows, bindings or registry cannot fall back to v1.
V1 receipt bytes and behavior remain unchanged for sites without legacy customers;
v1 cannot resolve a missing historical account. This scope adds no broader account
override, delegation or CLI attestation flags. The Site bootstrap supplies both
pinned pairs through the environment inputs described above; provider qualification
and deployment verification remain separate.

The attestation is a closed object with exactly these fields:

```js
{
  kind: 'paid-access-legacy-account-attestation',
  version: 1,
  observedAt,                           // Positive safe integer, epoch seconds
  accountId,                            // /^(?:acct_[A-Za-z0-9]{1,255}|[A-Za-z0-9]{32})$/
  environment,                          // 'live' or 'test'
  sourceSha256,
  coverageSha256,
  customerCount,
  productCount,
  nativeCredentialRepresentationSha256,
  credentialSha256,
}
```

Every hash is 64 lower-case hexadecimal characters; counts are integers from zero
to 100,000, and `customerCount + productCount` must exceed zero: no inherited
customer or product reference means this narrow mode cannot establish ownership.
JSON evidence text is bounded to 16 million characters. The reviewed
collector must independently qualify the account/environment, covered products
and customer associations, and the plaintext credential fingerprint. This audit
makes no network requests, never performs an email-only provider lookup, and
never decrypts a stored credential. A pinned digest proves which reviewed bytes
were supplied; it does **not** independently establish Stripe/provider
authenticity. Collector trust, provider verification and observation freshness
are separate collector/application qualification duties. Later boot does not
expire previously pinned evidence based on `observedAt`.

### Exact identity binding and privacy

Default `readLegacyMigrationSnapshot(db)` retains its original redaction: it does
not select customer IDs/data or secret values. Before native setup, call the
SELECT-only `readLegacyMigrationIdentitySource(db)`. It uses that default snapshot
and selects private values only from legacy customer rows and the historical
settings listed below, never native credentials, customer records or the native
customer registry. It requires
no native settings or bindings and returns exactly:

```js
{ sourceSha256, coverageSha256, customerCount, productCount, customerAssociationsSha256 }
```

Use this source hash in the separately prepared native `migrationBinding` records.
Source capture does not approve migration. Final qualification requires
`readLegacyMigrationIdentityBinding(db, snapshot?)`, or
`readLegacyMigrationSnapshot(db, { includeIdentityBinding: true })`, which adds
that descriptor as `snapshot.identityBinding`.
Supplying `snapshot` to `readLegacyMigrationIdentityBinding` requires the caller to ensure it and the private-stage reads belong to the same coherent snapshot; prefer omitting the argument otherwise.
The full reader additionally reads
the native credential representation, customer rows and the exact registry option
described below; missing inherited native associations/bindings or registry evidence
block the final audit. Native edits do not change the
source descriptor. Both paths check SQLite `data_version` around the complete
capture. `auditLegacyDatabase` invokes the full private reader only when an
attestation option is requested. Raw private fields stay in memory; failures use
sanitized errors. No session or authentication values are selected, hashed or copied.

The exact full descriptor shape is:

```js
{
  sourceSha256, coverageSha256, customerCount, productCount,
  customerAssociationsSha256, nativeCustomerAssociationsSha256,
  nativeMigrationBindingsSha256, expectedNativeMigrationBindingsSha256,
  nativeCustomerRegistryBindingsSha256, nativeCustomerRegistrySha256,
  nativeCredentialRepresentationSha256,
  credentialSha256, // Common inherited native binding fingerprint; null if no inherited customers
}
```

For reproducible collector hashes, `H(value)` is SHA-256 of UTF-8 canonical JSON:
object keys sort lexicographically, arrays retain order, and JSON string escaping
is preserved. New identity row arrays below, including flattened registry pairs,
sort by canonical JSON text using JavaScript `<` / `>` (deterministic UTF-16
code-unit order, independent of process locale). Attested v2 review source, native
and metadata hashes use this same array ordering. Unattested v1 reviews retain
their existing `localeCompare` ordering for receipt compatibility. Unique string
arrays and object keys retain their existing deterministic default `.sort()`.
Raw SQLite TEXT values are embedded as strings without decoding,
trimming or reserializing them. Therefore whitespace changes in a stored legacy
customer or relevant setting change the source hash.

- `sourceSha256 = H({ customers, settings })`: customers are exact legacy
  `{ id, data }` rows; settings are exact legacy `{ name, value }` rows for
  `plan_mappings`, `show_excerpts`, `stripe_environment`, `stripe_account_id`,
  `stripe_secret_key`, `stripe_publishable_key` and the recognized credential aliases
  `stripeSecretKey`/`stripePublishableKey`, using their full
  `plugin:restrict-with-stripe:` names. This includes stored encrypted/raw
  credential representations, with absent settings omitted.
- `coverageSha256 = H({ products, customers })`: products are the sorted unique
  exact legacy IDs from plan mappings and explicit rule `productIds`; customers
  are sorted `[normalizedEmail, stripeCustomerId]` associations.
- The association hashes are `H(associations)` for legacy rows and matching native
  rows respectively. Only inherited emails participate in native digests, so
  unrelated ordinary native customers do not invalidate a receipt.
- Binding hashes are `H(sortedPairs)`, with each pair
  `[[normalizedEmail, stripeCustomerId], migrationBinding]`. The native hash uses
  the stored binding. The expected hash uses original legacy associations and
  `{ version: 1, accountId: nativeAccount, environment: normalizedNativeEnvironment,
  sourceSha256, credentialSha256 }`. The reader takes a common fingerprint from
  the inherited native bindings, and validation requires it to equal the pinned
  attestation's `credentialSha256` before accepting the expected hash. It never
  computes a plaintext fingerprint. The unchanged runtime binding schema defines
  `credentialSha256` as SHA-256 of the exact UTF-8 plaintext native key, **without**
  JSON quoting or canonicalization. With zero inherited customers both binding
  arrays are empty and the descriptor fingerprint is null; the attestation still
  pins the native credential representation.
- `nativeCustomerRegistryBindingsSha256 = H(sortedCorePairs)` uses the same
  flattened binding pair shape, extracted independently from the actual registry's
  members with the optional `blocked` flag projected out. This required
  descriptor field must equal **both** `nativeMigrationBindingsSha256` and
  `expectedNativeMigrationBindingsSha256`, including in pure snapshot validation.
- `nativeCustomerRegistrySha256 = H(sortedRegistryPairs)` also pins disposition.
  An eligible member's pair remains
  `[[normalizedEmail, stripeCustomerId], migrationBinding]`; a blocked member's pair
  appends `{ blocked: true }` as its third element. It differs from the core binding
  hash when any member is blocked. V2 receipts embed and independently pin both
  required hashes; pure descriptor validation checks core binding parity and the
  receipt pins the actual registry hash separately. Missing hashes refuse. The
  source hash never includes this registry, avoiding a circular import.
- `nativeCredentialRepresentationSha256 = H(rawNativeStripeSecretKeyValue)` binds
  the exact stored `plugin:paid-access:settings:stripeSecretKey` representation,
  including envelope/whitespace bytes. This differs from the collector's
  plaintext-key fingerprint.

All legacy customer rows and inherited, aliased or bound native rows are strictly
validated. A native row is in scope when its normalized email or lookup key is an
inherited email, its customer ID is inherited, or it has its own `migrationBinding`
property (including `null`). Unrelated ordinary native JSON objects are bounded
and parsed but are not held to the migration's historical schema: older records
without `updatedAt`, non-email lookup keys and shared non-inherited customer IDs
do not invalidate a pinned receipt.

Supported in-scope customer JSON has exactly `email`, `stripeCustomerId`, `createdAt` and
`updatedAt`, with optional `migrationBinding` on native rows only. Timestamps must
be UTC ISO strings with seconds and optional three-digit milliseconds. Customer
IDs must match `/^cus_[A-Za-z0-9]{1,255}$/`. Emails normalize with trim/lowercase;
the row ID must equal that normalized email for legacy and in-scope native rows.
This historical ID assumption is explicitly exercised with synthetic SQLite
fixtures; other historical lookup forms are refused, never inferred. Duplicate
normalized emails, duplicate customer IDs within the validated cohort, malformed/unknown fields, missing
native matches and ambiguous inherited matches fail closed. Each inherited
native row needs the exact binding shape above. A different email reusing an
inherited customer ID fails even with an unusual lookup key or missing timestamp.
Any native row with its own `migrationBinding` must have an inherited normalized
email; even a valid-shaped binding on a non-inherited email is refused.
Identifiers use explicit defensive exact-value validation, and digests must be
exactly 64 lower-case hexadecimal characters; trailing line endings are refused.
The private reader bounds each selected string to one million characters and all
selected private text together to 16 million UTF-8 bytes.

### Closed native customer registry

This SQLite projection applies to the Site's native runtime. Sandbox bridges use
different KV storage; this audit does not qualify sandbox migrations.

The importer must atomically write inherited native customer rows and one object
at the native KV key `migration:customer-bindings:v1`. Native core stores this as exactly
one `options` row named `plugin:paid-access:migration:customer-bindings:v1`, with
this JSON value:

```js
{
  version: 1,
  members: {
    [normalizedEmail]: {
      stripeCustomerId,
      migrationBinding: {
        version: 1, accountId, environment, sourceSha256, credentialSha256,
      },
      // Optional own field, only for a separately reviewed blocked identity:
      blocked: true,
    },
  },
}
```

The envelope, each member and each binding are closed objects with only the shown
own fields. A member may omit `blocked` or have its own `blocked: true` only;
present `false`, `null`, strings, numbers or `undefined` refuse. The native customer
row and its `migrationBinding` retain their existing closed schemas; neither gains
a `blocked` field. The binding uses the same account, `live`/`test` environment and hash
constraints as the native row. Keys must be unique normalized emails, customer IDs
must be unique, and the serialized object must be at most **100,000 UTF-8 bytes**.
Duplicate JSON keys or options rows, unknown fields, malformed values and oversized
JSON are refused. Storage under `_plugin_storage.__kv` does not satisfy this guard.

Only the full-native stage SELECTs that exact option name. Its members must equal
the inherited legacy normalized-email set exactly. For every member, the reader
requires exact `{ stripeCustomerId, migrationBinding }` parity with the native row
and independently expected original association/binding. A valid empty registry
is required even with zero inherited customers when products attest the account.
Unrelated future native customers remain outside this registry. The default
redacted reader excludes the option entirely; preimport source capture works
before the registry exists and ignores subsequent registry changes.

A deleted provider customer ID may be retained as an explicitly reviewed
**blocked historical identity**, never as a verified live customer. Preserve the
original record, native customer row and exact binding; blocking grants no
entitlement and permits no email fallback. The full reader supports mixed eligible
and blocked members as well as an entirely blocked inherited cohort. An absent
flag means eligible for runtime evaluation; it does not guarantee entitlement.

The existing reviewed v2 receipt pins each member's disposition. Removing,
changing or adding a flag invalidates that receipt. Re-enabling requires separately
reviewed provider evidence and disposition plus a new receipt; it is never
automatic. A pinned hash alone is not provider truth. This source-only audit
performs no provider verification, and its synthetic tests prove no runtime
entitlement behavior. The account attestation fields are unchanged.

The coordinated native runtime guard uses the retained registry to recognize an
inherited member after their customer row or migration binding is lost or stripped,
so that loss cannot silently become an ordinary new-customer path. The externally
pinned boot receipt detects removal of all migration evidence, including the
registry. These checks provide no guarantee against arbitrary database writes or
control by a trusted administrator. This audit qualifies the stored contract;
runtime enforcement is implemented and reviewed separately by the runtime owner.

Reports contain only counts and sanitized blocker categories. Receipts contain
hashes/counts and format discriminators, never raw accounts, environments,
customer emails or resource IDs. Native credential representation changes,
customer-ID swaps at the same count, association drift and binding/fingerprint
drift invalidate the v2 boot audit. Preserve all original legacy records and
re-review drift; no credential/session copying or migration writes occur here.
