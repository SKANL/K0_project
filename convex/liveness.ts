import { internalMutation } from "./_generated/server.js";
import { v } from "convex/values";

export const heartbeat = internalMutation({
  args: { workspaceId: v.id("workspaces"), workerKey: v.string(), owner: v.string(), now: v.number(), leaseMs: v.number() },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("workerLeases").withIndex("by_workspace_key", (q) => q.eq("workspaceId", args.workspaceId).eq("workerKey", args.workerKey)).unique();
    if (existing?.expiresAt === Number.MAX_SAFE_INTEGER) throw new Error("LEASE_POISON_QUARANTINED");
    if (existing && existing.expiresAt > args.now && existing.owner !== args.owner) throw new Error("LEASE_HELD");
    const fence = existing ? existing.fence + (existing.owner === args.owner ? 0 : 1) : 1;
    if (existing) await ctx.db.patch(existing._id, { owner: args.owner, fence, expiresAt: args.now + args.leaseMs }); else await ctx.db.insert("workerLeases", { workspaceId: args.workspaceId, workerKey: args.workerKey, owner: args.owner, fence, expiresAt: args.now + args.leaseMs, recoveryCount: 0 });
    return { fence };
  },
});

export const assertFence = internalMutation({
  args: { workspaceId: v.id("workspaces"), workerKey: v.string(), owner: v.string(), fence: v.number(), now: v.number() },
  handler: async (ctx, args) => { const lease = await ctx.db.query("workerLeases").withIndex("by_workspace_key", (q) => q.eq("workspaceId", args.workspaceId).eq("workerKey", args.workerKey)).unique(); return lease && lease.owner === args.owner && lease.fence === args.fence && lease.expiresAt > args.now ? { ok: true as const } : { ok: false as const, code: "FENCE_REJECTED" as const }; },
});

export const recoverExpired = internalMutation({
  args: { workspaceId: v.id("workspaces"), owner: v.string(), now: v.number(), poisonThreshold: v.number() },
  handler: async (ctx, args) => {
    const leases = await ctx.db.query("workerLeases").filter((q) => q.and(q.eq(q.field("workspaceId"), args.workspaceId), q.lt(q.field("expiresAt"), args.now))).collect(); let recovered = 0; let quarantined = 0;
    for (const lease of leases) { const recoveryCount = lease.recoveryCount + 1; if (recoveryCount >= args.poisonThreshold) { await ctx.db.patch(lease._id, { recoveryCount, expiresAt: Number.MAX_SAFE_INTEGER }); await ctx.db.insert("automationAlerts", { workspaceId: args.workspaceId, source: lease.workerKey, code: "LEASE_POISON_QUARANTINED", createdAt: args.now, diagnostics: `Lease exceeded ${args.poisonThreshold} recovery attempts` }); quarantined += 1; } else { await ctx.db.patch(lease._id, { owner: args.owner, fence: lease.fence + 1, expiresAt: args.now + 1_000, recoveryCount }); recovered += 1; } }
    return { recovered, quarantined };
  },
});
