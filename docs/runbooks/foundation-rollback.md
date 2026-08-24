# Foundation rollback runbook

## Scope
This runbook covers PR1 tenancy, command/inbox/outbox, audit, and Tauri capability contracts.

## Canary and rollback
1. Enable writes only for the seeded canary workspace.
2. Confirm denied cross-tenant commands create an audit record and no outbox record.
3. On a failed canary, disable foundation writes, wait for leased outbox records to finish or expire, and retain immutable audit events.
4. Revert the additive schema consumers only after the outbox is drained; do not delete audit history.

## Verification
Run `npm run test:foundation` and `npm run typecheck`. The capability is restricted to `main` and `$APPDATA`; no shell execution permission is granted.
