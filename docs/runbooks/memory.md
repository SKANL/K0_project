# Governed durable memory operations

All Convex memory entry points derive the actor from `ctx.auth`; callers never provide a subject. Access checks run server-side against the current workspace membership. Every authorized or denied durable memory operation writes a tenant-scoped `memoryAuditEvents` record containing only actor, workspace, action, outcome, and denial code—never memory content, source IDs, semantic keys, or embeddings. Read handlers are mutations so their audit record commits atomically with the observed access decision. Missing identity, stale/revoked membership, inactive workspaces, and tenant mismatches return a structured denied outcome and fail closed.

## Record and retrieval controls

Each record persists source identities and lineage, canonical content, semantic key, provenance, conflict/review/poisoning status, consent, retention, supersession and deletion state. Retrieval excludes deleted, expired, withdrawn-consent, superseded, poisoned, conflicted, and unapproved records; action retrieval additionally excludes untrusted provenance.

A duplicate fingerprint is merged only after canonical-content and semantic-key checks. Merges preserve every source identity and use deterministic restrictive reconciliation: earliest retention, most restrictive consent, untrusted provenance, conflicted/pending/rejected governance, and poisoned status win. Distinct content with the same semantic key never silently merges: both records are marked conflicted/pending and a `memoryConflicts` row persists typed provenance, review, and supersession lineage for resolution.

## Embedding migration

`startEmbeddingRebuild` creates one durable job per workspace and target `model:version:dimension:normalized`. The job persists status, progress, attempts, target metadata, and an offline-safe queue ordered by source identity. The internal `processEmbeddingRebuild` mutation claims queued work deterministically, advances record metadata and progress across bounded batches, completes terminal jobs, and retries deterministic failures once before `failed`. `nextAttemptAt` is enforced server-side: premature retry attempts are rejected without advancing state. Offline scheduling returns `queued_offline`; its queue remains durable and content is never sent remotely. Retrieval rejects a workspace with active records at mixed dimensions.

## Rollback

Workspace deletion physically removes memory records, durable conflict rows, and rebuild jobs together, so source IDs, semantic metadata, and queued record IDs cannot survive. This repository has no physical memory graph, index, or cache tables; deletion therefore writes one tenant-scoped `memoryInvalidations` tombstone per derived-store class (`graph`, `index`, `cache`) rather than claiming physical propagation that does not exist. The migration includes `memoryConflicts`, audit, and invalidation tables. Revert only the PR4 memory schema, handlers, adapters, tests, generated API, migration, and this runbook; foundation, runtime, and automation work are unaffected.

## Needle 2

Needle 2 is an isolated optional extraction adapter. Its capability probe returns typed version-mismatch, unsupported-platform, unavailable-license, and extraction-unavailable outcomes. Successful high-confidence extraction returns `authority: "none"`: it never provides embeddings or authorizes side effects.
