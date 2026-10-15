# Reviewed customer identities

Paid Access can retain an authoritative Stripe customer association created by a
reviewed offline migration. This does not import data, execute another plugin,
copy old sessions, or establish that a migration has been verified against Stripe.
The importer must independently verify the intended native credential's account
and environment and reject ambiguous member/customer mappings before writing a
binding. Synthetic tests do not replace that provider verification.

A migrated `customers` record retains its normalized `email`, exact
`stripeCustomerId`, and timestamps, plus:

```ts
migrationBinding: {
  version: 1;
  accountId: string;
  environment: "test" | "live";
  sourceSha256: string;
  credentialSha256: string;
}
```

Both digests are lowercase SHA-256 hexadecimal. `sourceSha256` identifies the
reviewed migration source according to the importer's versioned audit contract;
it is provenance, not a runtime signature. `credentialSha256` hashes the exact
UTF-8 native plaintext Stripe secret key independently verified by that importer.
Never put the key itself in the record or a report. Normalize historical
`sandbox` to `test` before writing a binding. A malformed or null binding is an
error, never permission to resume ordinary email lookup.

The importer must atomically retain a second identity record in
`ctx.kv["migration:customer-bindings:v1"]`:

```ts
{
  version: 1,
  members: {
    [normalizedEmail]: {
      stripeCustomerId,
      migrationBinding,
      // Optional: only for an explicitly reviewed blocked historical identity.
      blocked: true,
    },
  },
}
```

The complete JSON value is limited to 100,000 UTF-8 bytes. Member emails must be
normalized and customer IDs unique. Unknown envelope/member/binding fields are
refused. Runtime requires a matching registry entry and customer record: deleting
a customer row, stripping its binding, or deleting the registry while bound rows
remain fails closed, with no automatic association repair. Unrelated new native
customers can remain outside the registry. No runtime route writes this registry.

An explicitly reviewed historical identity can be retained with `blocked: true`
when its Stripe customer is deleted or otherwise ineligible for migration. Keep
the exact customer row and binding as historical identity metadata; they do not
grant access. The registry flag denies that email before provider requests or
association writes and cannot be cleared by email search, checkout, or a provider
customer reappearing. Checkout completion still needs its single read-only
session discovery GET. `blocked: false`, null, and other values are invalid;
normal eligible identities omit the property. Valid blocked entries do not
disable other eligible members. Include this disposition in the reviewed registry
hash; only a separately approved offline rebind may change it.

For the native Site plugin, core `createKVAccess` stores this value as JSON in
`options.name = plugin:paid-access:migration:customer-bindings:v1`. Sandboxed
workerd/Cloudflare plugins use `_plugin_storage` collection `__kv` instead; this
is a distinct import target. Use the host's actual KV API or verified execution
mode, and bind the registry bytes into the independently reviewed migration
receipt. The receipt must remain pinned outside mutable plugin data. Removing
**all** migration evidence from the database is outside the runtime database
trust boundary and must be rejected by that external preflight audit.

For a bound identity, access, member segments, checkout, and the customer portal
compare the current native account/environment and credential fingerprint before
requesting the exact customer. That object must have the exact ID, matching
normalized email, matching `livemode`, and no deletion flag. Access then uses only
that customer's products. Missing, canceled, mismatched, or unavailable customers
do not trigger email fallback. Runtime routes cannot create, replace, or remove
the binding. Key rotation, account changes, environment changes, or customer email
changes require a separately reviewed rebind; there is no automatic repair.

Checkout completion starts with an opaque Stripe checkout-session ID. One
read-only session GET is necessary to discover its email/customer association.
After discovery, a bound identity must pass the same checks before customer
requests, association writes, or the normal sign-in email. A changed or missing
customer ID cannot overwrite the binding. Completion never directly creates a
member session.

The upgraded plugin manifest declares a `customers.stripeCustomerId` index.
EmDash must synchronize the new manifest's storage indexes before enabling this
runtime. Existing JSON records need no rewrite: the expression index covers
existing rows. Indexed reverse checks prevent a migrated customer ID from being
rebound under another email, including ordinary email-search and checkout
completion paths. An unavailable index, incomplete result, or conflicting binding
fails closed; there is no full-table fallback scan. Keep the prior image and data
available until this schema/runtime prerequisite is qualified on the migration
copy. Ordinary customers without a migrated association retain their existing
email-based behavior.

Local tests exercise mocked Stripe responses and the actual EmDash storage
bridge, including a retained-key email lookup, indexed reverse-ID query, registry checks, and restart. They do not prove
live-provider customer ownership, migrated production access, or deployment
readiness.

[Migration procedure](migration.md)
