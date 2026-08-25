# Integration reference ports

This repository provides deterministic, in-memory reference ports for beat scheduling and external automation. They are test seams, not live integrations.

## Quick path

1. Create a provider adapter for `composio`, `convex`, or `sendblue`.
2. Schedule work with a stable idempotency key.
3. Invoke `beat({ now })` from a host scheduler and retain the returned audit receipts.

## Semantics

| Concern | Contract |
| --- | --- |
| State machine | `scheduled` → `running` → `completed` or `failed`; cancellation is terminal. |
| Idempotency | A repeated key returns the original job and never executes twice. |
| Cancellation | A cancelled job is skipped by all later beats. |
| Audit | Scheduling, completion, failure, and cancellation generate deterministic receipts. |
| Apple | Notes and Shortcuts are capability-gated; iMessage automation is always unavailable and falls back to manual sharing. |

## Production extension points

Implement `AutomationProviderPort` in a host-owned adapter for the real Composio, Convex, or Sendblue client. Keep credentials, retries, transport, and vendor SDKs outside this reference module. Preserve the idempotency key and map provider results into receipts; do not present the in-memory adapters as live connectivity.
