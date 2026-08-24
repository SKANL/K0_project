# K0 complete-platform apply progress

**Status:** closure implementation complete; final SDD/RDD receipt validation remains a delivery gate.

## Canonical task state

- **32/32** task records are complete in `k0-complete-platform-tasks.json`.
- **K0-01 through K0-28:** `retrospective-current-contract`. Historical RED output is explicitly unavailable; each record names its current executable test path.
- **K0-29:** observed R3 RED failure: missing native-vault Rust symbols; GREEN in `8192b32` with 5 locked Cargo tests passing.
- **K0-30:** observed R15 RED failures: missing production adapter module and an unhandled offline provider; GREEN in `8192b32` with 3 adapter tests passing.
- **K0-31/K0-32:** current regression and canonical-evidence contracts.

## Work-unit evidence

| Evidence | Command | Result |
|---|---|---|
| R3 RED | `cargo test --locked --manifest-path apps/product/src-tauri/Cargo.toml` | Exit 1: unresolved `vault_*` imports and command variant before implementation. |
| R3 GREEN | Same command | Exit 0: 5 Rust tests passed. |
| R15 RED | `npx vitest run tests/adapters/production.test.ts` | Exit 1: module absent; later exit 1 for unhandled offline provider. |
| R15 GREEN | Same command | Exit 0: 3 adapter tests passed. |
| Evidence contract | `npx vitest run tests/foundation/closure-evidence.test.ts` | Exit 0: validates 32 entries, unique task IDs, hashes, paths, and retrospective labels. |
| Rollback | `git revert 8192b32` | Reverts native-vault and executable-adapter implementation as one work unit. |

## Safety net

Run `npm test`, `npm run typecheck`, `npm run build`, `npx convex codegen`, `cargo fmt --check --manifest-path apps/product/src-tauri/Cargo.toml`, `cargo test --locked --manifest-path apps/product/src-tauri/Cargo.toml`, and `cargo check --locked --manifest-path apps/product/src-tauri/Cargo.toml` before delivery. Quality-gate negative and positive cases remain required.

## Evidence integrity

The JSON artifact stores a SHA-256 evidence hash for every task. `closure-evidence.test.ts` recomputes it from a canonical key-sorted record and rejects missing or misleading retrospective labeling.
