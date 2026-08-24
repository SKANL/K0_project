# K0 release engineering

K0 ships only through the GitHub release workflow. Stable releases are fail-closed: a protected `v*` tag, GitHub OIDC, signing credentials, notarization credentials, checksums, provenance, and a successful cross-platform build are all required.

## Quick path

1. Merge only green `CI` results for Linux, Windows, macOS Intel, and macOS Apple Silicon.
2. Create an annotated `v<semver>` tag on `main` as `SKANL`.
3. Approve the GitHub `production` environment and verify the generated checksums, SBOM, provenance bundle, and release assets.

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
