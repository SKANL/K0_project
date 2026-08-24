import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { convexTest } from "convex-test";
import schema from "../../convex/schema.js";
import { internal } from "../../convex/_generated/api.js";
import {
  assembleContextSnapshot, canonicalize, consumeEffect, createLineageGraph, createRddReceipt,
  executeTool, replayTrace, requireExactReceipt, transitionRun,
} from "../../packages/harness/src/index.js";

const modules = import.meta.glob("../../convex/**/*.ts");
const runtimeFixtures = JSON.parse(await readFile(resolve("tests/fixtures/runtime-traces.json"), "utf8")) as { goldenTrace: { snapshot: { workspaceId: string; sourceIds: string[] }; commands: { action: string; idempotencyKey: string }[] } };

async function runtime() {
  const t = convexTest(schema, modules);
  const workspaceId = await t.run((ctx) => ctx.db.insert("workspaces", { slug: "runtime", status: "active", version: 0 }));
  return { t, workspaceId };
}

describe("durable runtime harness", () => {
  it("rejects malformed tool arguments before execution and returns a typed error", async () => {
    let calls = 0;
    const result = await executeTool({ contract: { name: "send", capability: "message.send", validateInput: (value) => typeof value === "object" && value !== null && typeof (value as { recipient?: unknown }).recipient === "string" ? { ok: true, value: value as { recipient: string } } : { ok: false, code: "TOOL_INPUT_INVALID" }, validateOutput: (value) => value === "sent" ? { ok: true, value } : { ok: false, code: "TOOL_OUTPUT_INVALID" }, policy: () => ({ allowed: true }), precondition: () => ({ ok: true }), postcondition: () => ({ ok: true }) }, args: { recipient: 42 }, invoke: async () => { calls += 1; return "sent"; } });
    expect(result).toEqual({ ok: false, error: { code: "TOOL_INPUT_INVALID" } }); expect(calls).toBe(0);
  });

  it("rejects illegal and stale OCC transitions while duplicate transitions are idempotent", () => {
    expect(transitionRun({ state: "completed", version: 4 }, { commandId: "complete-1", expectedVersion: 4, target: "completed", actor: "agent", reason: "done", timestamp: 1, evidence: "proof" })).toMatchObject({ ok: true, duplicate: true });
    expect(transitionRun({ state: "completed", version: 4 }, { commandId: "resume-1", expectedVersion: 4, target: "running", actor: "agent", reason: "resume", timestamp: 2, evidence: "proof" })).toEqual({ ok: false, error: { code: "ILLEGAL_TRANSITION" } });
  });

  it("rejects a distinct reordered sequence independently of duplicate ID suppression", () => {
    const first = consumeEffect({ effects: [], fences: { "run-1": 2 }, nextSequences: { "run-1": 1 } }, { idempotencyKey: "effect-1", sequence: 1, runId: "run-1", fence: 2, outcome: "verified" });
    const replayedId = consumeEffect(first, { idempotencyKey: "effect-1", sequence: 2, runId: "run-1", fence: 2, outcome: "verified" });
    const reordered = consumeEffect(first, { idempotencyKey: "effect-2", sequence: 3, runId: "run-1", fence: 2, outcome: "verified" });
    expect(replayedId).toMatchObject({ accepted: false, duplicate: true });
    expect(reordered).toMatchObject({ accepted: false, error: { code: "SEQUENCE_REJECTED" }, effects: [{ idempotencyKey: "effect-1" }] });
  });

  it("derives outcomes from validated effects rather than model state and classifies differences", () => {
    const trace = runtimeFixtures.goldenTrace;
    const equalA = replayTrace(trace, () => ({ proposal: "a", state: { privileged: true }, effects: [{ idempotencyKey: "e", sequence: 1, runId: "r", fence: 1, outcome: "verified" }] }));
    const equalB = replayTrace(trace, () => ({ proposal: "b", state: { privileged: false }, effects: [{ idempotencyKey: "e", sequence: 1, runId: "r", fence: 1, outcome: "verified" }] }));
    const different = replayTrace(trace, () => ({ proposal: "c", state: { effects: [] }, effects: [{ idempotencyKey: "e", sequence: 1, runId: "r", fence: 1, outcome: "denied" }] }));
    expect(equalA.canonicalState).toBe(equalB.canonicalState);
    expect(equalA.classification).toBe("equivalent");
    expect(different.classification).toBe("different");
  });

  it("persists run transitions, effects, bounded snapshots, replay artifacts, and exact-byte receipts through Convex", async () => {
    const { t, workspaceId } = await runtime();
    const created = await t.mutation(internal.state.createRun, { workspaceId, runKey: "run-1", state: "queued", version: 0, fence: 1 });
    const transitioned = await t.mutation(internal.state.transition, { runId: created, commandId: "start", expectedVersion: 0, target: "running", actor: "worker-a", reason: "start", timestamp: 1, evidence: "proof" });
    expect(transitioned).toMatchObject({ ok: true, state: "running", version: 1 });
    await expect(t.mutation(internal.state.transition, { runId: created, commandId: "bad", expectedVersion: 1, target: "queued", actor: "worker-a", reason: "bad", timestamp: 2, evidence: "proof" })).rejects.toThrow("ILLEGAL_TRANSITION");
    expect(await t.mutation(internal.state.recordEffect, { runId: created, idempotencyKey: "one", sequence: 1, fence: 1, outcome: "verified" })).toMatchObject({ accepted: true });
    expect(await t.mutation(internal.state.recordEffect, { runId: created, idempotencyKey: "two", sequence: 3, fence: 1, outcome: "verified" })).toMatchObject({ accepted: false, code: "SEQUENCE_REJECTED" });
    expect(await t.mutation(internal.state.recordEffect, { runId: created, idempotencyKey: "stale", sequence: 2, fence: 0, outcome: "verified" })).toMatchObject({ accepted: false, code: "FENCE_REJECTED" });
    await t.mutation(internal.state.saveSnapshot, { workspaceId, runId: created, snapshotKey: "s", budget: 3, usedTokens: 3, sourceIds: ["b", "a"], provenance: ["p"] });
    await expect(t.mutation(internal.state.saveSnapshot, { workspaceId, runId: created, snapshotKey: "too-many", budget: 1, usedTokens: 2, sourceIds: [], provenance: [] })).rejects.toThrow("SNAPSHOT_BUDGET_EXCEEDED");
    await t.mutation(internal.state.saveReplayArtifact, { workspaceId, runId: created, replayKey: "r", canonicalState: "{}", classification: "equivalent" });
    await t.mutation(internal.state.writeReceipt, { workspaceId, runId: created, receiptKey: "receipt", reviewedBytes: "exact", transitions: ["start"], evidence: ["test"], lineage: "lineage" });
    expect(await t.query(internal.state.getReceipt, { workspaceId, receiptKey: "receipt", candidateBytes: "exact" })).toEqual({ ok: true });
    expect(await t.query(internal.state.getReceipt, { workspaceId, receiptKey: "receipt", candidateBytes: "different" })).toEqual({ ok: false, code: "RDD_BYTES_MISMATCH" });
  });

  it("keeps snapshots and receipts immutable at the harness boundary", () => {
    const snapshot = assembleContextSnapshot({ workspaceId: "w1", budget: 5, sources: [{ id: "high", workspaceId: "w1", priority: 2, tokens: 3, content: "high", provenance: "p2" }] });
    const receipt = createRddReceipt({ reviewedBytes: canonicalize(runtimeFixtures.goldenTrace), transitions: ["complete"], evidence: ["test:pass"], lineage: "lineage-1" });
    expect(Object.isFrozen(snapshot)).toBe(true); expect(requireExactReceipt(receipt, canonicalize(runtimeFixtures.goldenTrace))).toEqual({ ok: true });
    expect(createLineageGraph("w1", 1).addEdge({ from: "a", to: "b", workspaceId: "w2", provenance: "p" })).toEqual({ ok: false, code: "CROSS_TENANT_EDGE" });
  });
});
