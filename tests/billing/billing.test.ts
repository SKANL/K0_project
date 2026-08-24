import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "../../convex/_generated/api.js";
import schema from "../../convex/schema.js";
import { createBillingService, createConvexPaymentClaimPort } from "../../packages/adapters/src/billing/index.js";

const modules = import.meta.glob("../../convex/**/*.ts");

describe("commercial billing", () => {
  it("charges a usage key once and reconciles a provider timeout without a second charge", async () => {
    const calls: string[] = [];
    const service = createBillingService({
      charge: async (request) => { calls.push(request.idempotencyKey); return { status: "unknown", providerReference: "charge-1" }; },
      reconcile: async () => ({ status: "settled", providerReference: "charge-1" })
    }, createFakeDurablePaymentClaimPort());
    const request = { tenantId: "tenant-a", idempotencyKey: "usage-1", amountMicros: 25, currency: "USD", provider: "stripe" };
    const first = await service.charge(request);
    const replay = await service.charge(request);
    expect(first).toEqual({ status: "unknown", providerReference: "charge-1", replayed: false });
    expect(replay).toEqual({ status: "unknown", providerReference: "charge-1", replayed: true });
    expect(await service.reconcile(request)).toEqual({ status: "settled", providerReference: "charge-1", replayed: false });
    expect(calls).toEqual(["usage-1"]);
  });

  it("shares an in-flight claim across concurrent controllers and never regresses a settled receipt", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const service = createBillingService({
      charge: async (request) => { calls.push(request.idempotencyKey); await pending; return { status: "unknown", providerReference: "charge-2" }; },
      reconcile: async () => ({ status: "settled", providerReference: "charge-2" })
    }, createFakeDurablePaymentClaimPort());
    const request = { tenantId: "tenant-a", idempotencyKey: "usage-2", amountMicros: 25, currency: "USD" as const, provider: "stripe" };
    const first = service.charge(request);
    const concurrent = service.charge(request);
    release();
    expect(await first).toMatchObject({ status: "unknown", replayed: false });
    expect(await concurrent).toMatchObject({ status: "unknown", replayed: true });
    expect(await service.reconcile(request)).toMatchObject({ status: "settled", replayed: false });
    expect(await service.reconcile(request)).toMatchObject({ status: "settled", replayed: true });
    expect(calls).toEqual(["usage-2"]);
  });

  it("uses a tenant-scoped durable ledger and rejects another tenant or an exhausted entitlement", async () => {
    const t = convexTest(schema, modules);
    const workspaceA = await t.run((ctx) => ctx.db.insert("workspaces", { slug: "billing-a", status: "active", version: 0 }));
    const workspaceB = await t.run((ctx) => ctx.db.insert("workspaces", { slug: "billing-b", status: "active", version: 0 }));
    await t.run((ctx) => ctx.db.insert("memberships", { workspaceId: workspaceA, subject: "admin-a", role: "admin", status: "active" }));
    const actor = t.withIdentity({ subject: "admin-a" });
    await actor.mutation(api.billing.setEntitlement, { workspaceId: workspaceA, plan: "pro", usageLimit: 5, active: true });
    expect(await actor.mutation(api.billing.recordUsage, { workspaceId: workspaceA, idempotencyKey: "meter-1", units: 3, recordedAt: 10 })).toMatchObject({ outcome: "accepted", totalUnits: 3 });
    expect(await actor.mutation(api.billing.recordUsage, { workspaceId: workspaceA, idempotencyKey: "meter-1", units: 3, recordedAt: 10 })).toMatchObject({ outcome: "accepted", replayed: true, totalUnits: 3 });
    expect(await actor.mutation(api.billing.recordUsage, { workspaceId: workspaceA, idempotencyKey: "meter-2", units: 3, recordedAt: 11 })).toMatchObject({ outcome: "denied", code: "ENTITLEMENT_EXHAUSTED" });
    expect(await actor.mutation(api.billing.recordUsage, { workspaceId: workspaceB, idempotencyKey: "cross-tenant", units: 1, recordedAt: 12 })).toMatchObject({ outcome: "denied", code: "TENANT_DENIED" });
    expect(await t.run((ctx) => ctx.db.query("usageLedger").collect())).toHaveLength(1);
  });

  it("binds a durable payment replay to a canonical provider fingerprint and rejects stale fences", async () => {
    const t = convexTest(schema, modules);
    const workspace = await t.run((ctx) => ctx.db.insert("workspaces", { slug: "payment-a", status: "active", version: 0 }));
    await t.run((ctx) => ctx.db.insert("memberships", { workspaceId: workspace, subject: "admin-a", role: "admin", status: "active" }));
    const actor = t.withIdentity({ subject: "admin-a" });
    const input = { workspaceId: workspace, idempotencyKey: "receipt-1", amountMicros: 99, currency: "USD" as const, provider: "stripe", claimOwner: "controller-a", claimedAt: 20, leaseMs: 10 };
    const [first, replay] = await Promise.all([
      actor.mutation(api.billing.claimPayment, input),
      actor.mutation(api.billing.claimPayment, { ...input, claimOwner: "controller-b", claimedAt: 21 }),
    ]);
    expect(first).toMatchObject({ outcome: "accepted", claimed: true, status: "pending", fence: 1 });
    expect(replay).toMatchObject({ outcome: "accepted", claimed: false, status: "pending", fence: 1 });
    expect(await actor.mutation(api.billing.claimPayment, { ...input, amountMicros: 100, claimedAt: 21 })).toMatchObject({ outcome: "denied", code: "IDEMPOTENCY_FINGERPRINT_MISMATCH" });
    const reacquired = await actor.mutation(api.billing.claimPayment, { ...input, claimOwner: "controller-b", claimedAt: 31 });
    expect(reacquired).toMatchObject({ claimed: true, fence: 2 });
    expect(await actor.mutation(api.billing.reconcilePayment, { workspaceId: workspace, idempotencyKey: "receipt-1", fence: 1, status: "settled", providerReference: "provider-1", reconciledAt: 32 })).toMatchObject({ outcome: "denied", code: "BILLING_FENCE_DENIED" });
    expect(await actor.mutation(api.billing.reconcilePayment, { workspaceId: workspace, idempotencyKey: "receipt-1", fence: 2, status: "settled", providerReference: "provider-1", reconciledAt: 33 })).toMatchObject({ replayed: false, status: "settled" });
    const events = await t.run((ctx) => ctx.db.query("paymentAuditEvents").collect());
    expect(events).toHaveLength(3);
    expect(events.every((event) => !event.metadata.includes("99") && !event.metadata.includes("provider-1"))).toBe(true);
    expect(await t.run((ctx) => ctx.db.query("billingReceipts").collect())).toHaveLength(1);
  });
  it("uses a durable fenced claim across service restarts and denies stale settlement", async () => {
    const calls: string[] = [];
    const claims = createFakeDurablePaymentClaimPort();
    const provider = {
      charge: async (request: { idempotencyKey: string }) => { calls.push(request.idempotencyKey); return { status: "settled" as const, providerReference: "safe-charge-1" }; },
      reconcile: async () => ({ status: "settled" as const, providerReference: "safe-charge-1" })
    };
    const request = { tenantId: "tenant-a", idempotencyKey: "restart-claim", amountMicros: 25, currency: "USD", provider: "stripe" };
    expect(await createBillingService(provider, claims).charge(request)).toMatchObject({ replayed: false, status: "settled" });
    expect(await createBillingService(provider, claims).charge(request)).toMatchObject({ replayed: true, status: "settled" });
    expect(calls).toEqual(["restart-claim"]);
    await expect(claims.settle({ idempotencyKey: request.idempotencyKey, fingerprint: { tenantId: request.tenantId }, lease: { owner: "test", claimedAt: 0, leaseMs: 1 } }, 0, { status: "settled", providerReference: "safe-charge-1" })).rejects.toThrow("BILLING_FENCE_DENIED");
  });

  it("replays the same immutable Convex claim across a new service, denies changed details before charge, and rejects stale fences", async () => {
    const t = convexTest(schema, modules);
    const workspace = await t.run((ctx) => ctx.db.insert("workspaces", { slug: "adapter-payment", status: "active", version: 0 }));
    await t.run((ctx) => ctx.db.insert("memberships", { workspaceId: workspace, subject: "admin-a", role: "admin", status: "active" }));
    const actor = t.withIdentity({ subject: "admin-a" });
    const claims = createConvexPaymentClaimPort({
      claimPayment: (input) => actor.mutation(api.billing.claimPayment, { workspaceId: workspace, ...input }),
      reconcilePayment: (input) => actor.mutation(api.billing.reconcilePayment, { workspaceId: workspace, ...input }),
    }, { tenantId: String(workspace), claimOwner: "service-a", now: () => 100, leaseMs: 10 });
    const calls: string[] = [];
    const provider = {
      charge: async (request: { idempotencyKey: string }) => { calls.push(request.idempotencyKey); return { status: "settled" as const, providerReference: "convex-charge-1" }; },
      reconcile: async () => ({ status: "settled" as const, providerReference: "convex-charge-1" }),
    };
    const request = { tenantId: String(workspace), idempotencyKey: "convex-restart", amountMicros: 25, currency: "USD", provider: "stripe" };
    expect(await createBillingService(provider, claims).charge(request)).toMatchObject({ status: "settled", replayed: false });
    expect(await createBillingService(provider, claims).charge(request)).toMatchObject({ status: "settled", replayed: true });
    await expect(createBillingService(provider, claims).charge({ ...request, amountMicros: 26 })).rejects.toThrow("IDEMPOTENCY_FINGERPRINT_MISMATCH");
    expect(calls).toEqual(["convex-restart"]);
    await expect(actor.mutation(api.billing.reconcilePayment, { workspaceId: workspace, idempotencyKey: request.idempotencyKey, fence: 0, status: "settled", providerReference: "late", reconciledAt: 101 })).resolves.toMatchObject({ outcome: "denied", code: "BILLING_FENCE_DENIED" });
  });
});

type SafeResult = { status: "settled" | "unknown" | "rejected"; providerReference: string };
function createFakeDurablePaymentClaimPort() {
  const receipts = new Map<string, { fence: number; fingerprint: string; result?: SafeResult }>();
  const key = (request: { fingerprint: { tenantId: string }; idempotencyKey: string }) => `${request.fingerprint.tenantId}\u0000${request.idempotencyKey}`;
  const fingerprint = (request: { fingerprint: object }) => JSON.stringify(request.fingerprint);
  return {
    claim: async (request: { fingerprint: { tenantId: string }; idempotencyKey: string }, operation: "charge" | "reconcile") => {
      const existing = receipts.get(key(request));
      if (existing && existing.fingerprint !== fingerprint(request)) throw new Error("IDEMPOTENCY_FINGERPRINT_MISMATCH");
      if (existing?.result && (existing.result.status !== "unknown" || operation === "charge")) return { execute: false as const, fence: existing.fence, result: existing.result };
      if (existing?.result && operation === "reconcile") return { execute: true as const, fence: existing.fence };
      if (existing) return { execute: false as const, fence: existing.fence, result: { status: "unknown" as const, providerReference: "pending" } };
      const receipt = { fence: 1, fingerprint: fingerprint(request) }; receipts.set(key(request), receipt);
      return { execute: true as const, fence: receipt.fence };
    },
    settle: async (request: { fingerprint: { tenantId: string }; idempotencyKey: string; lease: object }, fence: number, result: SafeResult) => {
      const receipt = receipts.get(key(request));
      if (!receipt || receipt.fence !== fence) throw new Error("BILLING_FENCE_DENIED");
      receipt.result = result;
      return result;
    }
  };
}
