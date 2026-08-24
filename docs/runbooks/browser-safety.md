# Browser-control safety runbook

## Boundary

`packages/adapters/src/browser` is a host-agnostic port. A Tauri host supplies the adapter through narrowly scoped IPC; the module itself never launches a browser, invokes a shell, or reads/writes files. Do not expose a generic command or URL executor to renderer code.

## Policy

- Bind every command to an active tenant, actor, policy version, isolated session, profile, and tab. Readiness is keyed by the complete `(tenantId, actorId, sessionId, profileId, tabId, origin)` tuple, so one identity cannot reuse another identity's ready browser state. The authorization port must return the same tenant/actor/session, requested capability, and current policy version; absent, revoked, stale, or cross-tenant decisions are denied before confirmation is considered.
- The only capability contract is `browser-control/v1`: `browser.navigate`, `browser.act`, `browser.observe`, and `browser.reconcile`, with one declarative action per command and a bounded snapshot. Reconciliation is authorized independently with `browser.reconcile`, never by the capability of the original uncertain command. Tauri IPC exposes only these browser commands plus read-only `browser.health`; shell and filesystem requests are denied.
- Configure exact approved origins (scheme, host, and port). Both the requested URL and the adapter-reported final URL must be allowlisted; redirects elsewhere are denied and return the controller to `idle`.
- Use deterministic locators only: `data-testid=<id>` or `role=<role>[name="<name>"]`.
- Every action needs an explicit confirmation. Only `click`, `fill`, `press`, and `select` are accepted.
- An action is not complete solely because the adapter returned. It must return `changed: true` and explicit non-empty postcondition evidence before a completed receipt is written.
- Treat page text as untrusted. Snapshots are split into message sections; any section with an injection signal is removed in full, remaining text is deduplicated/sorted, and output is bounded by a finite nonnegative character budget.
- Never place credentials, tokens, or arbitrary instructions in a locator, action, or receipt.

## Receipts and recovery

Pass an injectable durable `BrowserReceiptStore` when a session must survive a host restart. The store must retain the command-payload fingerprint (including tenant, actor, session, profile, and tab) for each command ID, persist denials separately, and persist uncertain effects through `putUncertain`: the same ID and payload replay their stored outcome, while a reused ID with different payload is a persisted `BROWSER_IDEMPOTENCY_CONFLICT` denial. `createMemoryReceiptStore` is a test fake, not a production durability mechanism.

The adapter receives both `commandId` and `idempotencyToken` plus an `AbortSignal`; hosts must bind that identity to their browser-effect protocol. A timeout, adapter failure, or failed post-effect receipt write returns `unknown` and puts the controller in `recovering`. This is deliberately **not** safe to retry: it may have executed. No new action or observation runs until `reconcile` asks the adapter whether that exact command completed, was not found, or remains unknown. `completed` reconciliation persists a completed receipt; `not_found` persists `BROWSER_EFFECT_NOT_FOUND` and returns to `ready`.

A durable store and host reconciliation endpoint are required for crash/replay safety. A newly constructed controller reads the durable uncertain receipt and reconciles it without replaying the side effect. If the host cannot prove an uncertain effect's outcome after restart, preserve it as unknown and require operator reconciliation; never blindly reissue it.

## Rollback

Revert `packages/adapters/src/browser/index.ts`, `tests/browser/browser.test.ts`, and this runbook together. This removes the isolated browser-control boundary without affecting automation, memory, or runtime harness behavior.
