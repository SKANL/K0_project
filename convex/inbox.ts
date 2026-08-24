import { internalMutation } from "./_generated/server.js";
import { v } from "convex/values";

export const record = internalMutation({
  args: { workspaceId: v.id("workspaces"), idempotencyKey: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("inbox").withIndex("by_workspace_key", (q) => q.eq("workspaceId", args.workspaceId).eq("idempotencyKey", args.idempotencyKey)).unique();
    if (existing) return { status: existing.status };
    await ctx.db.insert("inbox", { ...args, status: "accepted" });
    return { status: "accepted" as const };
  }
});
