import { mutation, query } from "./_generated/server.js";
import { v } from "convex/values";
import { evaluateReadiness, redactAuditMetadata } from "../packages/ops/src/index.js";
import { authorizeTenantAccess, type Membership } from "../packages/contracts/src/foundation.js";
async function access(ctx: any, workspaceId: any, capability: "read" | "write") { const identity = await ctx.auth.getUserIdentity(); if (!identity) return undefined; const workspace = await ctx.db.get(workspaceId); if (!workspace || workspace.status !== "active") return undefined; const membership = await ctx.db.query("memberships").withIndex("by_workspace_subject", (q: any) => q.eq("workspaceId", workspaceId).eq("subject", identity.subject)).unique(); return authorizeTenantAccess(membership as Membership | undefined, workspaceId, capability).allowed ? { identity, membership } : undefined; }
export const recordHealth = mutation({ args: { workspaceId: v.id("workspaces"), component: v.union(v.literal("database"), v.literal("backup"), v.literal("provider")), healthy: v.boolean(), checkedAt: v.number(), detail: v.string() }, handler: async (ctx, args) => { const principal = await access(ctx, args.workspaceId, "write"); if (!principal || !["admin", "editor"].includes(principal.membership.role)) return { outcome: "denied" as const, code: "OPERATOR_REQUIRED" }; const safeDetail = redactAuditMetadata({ detail: args.detail }).detail; const prior = await ctx.db.query("operationalHealth").withIndex("by_workspace_component", (q) => q.eq("workspaceId", args.workspaceId).eq("component", args.component)).unique(); if (prior) await ctx.db.patch(prior._id, { ...args, detail: safeDetail }); else await ctx.db.insert("operationalHealth", { ...args, detail: safeDetail }); const all = await ctx.db.query("operationalHealth").withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId)).collect(); const readiness = evaluateReadiness(Object.fromEntries(all.map((row) => [row.component, row.healthy]))); await ctx.db.insert("operationalAuditEvents", { workspaceId: args.workspaceId, actorId: principal.identity.subject, action: "ops.recordHealth", metadata: `detail=${safeDetail}`, createdAt: args.checkedAt }); return { outcome: "accepted" as const, mode: readiness.mode, ready: readiness.ready }; } });
export const readiness = query({ args: { workspaceId: v.id("workspaces") }, handler: async (ctx, args) => { if (!await access(ctx, args.workspaceId, "read")) return { outcome: "denied" as const, code: "TENANT_DENIED" }; const all = await ctx.db.query("operationalHealth").withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId)).collect(); return evaluateReadiness(Object.fromEntries(all.map((row) => [row.component, row.healthy]))); } });

export const recordSloOutcome = mutation({ args: { workspaceId: v.id("workspaces"), availabilityTarget: v.number(), errorBudgetEvents: v.number(), outcome: v.union(v.literal("success"), v.literal("error")), recordedAt: v.number() }, handler: async (ctx, args) => {
  const principal = await access(ctx, args.workspaceId, "write"); if (!principal || !["admin", "editor"].includes(principal.membership.role)) return { outcome: "denied" as const, code: "OPERATOR_REQUIRED" };
  if (args.availabilityTarget <= 0 || args.availabilityTarget > 1 || !Number.isSafeInteger(args.errorBudgetEvents) || args.errorBudgetEvents < 0) throw new Error("SLO_INVALID");
  const prior = await ctx.db.query("operationalSlo").withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId)).unique();
  if (prior && (prior.availabilityTarget !== args.availabilityTarget || prior.errorBudgetEvents !== args.errorBudgetEvents)) return { outcome: "denied" as const, code: "AVAILABILITY_TARGET_MISMATCH" };
  const remainingErrorBudget = Math.max(0, (prior?.remainingErrorBudget ?? args.errorBudgetEvents) - (args.outcome === "error" ? 1 : 0));
  const errors = (prior?.errors ?? 0) + (args.outcome === "error" ? 1 : 0); const successes = (prior?.successes ?? 0) + (args.outcome === "success" ? 1 : 0);
  const observedAvailability = successes + errors === 0 ? 1 : successes / (successes + errors);
  const mode = remainingErrorBudget === 0 || observedAvailability < args.availabilityTarget ? "read_only" as const : args.outcome === "error" ? "degraded" as const : "normal" as const;
  const state = { workspaceId: args.workspaceId, availabilityTarget: args.availabilityTarget, errorBudgetEvents: args.errorBudgetEvents, remainingErrorBudget, successes, errors, mode, updatedAt: args.recordedAt };
  if (prior) await ctx.db.patch(prior._id, state); else await ctx.db.insert("operationalSlo", state);
  await ctx.db.insert("operationalAuditEvents", { workspaceId: args.workspaceId, actorId: principal.identity.subject, action: "ops.recordSloOutcome", metadata: `outcome=${args.outcome}`, createdAt: args.recordedAt });
  return { outcome: "accepted" as const, remainingErrorBudget, mode };
} });
export const sloState = query({ args: { workspaceId: v.id("workspaces") }, handler: async (ctx, args) => { if (!await access(ctx, args.workspaceId, "read")) return { outcome: "denied" as const, code: "TENANT_DENIED" }; const state = await ctx.db.query("operationalSlo").withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId)).unique(); return state ?? { availabilityTarget: 1, errorBudgetEvents: 0, remainingErrorBudget: 0, mode: "read_only" as const }; } });

function backupChecksum(value: unknown) { const bytes = JSON.stringify(value); let hash = 2166136261; for (const character of bytes) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619); return `fnv1a-${(hash >>> 0).toString(16)}`; }
export const recordBackupExport = mutation({ args: { workspaceId: v.id("workspaces"), backupKey: v.string(), exportedAt: v.number(), latestWriteAt: v.number(), maxRpoMs: v.number(), retentionUntil: v.number(), retainSnapshots: v.optional(v.number()) }, handler: async (ctx, args) => {
  const principal = await access(ctx, args.workspaceId, "write"); if (!principal || !["admin", "editor"].includes(principal.membership.role)) return { outcome: "denied" as const, code: "OPERATOR_REQUIRED" };
  const rpoMs = args.exportedAt - args.latestWriteAt;
  if (!args.backupKey || args.retentionUntil < args.exportedAt || rpoMs < 0 || rpoMs > args.maxRpoMs) return { outcome: "denied" as const, code: "RPO_VIOLATION" };
  const existing = await ctx.db.query("backupRecords").withIndex("by_workspace_key", (q) => q.eq("workspaceId", args.workspaceId).eq("backupKey", args.backupKey)).unique();
  if (existing) return { outcome: "accepted" as const, replayed: true, backupId: existing._id };
  const checksum = backupChecksum({ workspaceId: String(args.workspaceId), backupKey: args.backupKey, exportedAt: args.exportedAt, latestWriteAt: args.latestWriteAt });
  const backupId = await ctx.db.insert("backupRecords", { workspaceId: args.workspaceId, backupKey: args.backupKey, checksum, exportedAt: args.exportedAt, latestWriteAt: args.latestWriteAt, rpoMs, retentionUntil: args.retentionUntil, status: "exported" });
  if (args.retainSnapshots !== undefined) {
    if (!Number.isSafeInteger(args.retainSnapshots) || args.retainSnapshots < 1) throw new Error("BACKUP_RETENTION_INVALID");
    const retained = (await ctx.db.query("backupRecords").withIndex("by_workspace_key", (q) => q.eq("workspaceId", args.workspaceId)).collect())
      .filter((backup) => backup.status !== "deleted")
      .sort((left, right) => left.exportedAt - right.exportedAt || String(left._id).localeCompare(String(right._id)));
    for (const expired of retained.slice(0, Math.max(0, retained.length - args.retainSnapshots))) await ctx.db.patch(expired._id, { status: "deleted", deletedAt: args.exportedAt });
  }
  return { outcome: "accepted" as const, replayed: false, backupId, rpoMs, checksum };
} });

export const authorizeRestore = mutation({ args: { workspaceId: v.id("workspaces"), backupKey: v.string(), checksum: v.string(), startedAt: v.number(), completedAt: v.number(), maxRtoMs: v.number() }, handler: async (ctx, args) => {
  const principal = await access(ctx, args.workspaceId, "write"); if (!principal || principal.membership.role !== "admin") return { outcome: "denied" as const, code: "RESTORE_AUTH_REQUIRED" };
  const backup = await ctx.db.query("backupRecords").withIndex("by_workspace_key", (q) => q.eq("workspaceId", args.workspaceId).eq("backupKey", args.backupKey)).unique();
  const rtoMs = args.completedAt - args.startedAt;
  if (!backup || backup.status === "deleted" || backup.retentionUntil < args.completedAt || backup.checksum !== args.checksum || rtoMs < 0 || rtoMs > args.maxRtoMs) return { outcome: "denied" as const, code: "RESTORE_VERIFICATION_FAILED" };
  await ctx.db.patch(backup._id, { status: "restored", rtoMs }); return { outcome: "accepted" as const, rpoMs: backup.rpoMs, rtoMs };
} });

export const propagateTenantDeletion = mutation({ args: { workspaceId: v.id("workspaces"), deletedAt: v.number() }, handler: async (ctx, args) => {
  const principal = await access(ctx, args.workspaceId, "write"); if (!principal || principal.membership.role !== "admin") return { outcome: "denied" as const, code: "OPERATOR_REQUIRED" };
  const backups = await ctx.db.query("backupRecords").withIndex("by_workspace_key", (q) => q.eq("workspaceId", args.workspaceId)).collect();
  for (const backup of backups) await ctx.db.patch(backup._id, { status: "deleted", deletedAt: args.deletedAt });
  return { outcome: "accepted" as const, deletedBackups: backups.length };
} });
