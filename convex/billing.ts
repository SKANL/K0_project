import { mutation } from "./_generated/server.js";
import { v } from "convex/values";
import { authorizeTenantAccess, type Membership } from "../packages/contracts/src/foundation.js";

async function access(ctx: any, workspaceId: any) {
  const identity = await ctx.auth.getUserIdentity(); if (!identity) return { allowed: false as const, code: "AUTH_REQUIRED" };
  const workspace = await ctx.db.get(workspaceId); if (!workspace || workspace.status !== "active") return { allowed: false as const, code: "TENANT_DENIED" };
  const membership = await ctx.db.query("memberships").withIndex("by_workspace_subject", (q: any) => q.eq("workspaceId", workspaceId).eq("subject", identity.subject)).unique() ?? await ctx.db.query("memberships").withIndex("by_subject", (q: any) => q.eq("subject", identity.subject)).first();
  const decision = authorizeTenantAccess(membership as Membership | undefined, workspaceId, "write");
  return decision.allowed ? { allowed: true as const, actorId: identity.subject } : { allowed: false as const, code: "TENANT_DENIED" };
}

function fingerprint(input: { workspaceId: unknown; idempotencyKey: string; amountMicros: number; currency: string; provider: string }) {
  const canonical = [String(input.workspaceId), input.idempotencyKey.trim(), String(input.amountMicros), input.currency.trim().toUpperCase(), input.provider.trim().toLowerCase()].join("\u0000");
  let hash = 2166136261;
  for (const character of canonical) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `fnv1a-${(hash >>> 0).toString(16)}`;
}

export const setEntitlement = mutation({ args: { workspaceId: v.id("workspaces"), plan: v.string(), usageLimit: v.number(), active: v.boolean() }, handler: async (ctx, args) => {
  const permitted = await access(ctx, args.workspaceId); if (!permitted.allowed) return { outcome: "denied" as const, code: permitted.code };
  if (!Number.isSafeInteger(args.usageLimit) || args.usageLimit < 0) throw new Error("USAGE_LIMIT_INVALID");
  const existing = await ctx.db.query("commercialEntitlements").withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId)).unique();
  if (existing) await ctx.db.patch(existing._id, { plan: args.plan, usageLimit: args.usageLimit, active: args.active, updatedAt: Date.now() }); else await ctx.db.insert("commercialEntitlements", { ...args, consumedUnits: 0, updatedAt: Date.now() });
  return { outcome: "accepted" as const };
} });

export const recordUsage = mutation({ args: { workspaceId: v.id("workspaces"), idempotencyKey: v.string(), units: v.number(), recordedAt: v.number() }, handler: async (ctx, args) => {
  const permitted = await access(ctx, args.workspaceId); if (!permitted.allowed) return { outcome: "denied" as const, code: permitted.code };
  if (!args.idempotencyKey || !Number.isSafeInteger(args.units) || args.units <= 0) throw new Error("USAGE_INVALID");
  const existing = await ctx.db.query("usageLedger").withIndex("by_workspace_key", (q) => q.eq("workspaceId", args.workspaceId).eq("idempotencyKey", args.idempotencyKey)).unique();
  if (existing) return { outcome: "accepted" as const, replayed: true, totalUnits: existing.totalUnits };
  const entitlement = await ctx.db.query("commercialEntitlements").withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId)).unique();
  if (!entitlement || !entitlement.active || entitlement.consumedUnits + args.units > entitlement.usageLimit) return { outcome: "denied" as const, code: "ENTITLEMENT_EXHAUSTED" };
  const totalUnits = entitlement.consumedUnits + args.units;
  await ctx.db.insert("usageLedger", { ...args, actorId: permitted.actorId, totalUnits }); await ctx.db.patch(entitlement._id, { consumedUnits: totalUnits, updatedAt: args.recordedAt });
  return { outcome: "accepted" as const, replayed: false, totalUnits };
} });

const receiptStatuses = v.union(v.literal("pending"), v.literal("unknown"), v.literal("settled"), v.literal("rejected"));
/** Atomically reserves a tenant-scoped provider effect before any adapter may call a provider. */
export const claimPayment = mutation({ args: { workspaceId: v.id("workspaces"), idempotencyKey: v.string(), amountMicros: v.number(), currency: v.string(), provider: v.string(), claimOwner: v.string(), claimedAt: v.number(), leaseMs: v.number() }, handler: async (ctx, args) => {
  const permitted = await access(ctx, args.workspaceId); if (!permitted.allowed) return { outcome: "denied" as const, code: permitted.code };
  if (!args.idempotencyKey || !args.claimOwner || !args.provider || !Number.isSafeInteger(args.amountMicros) || args.amountMicros < 0 || args.currency.trim().toUpperCase() !== "USD" || !Number.isSafeInteger(args.leaseMs) || args.leaseMs <= 0) throw new Error("BILLING_REQUEST_INVALID");
  const requestFingerprint = fingerprint(args);
  const existing = await ctx.db.query("billingReceipts").withIndex("by_workspace_key", (q) => q.eq("workspaceId", args.workspaceId).eq("idempotencyKey", args.idempotencyKey)).unique();
  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint) return { outcome: "denied" as const, code: "IDEMPOTENCY_FINGERPRINT_MISMATCH" };
    if (existing.status === "pending" && existing.leaseExpiresAt <= args.claimedAt) {
      const fence = existing.fence + 1;
      await ctx.db.patch(existing._id, { claimOwner: args.claimOwner, claimedAt: args.claimedAt, leaseExpiresAt: args.claimedAt + args.leaseMs, fence });
      await ctx.db.insert("paymentAuditEvents", { workspaceId: args.workspaceId, receiptId: existing._id, actorId: permitted.actorId, action: "billing.reclaim", status: "pending", metadata: "billingFingerprint=[REDACTED]", createdAt: args.claimedAt });
      return { outcome: "accepted" as const, claimed: true, receiptId: existing._id, status: existing.status, fence };
    }
    return { outcome: "accepted" as const, claimed: false, receiptId: existing._id, status: existing.status, fence: existing.fence };
  }
  const { leaseMs: _leaseMs, ...receipt } = args;
  const receiptId = await ctx.db.insert("billingReceipts", { ...receipt, currency: args.currency.trim().toUpperCase(), provider: args.provider.trim().toLowerCase(), requestFingerprint, status: "pending", leaseExpiresAt: args.claimedAt + args.leaseMs, fence: 1 });
  await ctx.db.insert("paymentAuditEvents", { workspaceId: args.workspaceId, receiptId, actorId: permitted.actorId, action: "billing.claim", status: "pending", metadata: "billingFingerprint=[REDACTED]", createdAt: args.claimedAt });
  return { outcome: "accepted" as const, claimed: true, receiptId, status: "pending" as const, fence: 1 };
} });

/** Reconciliation only advances a receipt; stale fences and state regressions fail closed. */
export const reconcilePayment = mutation({ args: { workspaceId: v.id("workspaces"), idempotencyKey: v.string(), fence: v.number(), status: receiptStatuses, providerReference: v.string(), reconciledAt: v.number() }, handler: async (ctx, args) => {
  const permitted = await access(ctx, args.workspaceId); if (!permitted.allowed) return { outcome: "denied" as const, code: permitted.code };
  const receipt = await ctx.db.query("billingReceipts").withIndex("by_workspace_key", (q) => q.eq("workspaceId", args.workspaceId).eq("idempotencyKey", args.idempotencyKey)).unique();
  if (!receipt || receipt.fence !== args.fence) return { outcome: "denied" as const, code: "BILLING_FENCE_DENIED" };
  const terminal = receipt.status === "settled" || receipt.status === "rejected";
  if (terminal && receipt.status !== args.status) return { outcome: "accepted" as const, replayed: true, status: receipt.status };
  if (args.status === "pending") throw new Error("BILLING_STATE_REGRESSION");
  await ctx.db.patch(receipt._id, { status: args.status, providerReference: args.providerReference, reconciledAt: args.reconciledAt });
  await ctx.db.insert("paymentAuditEvents", { workspaceId: args.workspaceId, receiptId: receipt._id, actorId: permitted.actorId, action: "billing.reconcile", status: args.status, metadata: "providerReference=[REDACTED]", createdAt: args.reconciledAt });
  return { outcome: "accepted" as const, replayed: false, status: args.status };
} });
