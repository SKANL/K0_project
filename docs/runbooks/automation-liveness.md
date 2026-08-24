# Automation and liveness runbook

## Rollout and migration

Deploy the additive schema first with `automationWrites=false` and `automationWorkers=false`. Backfill schedules and inspect duplicate keys, then enable writes, run a canary workspace, and finally enable workers. The UTC cron invokes only the internal durable beat; schedules persist their timezone/DST choice before a run is planned.

## Recovery and rollback

Heartbeat leases are renewable liveness signals and carry fences. A beat is a separate idempotent schedule/recovery tick. On a worker crash, wait for expiry, recover only with a higher fence, and move repeated failures to `manual_review` with diagnostics. To roll back, disable workers, stop new claims, let leases expire, reconcile beat/run ledgers, then disable writes. Do not delete automation history; it is required for recovery and audit.

Claims recheck the workspace policy at execution time. Runs that pass their deadline are moved to `manual_review` and alert instead of remaining claimable. Repeatedly expired worker leases are quarantined after the configured recovery threshold and emit `LEASE_POISON_QUARANTINED`; an operator must inspect diagnostics before restoring that worker key.
