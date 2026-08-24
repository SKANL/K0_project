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
| Backup | Inject crypto, storage, audit, and isolated-restore ports; encrypt exports, schema-bind snapshots, and prove RPO/RTO. |
| Privacy | Enforce regional allowlists and support consent; export/delete and retention are tenant-scoped. |

## Release checklist

- [ ] Diagnostics are ready.
- [ ] Release signature and provenance are verified.
- [ ] Capability manifest is approved.
- [ ] Backup restore drill and migration rollback pass.
- [ ] Feature flags have a documented rollback state.

## R18 encrypted-backup restore drill

1. Enable `encryptedBackupWrites` only after the storage, crypto, audit, and isolated-restore ports are configured. Missing ports fail closed with `BACKUP_PORTS_REQUIRED`.
2. Export a tenant snapshot and verify it has a schema version and ciphertext only—never plaintext records. Confirm the tenant snapshot index contains its deterministic snapshot ID.
3. Restore with an authorized operator into the isolated target. Record the idempotency key and verify one audit event; replaying that key must not apply records or append another event.
4. Reject mixed schema snapshots (`RESTORE_SCHEMA_MISMATCH`), unauthorized requests (`RESTORE_AUTH_REQUIRED`), non-isolated targets (`RESTORE_ISOLATION_REQUIRED`), and unavailable/tampered storage (`RESTORE_SNAPSHOT_UNAVAILABLE`).
5. For rollback, disable `isolatedRestore` and `encryptedBackupWrites`, delete the v2 tenant snapshots and restore-idempotency index entries, then retain the last verified manifest. Do not attempt a partial schema downgrade.
