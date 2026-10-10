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
| `artifacts/emdash-paid-access-0.1.0-beta.2.tgz` | npm-format package for a consumer site |
| `artifacts/emdash-paid-access-0.1.0-beta.2.tgz.sha256` | Digest of that exact npm archive |
| `artifacts/paid-access-0.1.0-beta.2.tar.gz` | Sandbox-format package from the same version |

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
source is public, `0.1.0-beta.2` is the current npm beta, and the EmDash
registry remains unpublished. A Node site can use the npm core descriptor and
companion without waiting for registry publication.

### Prepare the npm beta

1. Finish and record the relevant host acceptance checks above. Update the
   changelog and release evidence to describe observed results and beta limits.
2. Finalize the source revision and run `pnpm release:check`. Review the packed
   contents, preserve the archive's checksum, and test that exact artifact in a
   fresh consumer. Keep `0.1.0-beta.2` consistent across source and artifacts.
3. Authenticate the intended npm account with `pnpm login --registry
   https://registry.npmjs.org`, then confirm it with `pnpm whoami --registry
   https://registry.npmjs.org`. Keep credentials outside the repository.
4. After acceptance, publish the reviewed archive with the `beta` dist-tag:

```sh
pnpm publish ./artifacts/emdash-paid-access-0.1.0-beta.2.tgz \
  --registry https://registry.npmjs.org \
  --tag beta --access public --publish-wait-timeout 600000
```

Run the release gate before publishing a prebuilt tarball; do not rely on the
archive running the source checkout's `prepublishOnly` script. Direct npm
publication requires account 2FA or an appropriately authorized granular token.
Use trusted publishing and provenance when releasing through supported CI.
See [npm authentication requirements](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)
and [pnpm publishing options](https://pnpm.io/cli/publish).

After upload, confirm the exact version and `beta` tag, verify the downloaded
archive against the reviewed artifact, and install/build it in a clean consumer.
The availability wait checks registry metadata and the tarball response; it
does not verify package contents. If it times out after the upload was accepted,
check the registry before retrying. Do not reuse a published version for changed
bytes. Publish the matching source tag and update availability statements only
when the package can actually be installed.

### EmDash registry follows separately

This npm release does not publish or approve an EmDash registry listing. Before
offering that installation path, verify a real sandbox core with the matching
npm companion on the intended host. Publish the sandbox archive through the
EmDash CLI, then verify approval, public discovery, and a fresh installation.
The registry core alone does not enforce paid content. Keep the listing explicit
about the required companion and theme integration.

The standard core remains GPL-2.0-or-later; make corresponding source available
with a release. See [LICENSE](../../LICENSE) and [NOTICE](../../NOTICE.md).
