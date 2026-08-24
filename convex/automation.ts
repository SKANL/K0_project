import { internalMutation, type MutationCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import { v } from "convex/values";

export type DstPolicy = "first" | "second" | "skip";

function localParts(timestamp: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(timestamp));
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

export function resolveLocalSchedule(input: { local: string; timezone: string; dst: DstPolicy }): { kind: "scheduled"; runAt: number } | { kind: "skipped"; runAt: null } {
  const localMs = Date.parse(`${input.local}:00Z`);
  if (Number.isNaN(localMs)) throw new Error("SCHEDULE_LOCAL_TIME_INVALID");
  const target = input.local.replace("T", " ");
  const candidates: number[] = [];
  for (let candidate = localMs - 15 * 60 * 60_000; candidate <= localMs + 15 * 60 * 60_000; candidate += 60_000) {
    const value = localParts(candidate, input.timezone);
    if (`${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}` === target) candidates.push(candidate);
  }
  if (!candidates.length || (candidates.length > 1 && input.dst === "skip")) return { kind: "skipped", runAt: null };
  return { kind: "scheduled", runAt: candidates[input.dst === "second" ? candidates.length - 1 : 0] }; 
}

export function retryAt(input: { now: number; attempt: number; baseDelayMs: number; maxDelayMs: number }) { return input.now + Math.min(input.maxDelayMs, input.baseDelayMs * 2 ** Math.max(0, input.attempt - 1)); }

async function processWorkspaceBeat(ctx: MutationCtx, args: { workspaceId: Id<"workspaces">; tickKey: string; now: number }) {
  const seen = await ctx.db.query("automationBeats").withIndex("by_workspace_key", (q) => q.eq("workspaceId", args.workspaceId).eq("tickKey", args.tickKey)).unique();
  if (seen) return { duplicate: true as const, planned: 0 };
  await ctx.db.insert("automationBeats", { workspaceId: args.workspaceId, tickKey: args.tickKey, processedAt: args.now });
  const schedules = await ctx.db.query("automationSchedules").filter((q) => q.and(q.eq(q.field("workspaceId"), args.workspaceId), q.eq(q.field("enabled"), true), q.lte(q.field("nextRunAt"), args.now))).collect();
  let planned = 0;
  for (const schedule of schedules) {
    const duplicate = await ctx.db.query("automationRuns").withIndex("by_schedule_planned", (q) => q.eq("scheduleId", schedule._id).eq("plannedFor", schedule.nextRunAt)).unique();
    if (duplicate) continue;
    const prior = await ctx.db.query("automationRuns").withIndex("by_workspace_state_due", (q) => q.eq("workspaceId", args.workspaceId).eq("state", "queued")).collect();
    const state = prior.length >= schedule.quotaLimit ? "manual_review" as const : "queued" as const;
    await ctx.db.insert("automationRuns", { workspaceId: args.workspaceId, scheduleId: schedule._id, plannedFor: schedule.nextRunAt, state, version: 0, attempts: 0, maxAttempts: schedule.maxAttempts, deadlineAt: schedule.deadlineAt, nextAttemptAt: args.now, fence: 0, diagnostics: state === "manual_review" ? "QUOTA_EXCEEDED" : undefined });
    await ctx.db.patch(schedule._id, { nextRunAt: schedule.nextRunAt + 86_400_000, version: schedule.version + 1 });
    planned += 1;
  }
  return { duplicate: false as const, planned };
}

export const createSchedule = internalMutation({
  args: { workspaceId: v.id("workspaces"), scheduleKey: v.string(), timezone: v.string(), nextRunAt: v.number(), version: v.number(), enabled: v.boolean(), maxAttempts: v.number(), deadlineAt: v.number(), quotaLimit: v.number() },
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace || workspace.status !== "active") throw new Error("AUTOMATION_POLICY_DENIED");
    const existing = await ctx.db.query("automationSchedules").withIndex("by_workspace_key", (q) => q.eq("workspaceId", args.workspaceId).eq("scheduleKey", args.scheduleKey)).unique();
    if (existing) throw new Error("SCHEDULE_KEY_EXISTS");
    return ctx.db.insert("automationSchedules", args);
  },
});

export const processBeat = internalMutation({
  args: { workspaceId: v.id("workspaces"), tickKey: v.string(), now: v.number() },
  handler: (ctx, args) => processWorkspaceBeat(ctx, args),
});

export const cronBeat = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const tickKey = `cron-${Math.floor(now / 60_000)}`;
    const workspaces = await ctx.db.query("workspaces").collect();
    const results = await Promise.all(workspaces.filter((workspace) => workspace.status === "active").map((workspace) => processWorkspaceBeat(ctx, { workspaceId: workspace._id, tickKey, now })));
    return { planned: results.reduce((total, result) => total + result.planned, 0) };
  },
});

export const claimDueRun = internalMutation({
  args: { workspaceId: v.id("workspaces"), owner: v.string(), now: v.number(), leaseMs: v.number() },
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace || workspace.status !== "active") return { claimed: false as const, code: "AUTOMATION_POLICY_DENIED" as const };
    const candidates = await ctx.db.query("automationRuns").withIndex("by_workspace_state_due", (q) => q.eq("workspaceId", args.workspaceId).eq("state", "queued").lte("nextAttemptAt", args.now)).collect();
    const expired = candidates.find((candidate) => candidate.deadlineAt < args.now);
    if (expired) {
      await ctx.db.patch(expired._id, { state: "manual_review", version: expired.version + 1, diagnostics: "DEADLINE_EXPIRED" });
      await ctx.db.insert("automationAlerts", { workspaceId: args.workspaceId, source: String(expired._id), code: "DEADLINE_EXPIRED", createdAt: args.now, diagnostics: "Run exceeded its execution deadline before claim" });
      return { claimed: false as const, code: "DEADLINE_EXPIRED" as const };
    }
    const run = candidates.find((candidate) => candidate.deadlineAt >= args.now);
    if (!run) return { claimed: false as const, code: "NO_DUE_WORK" as const };
    const fence = run.fence + 1;
    await ctx.db.patch(run._id, { state: "leased", version: run.version + 1, fence, leaseOwner: args.owner, leaseExpiresAt: args.now + args.leaseMs });
    return { claimed: true as const, runId: run._id, fence };
  },
});

export const cancelRun = internalMutation({
  args: { runId: v.id("automationRuns"), expectedVersion: v.number(), reason: v.string() },
  handler: async (ctx, args) => { const run = await ctx.db.get(args.runId); if (!run) throw new Error("AUTOMATION_RUN_NOT_FOUND"); if (run.version !== args.expectedVersion) throw new Error("OCC_CONFLICT"); await ctx.db.patch(run._id, { state: "cancelled", version: run.version + 1, diagnostics: args.reason }); },
});

export const recordFailure = internalMutation({
  args: { runId: v.id("automationRuns"), expectedVersion: v.number(), now: v.number(), code: v.string() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId); if (!run) throw new Error("AUTOMATION_RUN_NOT_FOUND"); if (run.version !== args.expectedVersion) throw new Error("OCC_CONFLICT");
    const attempts = run.attempts + 1;
    if (attempts >= run.maxAttempts) { await ctx.db.patch(run._id, { state: "manual_review", version: run.version + 1, attempts, failureCode: args.code, diagnostics: "POISON_QUARANTINED" }); await ctx.db.insert("automationAlerts", { workspaceId: run.workspaceId, source: String(run._id), code: "POISON_QUARANTINED", createdAt: args.now, diagnostics: args.code }); return { state: "manual_review" as const, code: "POISON_QUARANTINED" as const }; }
    await ctx.db.patch(run._id, { state: "queued", version: run.version + 1, attempts, failureCode: args.code, nextAttemptAt: retryAt({ now: args.now, attempt: attempts, baseDelayMs: 1_000, maxDelayMs: 60_000 }), leaseOwner: undefined, leaseExpiresAt: undefined });
    return { state: "queued" as const, code: "RETRY_SCHEDULED" as const };
  },
});
