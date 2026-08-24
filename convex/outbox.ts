import { internalMutation } from "./_generated/server.js";
import { v } from "convex/values";

const outboxArgs = { workspaceId: v.id("workspaces"), idempotencyKey: v.string() };

export const claim = internalMutation({
  args: { ...outboxArgs, workerId: v.string(), now: v.number(), leaseMs: v.number() },
  handler: async (ctx, args) => {
    const record = await ctx.db.query("outbox").withIndex("by_workspace_key", (q) => q.eq("workspaceId", args.workspaceId).eq("idempotencyKey", args.idempotencyKey)).unique();
    if (!record) throw new Error("OUTBOX_NOT_FOUND");
    if (record.status === "leased" && record.leaseExpiresAt > args.now) return { acquired: false as const, fence: record.fence };
    const fence = record.fence + 1;
    await ctx.db.patch(record._id, { status: "leased", leaseOwner: args.workerId, leaseExpiresAt: args.now + args.leaseMs, fence });
    return { acquired: true as const, fence };
  }
});

export const verify = internalMutation({
  args: { ...outboxArgs, fence: v.number() },
  handler: async (ctx, args) => {
    const record = await ctx.db.query("outbox").withIndex("by_workspace_key", (q) => q.eq("workspaceId", args.workspaceId).eq("idempotencyKey", args.idempotencyKey)).unique();
    if (!record || record.status !== "leased" || record.fence !== args.fence) throw new Error("OUTBOX_FENCE_DENIED");
    await ctx.db.patch(record._id, { status: "verified" });
    return { status: "verified" as const };
  }
});
