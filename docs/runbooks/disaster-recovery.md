# Disaster recovery verification

Exports are tenant-only snapshots with deterministic checksums and durable backup records. Restore is accepted only for an authorized active-tenant operator when checksum, tenant isolation, RPO, and RTO all pass. Tenant deletion and retention eviction both mark associated backup records deleted and block later restores; a snapshot must still be retained at restore time.

## Quick path

1. Export the tenant dataset; retain only the configured number of snapshots.
2. Restore into an isolated recovery target using a safe fake or non-production store.
3. Record measured RPO (`snapshot - latest write`) and RTO (`completion - start`).

## Acceptance checklist

- [ ] Snapshot checksum matches the canonical tenant-only records.
- [ ] No record belongs to a different tenant.
- [ ] RPO is within the configured target.
- [ ] RTO is within the configured target.
- [ ] Retention/deletion policy has removed expired snapshots.

## Failure path

On any verification failure, stop restore promotion, keep the original dataset immutable, and open an incident. Never overwrite production data from an unverified export.
