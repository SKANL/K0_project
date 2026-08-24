# Operational health and SLO controls

Readiness is tenant-isolated and fail-closed. Database or backup failures make the service not ready; provider failures permit only degraded work. Error-budget exhaustion moves operations to read-only mode. Only operator roles can write health; viewers can inspect readiness without modifying it.

## Quick path

1. Record component health with a concise non-sensitive detail.
2. Read readiness before accepting nonessential work.
3. When degraded, preserve durable ledgers and retry only idempotent operations.

## Audit rules

Audit metadata redacts authorization, token, password, secret, and credential keys **and matching values** such as bearer credentials and `sk_live_*` tokens. Do not put request bodies or provider payloads in health details.

## Quality gates

Replay evaluations compare expected versus actual outcome without naming a provider or model. An empty or invalid replay set fails closed; a release gate requires the configured pass rate. Investigate any mismatch before enabling writes.
