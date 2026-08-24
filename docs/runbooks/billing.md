# Safe billing operations

Commercial usage is admitted only through the tenant-scoped Convex entitlement and immutable usage ledger. Every provider effect first obtains a durable `billingReceipts` claim with an idempotency key and fence; service instances hold no receipt or idempotency authority, payment audit records redact provider references. Payment providers are adapter ports: no provider credentials, payloads, or live charges are stored here.

## Quick path

1. Set an active entitlement with an integer usage limit.
2. Record usage using a stable tenant-scoped idempotency key.
3. If a provider response is uncertain, reconcile the same receipt and fence; never submit another charge.

## Operator checks

| Signal | Action |
|---|---|
| `ENTITLEMENT_EXHAUSTED` | Adjust entitlement only after commercial approval; retain ledger history. |
| `BILLING_RECEIPT_NOT_FOUND` | Do not charge. Investigate the durable usage ledger and provider reference. |
| Replayed key | Expected no-double-charge protection; compare request fingerprint before any remediation. |
| `BILLING_FENCE_DENIED` | Stop the worker; a different controller owns or superseded the claim. Reconcile using the stored receipt only. |

## Rollback

Disable billing writes and the provider adapter. Do not delete `usageLedger`; it is the reconciliation source of truth.
