import { internalMutation, internalQuery } from "./_generated/server.js";
import { v } from "convex/values";

export type CommandState = "accepted" | "denied" | "conflict";
export const nextVersion = (currentVersion: number) => currentVersion + 1;

export type DurableRunState = "queued" | "running" | "completed" | "failed" | "manual_review";
const legalTransitions: Readonly<Record<DurableRunState, readonly DurableRunState[]>> = {
  queued: ["running", "failed", "manual_review"], running: ["completed", "failed", "manual_review"], completed: [], failed: ["manual_review"], manual_review: ["queued", "failed"]
};
export function isLegalRunTransition(current: DurableRunState, target: DurableRunState) { return current === target || legalTransitions[current].includes(target); }

const runStates = v.union(v.literal("queued"), v.literal("running"), v.literal("completed"), v.literal("failed"), v.literal("manual_review"));

export const createRun = internalMutation({
  args: { workspaceId: v.id("workspaces"), runKey: v.string(), state: runStates, version: v.number(), fence: v.number() },
  handler: (ctx, args) => ctx.db.insert("runs", args),
});

export const transition = internalMutation({
  args: { runId: v.id("runs"), commandId: v.string(), expectedVersion: v.number(), target: runStates, actor: v.string(), reason: v.string(), timestamp: v.number(), evidence: v.string() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("RUN_NOT_FOUND");
    if (args.expectedVersion !== run.version) throw new Error("OCC_CONFLICT");
    if (args.target === run.state) return { ok: true as const, duplicate: true as const, state: run.state, version: run.version };
    if (!isLegalRunTransition(run.state, args.target)) throw new Error("ILLEGAL_TRANSITION");
    await ctx.db.patch(args.runId, { state: args.target, version: run.version + 1 });
    return { ok: true as const, duplicate: false as const, state: args.target, version: run.version + 1 };
  },
});

export const recordEffect = internalMutation({
  args: { runId: v.id("runs"), idempotencyKey: v.string(), sequence: v.number(), fence: v.number(), outcome: v.union(v.literal("verified"), v.literal("denied"), v.literal("failed"), v.literal("unknown")) },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.fence !== args.fence) return { accepted: false as const, code: "FENCE_REJECTED" as const };
    const duplicate = await ctx.db.query("runtimeEffects").withIndex("by_run_key", (q) => q.eq("runId", args.runId).eq("idempotencyKey", args.idempotencyKey)).unique();
    if (duplicate) return { accepted: false as const, duplicate: true as const };
    const previous = await ctx.db.query("runtimeEffects").filter((q) => q.eq(q.field("runId"), args.runId)).collect();
    if (args.sequence !== previous.length + 1) return { accepted: false as const, code: "SEQUENCE_REJECTED" as const };
    await ctx.db.insert("runtimeEffects", args);
    return { accepted: true as const };
  },
});

export const saveSnapshot = internalMutation({
  args: { workspaceId: v.id("workspaces"), runId: v.id("runs"), snapshotKey: v.string(), budget: v.number(), usedTokens: v.number(), sourceIds: v.array(v.string()), provenance: v.array(v.string()) },
  handler: async (ctx, args) => { if (args.usedTokens > args.budget) throw new Error("SNAPSHOT_BUDGET_EXCEEDED"); await ctx.db.insert("contextSnapshots", { ...args, sourceIds: [...args.sourceIds].sort(), provenance: [...args.provenance].sort() }); },
});

export const saveReplayArtifact = internalMutation({
  args: { workspaceId: v.id("workspaces"), runId: v.id("runs"), replayKey: v.string(), canonicalState: v.string(), classification: v.union(v.literal("equivalent"), v.literal("different")) },
  handler: (ctx, args) => ctx.db.insert("replayArtifacts", args),
});

export const writeReceipt = internalMutation({
  args: { workspaceId: v.id("workspaces"), runId: v.id("runs"), receiptKey: v.string(), reviewedBytes: v.string(), transitions: v.array(v.string()), evidence: v.array(v.string()), lineage: v.string() },
  handler: (ctx, args) => ctx.db.insert("rddReceipts", { ...args, transitions: [...args.transitions].sort(), evidence: [...args.evidence].sort() }),
});

export const getReceipt = internalQuery({
  args: { workspaceId: v.id("workspaces"), receiptKey: v.string(), candidateBytes: v.string() },
  handler: async (ctx, args) => {
    const receipt = await ctx.db.query("rddReceipts").withIndex("by_workspace_key", (q) => q.eq("workspaceId", args.workspaceId).eq("receiptKey", args.receiptKey)).unique();
    if (!receipt || !receipt.lineage || !receipt.transitions.length || !receipt.evidence.length) return { ok: false as const, code: "RDD_RECEIPT_REQUIRED" as const };
    return receipt.reviewedBytes === args.candidateBytes ? { ok: true as const } : { ok: false as const, code: "RDD_BYTES_MISMATCH" as const };
  },
});
