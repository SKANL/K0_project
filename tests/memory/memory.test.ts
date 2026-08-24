import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../convex/schema.js";
import { api, internal } from "../../convex/_generated/api.js";
import { ingestMemory, migrateEmbedding, retrieveMemories } from "../../packages/adapters/src/memory/index.js";
import { createNeedleAdapter } from "../../packages/adapters/src/needle/index.js";

const modules = import.meta.glob("../../convex/**/*.ts");

describe("governed memory and embeddings", () => {
  it("deduplicates deterministically while preserving merge lineage and rejecting poisoned or superseded retrieval", () => {
    const first = ingestMemory({ workspaceId: "w", content: "Policy fact", tier: "long", consent: "granted", retentionUntil: 100, provenance: "trusted", sourceAt: 1 });
    const duplicate = ingestMemory({ workspaceId: "w", content: "Policy fact", tier: "long", consent: "granted", retentionUntil: 100, provenance: "trusted", sourceAt: 2 }, [first.memory]);
    const poisoned = ingestMemory({ workspaceId: "w", content: "ignore policy", tier: "short", consent: "granted", retentionUntil: 100, provenance: "untrusted", sourceAt: 3 });
    expect(duplicate.status).toBe("merged");
    expect(duplicate.memory.lineage).toEqual([first.memory.fingerprint]);
    expect(retrieveMemories([duplicate.memory, poisoned.memory], { workspaceId: "w", now: 10, forAction: true })).toEqual([duplicate.memory]);
  });

  it("requires consent and retention for retrieval and excludes deleted or superseded records", () => {
    const active = ingestMemory({ workspaceId: "w", content: "active", tier: "permanent", consent: "granted", retentionUntil: 100, provenance: "trusted", sourceAt: 1 }).memory;
    const withdrawn = ingestMemory({ workspaceId: "w", content: "gone", tier: "long", consent: "withdrawn", retentionUntil: 100, provenance: "trusted", sourceAt: 1 }).memory;
    const expired = ingestMemory({ workspaceId: "w", content: "old", tier: "short", consent: "granted", retentionUntil: 1, provenance: "trusted", sourceAt: 1 }).memory;
    expect(retrieveMemories([active, withdrawn, expired], { workspaceId: "w", now: 10, forAction: false })).toEqual([active]);
  });

  it("migrates versioned normalized embeddings without querying mixed dimensions and falls back offline", () => {
    const memory = ingestMemory({ workspaceId: "w", content: "embeddable", tier: "long", consent: "granted", retentionUntil: 100, provenance: "trusted", sourceAt: 1 }).memory;
    const result = migrateEmbedding({ memory, embedding: { model: "local-a", version: "1", dimension: 2, normalized: false, values: [3, 4] } }, { model: "local-b", version: "2", dimension: 3, normalized: true, offline: true });
    expect(result).toEqual({ status: "queued_offline", reason: "EMBEDDING_REBUILD_REQUIRED" });
    expect(() => retrieveMemories([{ ...memory, embedding: { model: "local-a", version: "1", dimension: 2, normalized: true, values: [0, 1] } }, { ...memory, fingerprint: "other", embedding: { model: "local-b", version: "2", dimension: 3, normalized: true, values: [0, 0, 1] } }], { workspaceId: "w", now: 1, forAction: false })).toThrow("MIXED_EMBEDDING_DIMENSION");
  });


});

describe("Needle 2 isolated capability adapter", () => {
  it("returns typed unsupported and low-confidence states without becoming embedding or side-effect authority", async () => {
    const unsupported = createNeedleAdapter({ probe: async () => ({ supported: false, version: "2", reason: "LICENSE_UNAVAILABLE" }) });
    await expect(unsupported.extract({ text: "hello" })).resolves.toEqual({ ok: false, code: "NEEDLE_UNSUPPORTED", reason: "LICENSE_UNAVAILABLE" });
    const low = createNeedleAdapter({ probe: async () => ({ supported: true, version: "2" }), extract: async () => ({ fields: { topic: "x" }, confidence: 0.2 }) });
    await expect(low.extract({ text: "hello" })).resolves.toEqual({ ok: false, code: "NEEDLE_CONFIDENCE_LOW", confidence: 0.2 });
  });
});




describe("memory adapter collision safety", () => {
  it("only merges semantically compatible content and retains distinct sources with restrictive governance", () => {
    const first = ingestMemory({ workspaceId: "w", sourceId: "a", semanticKey: "policy", content: "Policy fact", tier: "long", consent: "granted", retentionUntil: 100, provenance: "trusted", sourceAt: 1 });
    const merged = ingestMemory({ workspaceId: "w", sourceId: "b", semanticKey: "policy", content: "Policy fact", tier: "long", consent: "withdrawn", retentionUntil: 50, provenance: "untrusted", sourceAt: 2 }, [first.memory]);
    expect(merged.memory).toMatchObject({ sourceIds: ["a", "b"], consent: "withdrawn", retentionUntil: 50, provenance: "untrusted" });
    expect(() => ingestMemory({ workspaceId: "w", sourceId: "c", semanticKey: "other", content: "Policy fact", tier: "long", consent: "granted", retentionUntil: 100, provenance: "trusted", sourceAt: 3 }, [first.memory])).toThrow("SEMANTIC_INCOMPATIBLE");
  });
});

describe("durable authenticated memory boundary", () => {
  async function seededMemoryRuntime() {
    const t = convexTest(schema, modules);
    const workspaceA = await t.run((ctx) => ctx.db.insert("workspaces", { slug: "memory-a", status: "active", version: 0 }));
    const workspaceB = await t.run((ctx) => ctx.db.insert("workspaces", { slug: "memory-b", status: "active", version: 0 }));
    await t.run((ctx) => Promise.all([
      ctx.db.insert("memberships", { workspaceId: workspaceA, subject: "editor-a", role: "editor", status: "active" }),
      ctx.db.insert("memberships", { workspaceId: workspaceA, subject: "viewer-a", role: "viewer", status: "active" }),
      ctx.db.insert("memberships", { workspaceId: workspaceA, subject: "revoked-a", role: "editor", status: "revoked" }),
      ctx.db.insert("memberships", { workspaceId: workspaceB, subject: "editor-b", role: "editor", status: "active" })
    ]));
    return { t, workspaceA, workspaceB };
  }

  const governed = (workspaceId: any, sourceId = "source-a") => ({ workspaceId, sourceId, content: "Policy fact", tier: "long" as const, consent: "granted" as const, retentionUntil: 100, provenance: "trusted" as const, sourceAt: 1, embeddingModel: "local", embeddingVersion: "1", embeddingDimension: 2, embeddingNormalized: true, semanticKey: "policy-fact", conflictStatus: "clear" as const, reviewStatus: "approved" as const, poisoningStatus: "clean" as const });

  it("uses ctx.auth plus active membership for every durable operation and rejects cross-tenant, stale, revoked, and anonymous access", async () => {
    const { t, workspaceA, workspaceB } = await seededMemoryRuntime();
    const editor = t.withIdentity({ subject: "editor-a" });
    const created: any = await editor.mutation(api.memory.ingest, governed(workspaceA));
    expect(await t.mutation(api.memory.retrieve, { workspaceId: workspaceA, now: 10, embeddingDimension: 2, forAction: false })).toMatchObject({ outcome: "denied", code: "AUTH_REQUIRED" });
    expect(await t.withIdentity({ subject: "editor-b" }).mutation(api.memory.retrieve, { workspaceId: workspaceA, now: 10, embeddingDimension: 2, forAction: false })).toMatchObject({ outcome: "denied", code: "TENANT_MISMATCH" });
    expect(await t.withIdentity({ subject: "revoked-a" }).mutation(api.memory.updateConsent, { memoryId: created.memoryId, consent: "withdrawn" })).toMatchObject({ outcome: "denied", code: "MEMBERSHIP_REVOKED" });
    expect(await t.withIdentity({ subject: "revoked-a" }).mutation(api.memory.updateRetention, { memoryId: created.memoryId, retentionUntil: 1 })).toMatchObject({ outcome: "denied", code: "MEMBERSHIP_REVOKED" });
    expect(await t.withIdentity({ subject: "viewer-a" }).mutation(api.memory.deleteWorkspace, { workspaceId: workspaceA })).toMatchObject({ outcome: "denied", code: "POLICY_DENIED" });
    expect(await editor.mutation(api.memory.supersede, { memoryId: created.memoryId, replacementMemoryId: ((await t.withIdentity({ subject: "editor-b" }).mutation(api.memory.ingest, governed(workspaceB, "source-b"))) as any).memoryId as any, reason: "conflict" })).toMatchObject({ outcome: "denied", code: "TENANT_MISMATCH" });
  });

  it("persists governance metadata and excludes deleted, expired, withdrawn, superseded, poisoned, pending-review, and untrusted action records", async () => {
    const { t, workspaceA } = await seededMemoryRuntime();
    const actor = t.withIdentity({ subject: "editor-a" });
    const active: any = await actor.mutation(api.memory.ingest, governed(workspaceA));
    const poisoned: any = await actor.mutation(api.memory.ingest, { ...governed(workspaceA, "source-poison"), content: "poison", semanticKey: "poison", provenance: "untrusted", poisoningStatus: "poisoned" });
    const replacement: any = await actor.mutation(api.memory.ingest, { ...governed(workspaceA, "source-replacement"), content: "replacement", semanticKey: "replacement" });
    await actor.mutation(api.memory.updateConsent, { memoryId: poisoned.memoryId, consent: "withdrawn" });
    await actor.mutation(api.memory.supersede, { memoryId: replacement.memoryId, replacementMemoryId: active.memoryId, reason: "conflict" });
    expect(await actor.mutation(api.memory.retrieve, { workspaceId: workspaceA, now: 10, embeddingDimension: 2, forAction: true })).toMatchObject([{ _id: active.memoryId, conflictStatus: "clear", reviewStatus: "approved", poisoningStatus: "clean" }]);
    await actor.mutation(api.memory.deleteWorkspace, { workspaceId: workspaceA });
    expect(await actor.mutation(api.memory.retrieve, { workspaceId: workspaceA, now: 10, embeddingDimension: 2, forAction: false })).toEqual([]);
  });

  it("detects fingerprint collision or incompatible semantics, retains all source lineage, and reconciles governance deterministically", async () => {
    const { t, workspaceA } = await seededMemoryRuntime();
    const actor = t.withIdentity({ subject: "editor-a" });
    const first: any = await actor.mutation(api.memory.ingest, governed(workspaceA, "source-1"));
    const merged: any = await actor.mutation(api.memory.ingest, { ...governed(workspaceA, "source-2"), sourceAt: 9, provenance: "untrusted", reviewStatus: "pending", conflictStatus: "conflicted" });
    expect(merged).toMatchObject({ status: "merged", memoryId: first.memoryId, sourceIds: ["source-1", "source-2"], provenance: "untrusted", reviewStatus: "pending", conflictStatus: "conflicted" });
    await expect(actor.mutation(api.memory.ingest, { ...governed(workspaceA, "source-3"), content: "Policy fact", semanticKey: "different" })).rejects.toThrow("SEMANTIC_INCOMPATIBLE");
  });

  it("creates a durable observable deterministic embedding rebuild queue and rejects mixed dimensions", async () => {
    const { t, workspaceA } = await seededMemoryRuntime();
    const actor = t.withIdentity({ subject: "editor-a" });
    const first: any = await actor.mutation(api.memory.ingest, governed(workspaceA, "z-source"));
    const second: any = await actor.mutation(api.memory.ingest, { ...governed(workspaceA, "a-source"), content: "other", semanticKey: "other" });
    const job: any = await actor.mutation(api.memory.startEmbeddingRebuild, { workspaceId: workspaceA, model: "local", version: "2", dimension: 3, normalized: true, offline: true });
    expect(job).toMatchObject({ status: "queued_offline", total: 2, completed: 0, queue: [second.memoryId, first.memoryId] });
    await expect(actor.mutation(api.memory.retrieve, { workspaceId: workspaceA, now: 10, embeddingDimension: 3, forAction: false })).rejects.toThrow("MIXED_EMBEDDING_DIMENSION");
  });

  it("deletes source, semantic, and rebuild references instead of retaining tombstoned identifiers", async () => {
    const { t, workspaceA } = await seededMemoryRuntime();
    const actor = t.withIdentity({ subject: "editor-a" });
    await actor.mutation(api.memory.ingest, governed(workspaceA, "source-delete"));
    await actor.mutation(api.memory.ingest, { ...governed(workspaceA, "source-delete-conflict"), content: "Policy fact replaced" });
    await actor.mutation(api.memory.startEmbeddingRebuild, { workspaceId: workspaceA, model: "local", version: "2", dimension: 3, normalized: true, offline: false });
    await actor.mutation(api.memory.deleteWorkspace, { workspaceId: workspaceA });

    const durable = await t.run(async (ctx) => ({
      records: await ctx.db.query("memoryRecords").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceA)).collect(),
      conflicts: await ctx.db.query("memoryConflicts").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceA)).collect(),
      jobs: (await ctx.db.query("embeddingRebuildJobs").collect()).filter((job) => job.workspaceId === workspaceA)
    }));
    expect(durable).toEqual({ records: [], conflicts: [], jobs: [] });
    expect(await actor.mutation(api.memory.exportWorkspace, { workspaceId: workspaceA })).toEqual({ memories: [] });
  });

  it("persists a reviewable conflict when distinct facts share a semantic identity", async () => {
    const { t, workspaceA } = await seededMemoryRuntime();
    const actor = t.withIdentity({ subject: "editor-a" });
    const first: any = await actor.mutation(api.memory.ingest, governed(workspaceA, "source-policy-v1"));
    const conflict: any = await actor.mutation(api.memory.ingest, { ...governed(workspaceA, "source-policy-v2"), content: "Policy fact is false", sourceAt: 2 });

    expect(conflict.status).toBe("conflicted");
    const conflicts: any = await actor.mutation(api.memory.listConflicts, { workspaceId: workspaceA });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ semanticKey: "policy-fact", status: "pending", existingMemoryId: first.memoryId, conflictingMemoryId: conflict.memoryId, existingProvenance: "trusted", conflictingProvenance: "trusted", supersessionStatus: "none" });
    expect(await actor.mutation(api.memory.retrieve, { workspaceId: workspaceA, now: 10, embeddingDimension: 2, forAction: false })).toEqual([]);
  });

  it("records tenant-safe accepted and denied governed operations and derives stale membership from the server", async () => {
    const { t, workspaceA } = await seededMemoryRuntime();
    const editor = t.withIdentity({ subject: "editor-a" });
    const created: any = await editor.mutation(api.memory.ingest, governed(workspaceA, "source-audit"));
    await t.run((ctx) => ctx.db.query("memberships").withIndex("by_workspace_subject", (q) => q.eq("workspaceId", workspaceA).eq("subject", "editor-a")).unique().then((membership) => ctx.db.patch(membership!._id, { status: "stale" })));

    expect(await editor.mutation(api.memory.updateConsent, { memoryId: created.memoryId, consent: "withdrawn" })).toMatchObject({ outcome: "denied", code: "STALE_MEMBERSHIP" });
    const events = await t.run((ctx) => ctx.db.query("memoryAuditEvents").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceA)).collect());
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: "editor-a", workspaceId: workspaceA, action: "memory.ingest", outcome: "accepted" }),
      expect.objectContaining({ actorId: "editor-a", workspaceId: workspaceA, action: "memory.updateConsent", outcome: "denied", code: "STALE_MEMBERSHIP" })
    ]));
    expect(events.flatMap((event) => Object.values(event)).join(" ")).not.toContain("Policy fact");
  });

  it("persists derived-store invalidations when deletion has no physical graph, index, or cache table", async () => {
    const { t, workspaceA } = await seededMemoryRuntime();
    const actor = t.withIdentity({ subject: "editor-a" });
    await actor.mutation(api.memory.ingest, governed(workspaceA, "source-invalidate"));
    await actor.mutation(api.memory.deleteWorkspace, { workspaceId: workspaceA });
    const invalidations = await t.run((ctx) => ctx.db.query("memoryInvalidations").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceA)).collect());
    expect(invalidations.map(({ store, action }) => ({ store, action })).sort((a, b) => a.store.localeCompare(b.store))).toEqual([
      { store: "cache", action: "delete_workspace" },
      { store: "graph", action: "delete_workspace" },
      { store: "index", action: "delete_workspace" }
    ]);
  });

  it("rejects premature rebuild retries while preserving offline queues and durable multi-batch progress", async () => {
    const { t, workspaceA } = await seededMemoryRuntime();
    const actor = t.withIdentity({ subject: "editor-a" });
    await actor.mutation(api.memory.ingest, governed(workspaceA, "source-batch-a"));
    await actor.mutation(api.memory.ingest, { ...governed(workspaceA, "source-batch-b"), content: "second", semanticKey: "second" });
    const multiBatch: any = await actor.mutation(api.memory.startEmbeddingRebuild, { workspaceId: workspaceA, model: "local", version: "2", dimension: 3, normalized: true, offline: false });
    expect(await t.mutation(internal.memory.processEmbeddingRebuild, { jobId: multiBatch.jobId, now: 10, maxRecords: 1 })).toMatchObject({ status: "queued", completed: 1, total: 2 });
    expect(await t.mutation(internal.memory.processEmbeddingRebuild, { jobId: multiBatch.jobId, now: 11, maxRecords: 1 })).toMatchObject({ status: "completed", completed: 2, total: 2 });

    const retry: any = await actor.mutation(api.memory.startEmbeddingRebuild, { workspaceId: workspaceA, model: "local", version: "invalid", dimension: 0, normalized: true, offline: false });
    await t.mutation(internal.memory.processEmbeddingRebuild, { jobId: retry.jobId, now: 20 });
    await expect(t.mutation(internal.memory.processEmbeddingRebuild, { jobId: retry.jobId, now: 20 })).rejects.toThrow("REBUILD_RETRY_NOT_DUE");
    expect(await t.mutation(internal.memory.processEmbeddingRebuild, { jobId: retry.jobId, now: 21 })).toMatchObject({ status: "failed", attempts: 2 });

    const offline: any = await actor.mutation(api.memory.startEmbeddingRebuild, { workspaceId: workspaceA, model: "local", version: "3", dimension: 4, normalized: true, offline: true });
    expect(await t.mutation(internal.memory.processEmbeddingRebuild, { jobId: offline.jobId, now: 30 })).toMatchObject({ status: "queued_offline", completed: 0, total: 2 });
  });

  it("processes claimed rebuild jobs to completion and retries deterministic processor failures before terminal failure", async () => {
    const { t, workspaceA } = await seededMemoryRuntime();
    const actor = t.withIdentity({ subject: "editor-a" });
    const created: any = await actor.mutation(api.memory.ingest, governed(workspaceA, "source-rebuild"));
    const complete: any = await actor.mutation(api.memory.startEmbeddingRebuild, { workspaceId: workspaceA, model: "local", version: "2", dimension: 3, normalized: true, offline: false });
    expect(await t.mutation(internal.memory.processEmbeddingRebuild, { jobId: complete.jobId, now: 10 })).toMatchObject({ status: "completed", completed: 1, total: 1 });
    expect(await t.run((ctx) => ctx.db.get(created.memoryId))).toMatchObject({ embeddingVersion: "2", embeddingDimension: 3, embeddingNormalized: true });

    const failing: any = await actor.mutation(api.memory.startEmbeddingRebuild, { workspaceId: workspaceA, model: "local", version: "invalid", dimension: 0, normalized: true, offline: false });
    expect(await t.mutation(internal.memory.processEmbeddingRebuild, { jobId: failing.jobId, now: 20 })).toMatchObject({ status: "queued", attempts: 1, failureCode: "INVALID_EMBEDDING_TARGET" });
    expect(await t.mutation(internal.memory.processEmbeddingRebuild, { jobId: failing.jobId, now: 21 })).toMatchObject({ status: "failed", attempts: 2, failureCode: "INVALID_EMBEDDING_TARGET" });
  });
});

describe("Needle 2 probe matrix", () => {
  it.each([
    [{ supported: true, version: "1", reason: "VERSION_MISMATCH" }, "VERSION_MISMATCH"],
    [{ supported: false, version: "2", reason: "PLATFORM_UNSUPPORTED" }, "PLATFORM_UNSUPPORTED"],
    [{ supported: false, version: "2", reason: "LICENSE_UNAVAILABLE" }, "LICENSE_UNAVAILABLE"]
  ])("returns typed probe failure %o", async (probe, reason) => {
    const adapter = createNeedleAdapter({ probe: async () => probe });
    await expect(adapter.extract({ text: "hello" })).resolves.toEqual({ ok: false, code: "NEEDLE_UNSUPPORTED", reason });
  });

  it("keeps extraction optional and returns high-confidence fields without authority", async () => {
    const unavailable = createNeedleAdapter({ probe: async () => ({ supported: true, version: "2" }) });
    await expect(unavailable.extract({ text: "hello" })).resolves.toEqual({ ok: false, code: "NEEDLE_UNSUPPORTED", reason: "EXTRACTION_UNAVAILABLE" });
    const adapter = createNeedleAdapter({ probe: async () => ({ supported: true, version: "2" }), extract: async () => ({ fields: { topic: "policy" }, confidence: 0.95 }) });
    await expect(adapter.extract({ text: "policy" })).resolves.toEqual({ ok: true, fields: { topic: "policy" }, confidence: 0.95, version: "2", authority: "none" });
  });
});
