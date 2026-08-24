# Runtime and RDD contract

## Authority boundary

Models may propose tool input and narrative only. The typed tool contract validates input and output, policy, preconditions, and postconditions. Persisted state machines enforce expected versions and legal transitions. Effects require both an idempotency key and the current fence.

## Replay and receipt evidence

Context snapshots are immutable and ordered by descending priority followed by source ID. Canonical envelopes sort object keys. A replay compares canonical domain state, never model prose. Delivery requires an RDD receipt whose `reviewedBytes` exactly match the canonical candidate bytes and includes non-empty transitions, evidence, and lineage.

## Migration and rollback

Use the `expand` runtime migration: backfill deterministic snapshots and receipt bytes, verify replay fixtures, then enable runtime writes. To roll back, disable runtime writes while retaining immutable RDD receipts and pre-existing command/outbox records for audit and recovery.
