import { describe, expect, it } from "vitest";
import { createInMemoryVault, createReleaseController, createAdapterRegistry, createCommercialLedger, createPrivacyController, createEncryptedBackupCoordinator, createMigrationController, createSetupDiagnostics } from "../../packages/assurance/src/index.js";

describe("commercial assurance controls", () => {
  it("fails closed when the protected vault is unsupported and never returns a secret", () => {
    const vault = createInMemoryVault({ supported: false });
    expect(() => vault.put("tenant-a", "sendblue", "secret")).toThrow("VAULT_UNSUPPORTED");
    expect(vault.get("tenant-a", "sendblue")).toEqual({ status: "unsupported", code: "VAULT_UNSUPPORTED" });
  });

  it("activates only signed, provenance-attested releases and permits verified rollback", () => {
    const releases = createReleaseController({ verify: (value) => value.signature === "valid" && value.provenance === "attested" });
    expect(() => releases.activate({ id: "r1", signature: "bad", provenance: "attested", capabilities: ["browser"] })).toThrow("RELEASE_VERIFICATION_FAILED");
    releases.activate({ id: "r1", signature: "valid", provenance: "attested", capabilities: ["browser"] });
    releases.activate({ id: "r2", signature: "valid", provenance: "attested", capabilities: ["browser", "billing"] });
    expect(releases.rollback("r1")).toEqual({ activeReleaseId: "r1", rollbackOf: "r2" });
  });

  it("requires uniform adapter health, limits, and vault credentials", () => {
    const vault = createInMemoryVault({ supported: true }); vault.put("tenant-a", "sendblue", "secret");
    const registry = createAdapterRegistry(vault);
    expect(() => registry.register({ name: "bad", version: "1", capabilities: [], limits: {}, health: async () => ({ healthy: true }) })).toThrow("ADAPTER_CONTRACT_INVALID");
    registry.register({ name: "sendblue", version: "1", capabilities: ["sms"], limits: { maxRequests: 1 }, health: async () => ({ healthy: true }) });
    expect(registry.credential("tenant-a", "sendblue")).toEqual({ status: "available", value: "secret" });
  });

  it("keeps plans, usage, credits, overage, refunds, invoices and provider costs in an idempotent tenant ledger", () => {
    const ledger = createCommercialLedger();
    ledger.setPlan({ tenantId: "tenant-a", planId: "pro", includedUnits: 2, unitPriceMicros: 10 });
    expect(ledger.recordUsage({ tenantId: "tenant-a", idempotencyKey: "u1", units: 3, providerCostMicros: 5 })).toMatchObject({ replayed: false, overageUnits: 1, chargedMicros: 10 });
    expect(ledger.recordUsage({ tenantId: "tenant-a", idempotencyKey: "u1", units: 3, providerCostMicros: 5 })).toMatchObject({ replayed: true });
    ledger.grantCredit({ tenantId: "tenant-a", idempotencyKey: "c1", amountMicros: 8 }); ledger.refund({ tenantId: "tenant-a", idempotencyKey: "f1", amountMicros: 2 });
    expect(ledger.invoice({ tenantId: "tenant-a", invoiceId: "i1" })).toMatchObject({ tenantId: "tenant-a", providerCostMicros: 5, creditMicros: 8, refundMicros: 2 });
  });

  it("enforces regional consent-aware support, export/delete/retention and incident records", () => {
    const privacy = createPrivacyController({ regions: ["mx", "eu"], retentionMs: 10 });
    privacy.record({ tenantId: "tenant-a", region: "mx", subjectId: "u1", value: "record", createdAt: 10 });
    expect(() => privacy.supportAccess({ tenantId: "tenant-a", supportId: "s1", consent: false })).toThrow("SUPPORT_CONSENT_REQUIRED");
    expect(privacy.export({ tenantId: "tenant-a", subjectId: "u1" })).toHaveLength(1);
    privacy.incident({ tenantId: "tenant-a", idempotencyKey: "inc-1", severity: "high" });
    expect(privacy.delete({ tenantId: "tenant-a", subjectId: "u1" })).toEqual({ deleted: 1 });
    expect(privacy.sweep(21)).toEqual({ deleted: 0 });
  });

  it("encrypts tenant backups, restores only in isolated targets, and rolls back staged migrations", async () => {
    const backup = createEncryptedBackupCoordinator({ retainSnapshots: 1, maxRpoMs: 10, maxRtoMs: 10, encrypt: (plain) => `enc:${plain}`, decrypt: (cipher) => cipher.slice(4) });
    const snapshot = await backup.export({ tenantId: "tenant-a", exportedAt: 10, records: [{ tenantId: "tenant-a", value: "x" }] });
    expect(snapshot.ciphertext).toContain("enc:"); expect(snapshot).not.toHaveProperty("records");
    await expect(backup.restore({ snapshot, tenantId: "tenant-a", authorized: true, isolated: false, startedAt: 11, completedAt: 12, latestWriteAt: 5 })).rejects.toThrow("RESTORE_ISOLATION_REQUIRED");
    await expect(backup.restore({ snapshot, tenantId: "tenant-a", authorized: true, isolated: true, startedAt: 11, completedAt: 12, latestWriteAt: 5 })).resolves.toMatchObject({ restored: true });
    const migrations = createMigrationController(); migrations.expand("v2"); expect(migrations.rollback("v2")).toEqual({ version: "v2", state: "rolled_back" });
  });

  it("reports setup diagnostics, feature flags and release checks without pretending unavailable prerequisites work", () => {
    const diagnostics = createSetupDiagnostics({ platform: "linux", available: ["node"], required: ["node", "vault"] });
    expect(diagnostics.run()).toMatchObject({ ready: false, missing: ["vault"], featureFlags: { releaseActivation: false } });
  });
});
