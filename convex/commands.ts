import { mutation } from "./_generated/server.js";
import { v } from "convex/values";
import { authorizeTenantAccess, type Membership } from "../packages/contracts/src/foundation.js";
import { redactMetadata } from "./audit.js";
import { nextVersion } from "./state.js";

type Command = { id: string; workspaceId: string; expectedVersion: number; currentVersion: number; capability: string };

export function buildAuditEvent(input: { commandId: string; workspaceId: string; actorId: string; decision: "accepted" | "denied" | "conflict"; metadata: Record<string, string> }) {
  return { ...input, metadata: redactMetadata(input.metadata), immutable: true };
}

export function decideCommand(input: { actor: Membership | undefined; command: Command }) {
  const authz = authorizeTenantAccess(input.actor, input.command.workspaceId, "write");
  if (!authz.allowed) return { outcome: "denied" as const, code: authz.code, effectAllowed: false, audit: buildAuditEvent({ commandId: input.command.id, workspaceId: input.command.workspaceId, actorId: "unknown", decision: "denied", metadata: {} }) };
  if (input.command.expectedVersion !== input.command.currentVersion) return { outcome: "conflict" as const, code: "OCC_CONFLICT", effectAllowed: false };
  return { outcome: "accepted" as const, effectAllowed: true, nextVersion: nextVersion(input.command.currentVersion) };
}

const commandArgs = { workspaceId: v.id("workspaces"), idempotencyKey: v.string(), expectedVersion: v.number(), capability: v.string() };

/** Identity is intentionally derived from Convex auth, never client input. */
export const execute = mutation({
  args: commandArgs,
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("AUTH_REQUIRED");
    const existing = await ctx.db.query("commands").withIndex("by_workspace_key", (q) => q.eq("workspaceId", args.workspaceId).eq("idempotencyKey", args.idempotencyKey)).unique();
    if (existing) return { outcome: existing.outcome, code: existing.code, effectAllowed: existing.effectAllowed, nextVersion: existing.nextVersion };

    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace) throw new Error("WORKSPACE_NOT_FOUND");
    const membership = await ctx.db.query("memberships").withIndex("by_workspace_subject", (q) => q.eq("workspaceId", args.workspaceId).eq("subject", identity.subject)).unique()
      ?? await ctx.db.query("memberships").withIndex("by_subject", (q) => q.eq("subject", identity.subject)).first();
    const authorization = authorizeTenantAccess(membership ? membership as Membership : undefined, args.workspaceId, "write");
    const outcome = !authorization.allowed ? "denied" as const : args.expectedVersion !== workspace.version ? "conflict" as const : "accepted" as const;
    const code = outcome === "accepted" ? undefined : outcome === "conflict" ? "OCC_CONFLICT" : !authorization.allowed ? authorization.code : "POLICY_DENIED";
    const next = outcome === "accepted" ? nextVersion(workspace.version) : workspace.version;
    const commandId = `${identity.subject}:${args.idempotencyKey}`;

    await ctx.db.insert("commands", { ...args, commandId, actorId: identity.subject, outcome, code, effectAllowed: outcome === "accepted", nextVersion: next });
    await ctx.db.insert("auditEvents", { workspaceId: args.workspaceId, commandId, decision: outcome, immutable: true, actorId: identity.subject });
    if (outcome !== "accepted") return { outcome, code, effectAllowed: false, nextVersion: next };
    await ctx.db.patch(args.workspaceId, { version: next });
    await ctx.db.insert("outbox", { workspaceId: args.workspaceId, idempotencyKey: args.idempotencyKey, status: "pending", fence: 0, leaseExpiresAt: 0 });
    return { outcome, effectAllowed: true, nextVersion: next };
  }
});
