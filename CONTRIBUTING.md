# Contributing

Small, focused changes with a clear reproduction or use case are easiest to
review. Discuss new payment rails, membership models, or hosted-service features
in an [issue](https://github.com/masonjames/emdash-paid-access/issues) before a
large implementation. The beta's boundaries are in the [README](README.md).

## Set up

Use Node 22.18+ for source builds and the pnpm version in `package.json`.
The installed runtime package supports Node 22.12+.

```sh
pnpm install --frozen-lockfile
pnpm release:check
```

See [testing and releases](docs/guides/testing-and-releases.md) for individual
commands, artifacts, live testnet opt-in, and rebuilding from an unpacked archive.
No wallet is needed for the default suite. Use a Git checkout when preparing a
contribution; the archive also includes rebuildable source and tests.

## Make a change

- Keep TypeScript strict. Resolve an uncertain type boundary instead of masking
  it with `any`.
- Add meaningful tests for changed access-control/payment behavior, including
  denial and provider-error cases.
- Keep Node-only dependencies outside the sandbox core. Cookie/header and theme
  integration belong in the Astro companion.
- Update the relevant public guide and changelog when behavior changes.
- Preserve unrelated work and original copyright/attribution.

Use synthetic fixtures, Stripe test mode, and Base Sepolia (`eip155:84532`) with
`https://x402.org/facilitator`. Never commit keys, customer data, cookies, magic
links, or production databases. Security reports go [privately](SECURITY.md).

## Submit a pull request

Describe the problem, resulting behavior, validation performed, and any host
acceptance still needed. For an access change, show both permitted and denied
cases. For packaging, inspect the built archive and consumer imports. Do not
present mocked payment responses as real settlement evidence.

The project is GPL-2.0-or-later. Contributions use that license; preserve
[NOTICE.md](NOTICE.md) and the upstream history. A source or CI change does not
itself publish a package or deploy a site.
