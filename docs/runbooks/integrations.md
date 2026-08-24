# Integration runbook

## Boundary and authorization

All provider calls use `IntegrationProviderPort`; credentials and authorization codes remain in the injected host transport and are never persisted or logged. Runtime tool inputs and assembled context are inspected directly and reject API keys, tokens, authorization values, passwords, and secrets rather than relying on metadata labels. Public Convex handlers (`upsertConnection`, `admitWebhook`, `queueDelivery`, `claimDelivery`, `reconcileDelivery`) derive the actor from `ctx.auth`, require an active workspace plus active membership, and reject stale, revoked, anonymous, and cross-tenant requests.

Connections persist `pending → active | failed → revoked`, scope and toolkit-version changes, and idempotent replay. The migration is additive and integration writes/workers must be enabled separately.

## Webhooks and delivery

Admit a webhook through `admitWebhook`, never a caller-trusted internal write. The public request never carries a webhook secret; the server resolves its provider secret from trusted `COMPOSIO_WEBHOOK_SECRET`, `SENDBLUE_WEBHOOK_SECRET`, or `APPLE_WEBHOOK_SECRET` configuration through `ProviderSecretPort`. The handler applies provider-bound HMAC-SHA256 verification using constant-time byte comparison, a five-minute clock window, 16 KiB payload bound, provider-plus-event deduplication, and redacted durable inbox storage in one authorized mutation. Missing provider configuration and forged caller signatures are denied.

Queue a delivery with `queueDelivery`; workers claim it with a monotonically increasing fence through `claimDelivery` only when `nextAttemptAt <= now`, then reconcile with that fence. `delivered` and `error` are terminal; stale fences and downgrades cannot overwrite a terminal state. `unknown` receives exponential retry scheduling. Each reconciliation persists provider ID, cost, and latency audit fields.

## Provider rules

- **Composio:** bind a selected connected account and require an explicit non-empty semantic toolkit version (`major.minor.patch` with an optional prerelease); persist that exact version on the connection.
- **Sendblue:** require E.164 (`+` plus 8–15 digits) and a capability lookup before sending. Model only `QUEUED`, `SENT`, `DELIVERED`, `ERROR`, and `UNKNOWN`; reconcile callbacks safely through the fenced outbox.
- **Apple:** Apple remains an explicit manual fallback. `iMessage.available` is always false and returns `manual_share`.

## Rollback

Disable integration writes and workers, drain or reconcile leased deliveries, then revert `convex/integrations.ts`, the integration schema/migration, adapter module, tests, and this runbook. Existing generic inbox/outbox records are unaffected.
