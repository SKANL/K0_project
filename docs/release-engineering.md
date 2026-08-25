# K0 release engineering and versioning

K0 ships only through the GitHub release workflow. Stable releases are fail-closed: a protected `v*` tag, GitHub OIDC, signing credentials, notarization credentials, checksums, provenance, and a successful cross-platform build are all required.

## Versioning policy

Stable releases use [Semantic Versioning](https://semver.org/) and annotated tags in the form `vMAJOR.MINOR.PATCH`. The tag is the release version; do not create a stable release from an untagged commit. Use the smallest version change compatible with the published behavior:

| Change | Version increment |
| --- | --- |
| Incompatible public behavior | Major |
| Backward-compatible feature | Minor |
| Backward-compatible fix or documentation correction | Patch |

Canary and beta are workflow-dispatch channels for pre-release validation. The stable option is intentionally rejected for a manual dispatch; stable promotion begins only from a `v*` tag.

## Quick path

1. Merge only green `CI` results for Linux, Windows, macOS Intel, and macOS Apple Silicon.
2. Update [CHANGELOG.md](../CHANGELOG.md): move relevant entries from `Unreleased` into a `vMAJOR.MINOR.PATCH` heading.
3. Create an annotated `vMAJOR.MINOR.PATCH` tag on the reviewed `main` commit as `SKANL`.
4. Verify the tag triggers the `Release` workflow, then approve the GitHub `production` environment.
5. Verify the generated checksums, SBOM, provenance bundle, GitHub attestation, and release assets before announcing availability.

## Reproducible workflow

The workflow installs dependencies with `npm ci`, runs the repository's release-assurance tests, injects the updater public key only into a temporary release configuration, builds signed updater artifacts, produces checksums and provenance, signs provenance through GitHub OIDC, and publishes the generated assets.

Before creating a tag, reproduce the non-secret checks locally from a clean checkout:

```sh
npm ci
npm run typecheck
npm test
npm run build:product
npm run smoke:release -- --ci
```

The release workflow additionally requires protected environment approvals and maintainer-managed signing/notarization secrets; these cannot be reproduced from a contributor checkout.

## Release controls

| Area | Control |
| --- | --- |
| Signing | Tauri private key is read only from GitHub Actions secrets. |
| macOS | Signing identity and App Store Connect credentials are environment secrets; the `.p8` file exists only in `$RUNNER_TEMP`. |
| Provenance | GitHub OIDC signs each `provenance.json` through Cosign and GitHub attests the artifact set. |
| Updater | Tauri updater public key is injected from `TAURI_UPDATER_PUBLIC_KEY`; stable requires OIDC and signed-provenance metadata. |
| Rollback | Worker drains before activation, resumes after activation or rollback, and an unhealthy release rolls back to the last verified manifest. |
| Dependencies | CI runs npm and Rust audits, OSV scanning, Gitleaks, and produces an SPDX SBOM. |

## Telemetry and diagnostics

Diagnostics are opt-in. `createOptInReleaseDiagnostics` accepts only event name, release ID, and error code; tokens, passwords, secrets, and private-key-like data are rejected. Record release health, update result, rollback reason, vault availability, adapter health, and browser availability — never content or credentials.

## Smoke journeys

`npm run smoke:release -- --ci` proves artifact installation, timeout/restart behavior, signed update rollback, and deletion cleanup. Native launch, vault, live adapter, and browser checks report explicit `unsupported` states until a real host path, IPC host, credentials, or browser driver is supplied. Unsupported never means passed.

## Required GitHub configuration

Create `canary`, `beta`, and `production` environments. Restrict `production` approvals and repository administration to **SKANL**. Set `TAURI_UPDATER_PUBLIC_KEY` as a repository variable and configure signing/notarization values as environment secrets. Do not place credentials in config files, variables committed to Git, or local `.env` files.
