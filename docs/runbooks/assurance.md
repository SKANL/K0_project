# Assurance setup and release checks

This runtime fails closed when protected storage, signed release verification, or required platform capabilities are unavailable. It never substitutes local memory for a production vault.

## Quick path

1. Install Node, Rust, and the platform-approved vault integration.
2. Run `npm test`, `npm run typecheck`, `npm run build`, `npx convex codegen`, then the locked Cargo checks.
3. Enable a feature only after diagnostics report ready and the signed provenance manifest verifies.

## Operational controls

| Control | Required behavior |
|---|---|
| Vault | Inject an OS-protected or approved vault port; unsupported platforms return `VAULT_UNSUPPORTED`. |
| Release | Verify signature, provenance, and non-empty capability manifest before activation; rollback only to a previously verified release. |
| Migration | Expand behind a flag, verify, then contract; failed staged versions roll back before exposure. |
| Backup | Encrypt exports, restore only to an isolated target, and prove RPO/RTO. |
| Privacy | Enforce regional allowlists and support consent; export/delete and retention are tenant-scoped. |

## Release checklist

- [ ] Diagnostics are ready.
- [ ] Release signature and provenance are verified.
- [ ] Capability manifest is approved.
- [ ] Backup restore drill and migration rollback pass.
- [ ] Feature flags have a documented rollback state.
