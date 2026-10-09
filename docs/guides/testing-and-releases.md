# Testing and releases

[Documentation](../README.md) / Testing and releases

Use Node 22.18+ for source builds, the checked-in lockfile, and the package
manager declared in `package.json`. The installed runtime supports Node 22.12+.
Build and verification commands do not publish, deploy, send membership emails,
or start a demo site.

## Local checks

```sh
pnpm install --frozen-lockfile
pnpm release:check
```

| Command | What it checks |
| --- | --- |
| `pnpm peers check` | Dependency peer compatibility |
| `pnpm typecheck` | TypeScript source; `.astro` rendering is exercised separately |
| `pnpm build` | Standard core/descriptor and the Astro companion |
| `pnpm test` | Unit and component/route behavior; live settlement is skipped by default |
| `pnpm test:sandbox` | Core behavior through the EmDash plugin test harness |
| `pnpm validate` | Manifest shape and declared capabilities |
| `pnpm bundle` | Size-limited sandbox archive |
| `pnpm release:check` | All of the above plus packed artifact/export/source checks |

The aggregate gate writes:

| Artifact | Purpose |
| --- | --- |
| `artifacts/emdash-paid-access-0.1.0-beta.1.tgz` | npm-format package for a consumer site |
| `artifacts/emdash-paid-access-0.1.0-beta.1.tgz.sha256` | Digest of that exact npm archive |
| `artifacts/paid-access-0.1.0-beta.1.tar.gz` | Sandbox-format package from the same version |

The package checker verifies exported files, consumer resolution of the companion
and x402 middleware, matching core bytes across formats, and preserved source
metadata. It rejects private/generated material covered by its file rules.
Review package contents as well; a file-name guard is not a secret scanner.

CI runs the release gate and uploads local artifacts. It does not publish them.
`prepack` rebuilds before packing, and `prepublishOnly` runs the release gate.

## Dependency compatibility

The workspace pins two TipTap extensions to the 3.26.0 core/pm used by EmDash
1.2. It uses tsdown 0.22.0, which supports both the project's TypeScript 5 and
plugin-cli's TypeScript 6 dependency. A checked-in pnpm patch updates plugin-cli
0.13.3's deprecated bundling option names to the equivalent `deps` API. The patch
changes build configuration only; it is included in the corresponding source.
Remove these accommodations when an upstream release provides matching peers
and the same supported build options, then rerun the full gate.

Installation still reports nine deprecated transitive dependencies in EmDash's
authentication and libSQL/node-fetch dependencies. They cannot safely be replaced
by changing Paid Access's versions alone. The release gate checks peer compatibility;
it does not suppress deprecation notices or claim an upstream migration is complete.

## Live payment testing

The automated settlement test requires all three environment values:

| Variable | Meaning |
| --- | --- |
| `PAID_ACCESS_LIVE_TEST=1` | Explicitly enable the real testnet settlement test |
| `PHB_TEST_PAY_TO` | Test seller's public payout address |
| `PHB_TEST_PRIVATE_KEY` | Funded test buyer's private key, loaded privately |

With the wallet values already set securely in the process environment:

```sh
PAID_ACCESS_LIVE_TEST=1 pnpm exec vitest run tests/x402-live.test.ts
```

This test spends Base Sepolia test USDC through the default facilitator; it is
not mainnet acceptance. Its fixture uses an in-process route and receipt spy,
so it does not prove the deployed site's storage or proxy. For a test purchase
against a real host, see the [paid-read helper](x402-payments.md#request-flow).
Never print or commit the key.

## What still needs host acceptance

Test the built artifact in a fresh EmDash site, then in the intended host stack:

- Agent-only installation and a real testnet purchase with a persisted receipt.
- Stripe test Checkout, email delivery, sign-in, portal, and changing entitlements.
- Editor permission behavior and actual saved rules.
- Invalid payment/access-service failures, with no protected body returned.
- [Paid-then-unpaid cache isolation](hosting-and-caching.md) through the public host.
- Legacy delegation, if used; registry core plus companion, if that mode is used.

Record version, source commit, artifact hash, host/runtime versions, expected
outcomes, and observed results. Mocked responses, a successful build, and a
sandbox harness run are useful evidence for different layers; none substitutes
for those host checks.

## Rebuild from an npm archive

The package includes source, tests, build configuration, and exact copies of
the original package manifest and lockfile. pnpm changes/omits these at the
archive root, so restore the preserved copies before installing:

```sh
cp dist/source/manifest.json package.json
cp dist/source/lock.yaml pnpm-lock.yaml
pnpm install --frozen-lockfile
pnpm release:check
```

An archive contains editable source and rebuildable tests, but does not carry
the original Git history; use a Git checkout when preparing a contribution.

## Release channels

Public source, npm, and the EmDash registry are separate delivery steps. The
current beta has public source; npm and registry publication are pending.
Use one source version for both artifacts, keep the first npm release on the
`beta` dist-tag, and publish the matching source tag with the binary artifacts.

Before a release, update the changelog and availability statements, verify the
package/source contents and matching versions, and finish the relevant host
acceptance checks. After publication, prove an external consumer can install it
and that the registry actually approves and discovers it. A successful upload
alone is not directory visibility. Keep credentials outside source and use
provenance/trusted publishing when the chosen release workflow supports it.

The standard core remains GPL-2.0-or-later; make corresponding source available
with a release. See [LICENSE](../../LICENSE) and [NOTICE](../../NOTICE.md).
