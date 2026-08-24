export type BillingRequest = Readonly<{ tenantId: string; idempotencyKey: string; amountMicros: number; currency: string; provider: string }>;
export type BillingResult = Readonly<{ status: "settled" | "unknown" | "rejected"; providerReference: string; replayed: boolean }>;
type ProviderResult = Omit<BillingResult, "replayed">;
export type PaymentFingerprint = Readonly<{ tenantId: string; amountMicros: number; currency: string; provider: string }>;
export type PaymentLease = Readonly<{ owner: string; claimedAt: number; leaseMs: number }>;
export type DurablePaymentClaim = Readonly<{ idempotencyKey: string; fingerprint: PaymentFingerprint; lease: PaymentLease }>;
export type BillingProvider = Readonly<{
  charge(request: BillingRequest): Promise<ProviderResult>;
  reconcile(request: BillingRequest): Promise<ProviderResult>;
}>;
export type DurablePaymentClaimPort = Readonly<{
  claim(request: DurablePaymentClaim, operation: "charge" | "reconcile"): Promise<{ execute: true; fence: number } | { execute: false; fence: number; result: ProviderResult }>;
  settle(request: DurablePaymentClaim, fence: number, result: ProviderResult): Promise<ProviderResult>;
}>;

type ConvexClaimResponse = Readonly<{ outcome: "accepted" | "denied"; code?: string; claimed?: boolean; fence?: number; status?: "pending" | ProviderResult["status"] }>;
type ConvexSettleResponse = Readonly<{ outcome: "accepted" | "denied"; code?: string; replayed?: boolean; status?: "pending" | ProviderResult["status"] }>;
export type ConvexPaymentClaimHandlers = Readonly<{
  claimPayment(input: Readonly<{ idempotencyKey: string; amountMicros: number; currency: string; provider: string; claimOwner: string; claimedAt: number; leaseMs: number }>): Promise<ConvexClaimResponse>;
  reconcilePayment(input: Readonly<{ idempotencyKey: string; fence: number; status: ProviderResult["status"]; providerReference: string; reconciledAt: number }>): Promise<ConvexSettleResponse>;
}>;

function validate(request: BillingRequest) {
  if (!request.tenantId || !request.idempotencyKey || !request.provider || !Number.isSafeInteger(request.amountMicros) || request.amountMicros < 0 || request.currency.trim().toUpperCase() !== "USD") throw new RangeError("BILLING_REQUEST_INVALID");
}

function canonicalFingerprint(request: BillingRequest): PaymentFingerprint {
  return Object.freeze({ tenantId: request.tenantId.trim(), amountMicros: request.amountMicros, currency: request.currency.trim().toUpperCase(), provider: request.provider.trim().toLowerCase() });
}

function claimFor(request: BillingRequest, options: Required<BillingServiceOptions>): DurablePaymentClaim {
  return Object.freeze({ idempotencyKey: request.idempotencyKey.trim(), fingerprint: canonicalFingerprint(request), lease: Object.freeze({ owner: options.claimOwner, claimedAt: options.now(), leaseMs: options.leaseMs }) });
}

export type BillingServiceOptions = Readonly<{ claimOwner?: string; now?: () => number; leaseMs?: number }>;
const defaultOptions: Required<BillingServiceOptions> = Object.freeze({ claimOwner: "billing-service", now: Date.now, leaseMs: 30_000 });

/** Provider execution is permitted only by a durable, canonical tenant-scoped claim and its fence. */
export function createBillingService(provider: BillingProvider, claims: DurablePaymentClaimPort, options: BillingServiceOptions = {}) {
  const claimOptions = { ...defaultOptions, ...options };
  const execute = async (request: BillingRequest, operation: "charge" | "reconcile"): Promise<BillingResult> => {
    validate(request);
    const paymentClaim = claimFor(request, claimOptions);
    const claim = await claims.claim(paymentClaim, operation);
    if (!claim.execute) return { ...claim.result, replayed: true };
    const result = operation === "charge" ? await provider.charge(request) : await provider.reconcile(request);
    return { ...(await claims.settle(paymentClaim, claim.fence, result)), replayed: false };
  };
  return Object.freeze({ charge: (request: BillingRequest) => execute(request, "charge"), reconcile: (request: BillingRequest) => execute(request, "reconcile") });
}

/** Adapts durable Convex claim/reconcile handlers; it deliberately owns no receipt state. */
export function createConvexPaymentClaimPort(handlers: ConvexPaymentClaimHandlers, options: Readonly<{ tenantId: string; claimOwner: string; now: () => number; leaseMs: number }>): DurablePaymentClaimPort {
  return Object.freeze({
    claim: async (paymentClaim, operation) => {
      if (paymentClaim.fingerprint.tenantId !== options.tenantId) throw new Error("TENANT_DENIED");
      const result = await handlers.claimPayment({ idempotencyKey: paymentClaim.idempotencyKey, amountMicros: paymentClaim.fingerprint.amountMicros, currency: paymentClaim.fingerprint.currency, provider: paymentClaim.fingerprint.provider, claimOwner: paymentClaim.lease.owner, claimedAt: paymentClaim.lease.claimedAt, leaseMs: paymentClaim.lease.leaseMs });
      if (result.outcome === "denied") throw new Error(result.code ?? "BILLING_CLAIM_DENIED");
      if (result.claimed) return { execute: true as const, fence: result.fence! };
      if (result.status === "pending") return { execute: false as const, fence: result.fence!, result: { status: "unknown" as const, providerReference: "pending" } };
      if (operation === "reconcile" && result.status === "unknown") return { execute: true as const, fence: result.fence! };
      return { execute: false as const, fence: result.fence!, result: { status: result.status!, providerReference: "durable-replay" } };
    },
    settle: async (paymentClaim, fence, result) => {
      if (paymentClaim.fingerprint.tenantId !== options.tenantId) throw new Error("TENANT_DENIED");
      const settled = await handlers.reconcilePayment({ idempotencyKey: paymentClaim.idempotencyKey, fence, status: result.status, providerReference: result.providerReference, reconciledAt: options.now() });
      if (settled.outcome === "denied") throw new Error(settled.code ?? "BILLING_FENCE_DENIED");
      return { status: settled.status === "pending" || !settled.status ? result.status : settled.status, providerReference: result.providerReference };
    }
  });
}
