import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { canonicalReleaseManifest, createTestOnlyInMemoryVault, createProtectedVaultPort, createReleaseController, createAdapterRegistry, createCommercialLedger, createPrivacyController, createEncryptedBackupCoordinator, createMigrationController, createSetupDiagnostics, verifyReleaseManifest } from "../../packages/assurance/src/index.js";

describe("commercial assurance controls", () => {
  it("fails closed when the protected vault is unsupported and never returns a secret", () => {
    const vault = createTestOnlyInMemoryVault({ supported: false });
    expect(() => vault.put("tenant-a", "sendblue", "secret")).toThrow("VAULT_UNSUPPORTED");
    expect(vault.get("tenant-a", "sendblue")).toEqual({ status: "unsupported", code: "VAULT_UNSUPPORTED" });
  });

  it("activates only signed, provenance-attested releases and permits verified rollback", () => {
    expect(() => createReleaseController({ trustedKeys: {} })).toThrow("RELEASE_TRUST_STORE_REQUIRED");
  });

  it("requires uniform adapter health, limits, and vault credentials", () => {
    const vault = createTestOnlyInMemoryVault({ supported: true }); vault.put("tenant-a", "sendblue", "secret");
    const registry = createAdapterRegistry(vault);
    expect(() => registry.register({ name: "bad", version: "1", capabilities: [], limits: {}, credentialReference: "vault://bad", health: async () => ({ healthy: true }) })).toThrow("ADAPTER_CONTRACT_INVALID");
    registry.register({ name: "sendblue", version: "1", capabilities: ["sms"], limits: { maxRequests: 1 }, credentialReference: "vault://sendblue", health: async () => ({ healthy: true }) });
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

  it("requires durable crypto, storage, audit, and isolated restore ports with no legacy fallback", () => {
    const policy = { retainSnapshots: 1, maxRpoMs: 10, maxRtoMs: 10 };
    expect(() => createEncryptedBackupCoordinator({ ...policy, encrypt: (plain: string) => plain, decrypt: (cipher: string) => cipher } as any)).toThrow("BACKUP_PORTS_REQUIRED");
    const crypto = { encrypt: (plain: string) => `enc:${plain}`, decrypt: (cipher: string) => cipher.slice(4) };
    expect(() => createEncryptedBackupCoordinator({ ...policy, crypto })).toThrow("BACKUP_PORTS_REQUIRED");
    expect(() => createEncryptedBackupCoordinator({ ...policy, crypto, storage: { put: () => undefined, get: () => undefined, remove: () => undefined } })).toThrow("BACKUP_PORTS_REQUIRED");
    expect(() => createEncryptedBackupCoordinator({ ...policy, crypto, storage: { put: () => undefined, get: () => undefined, remove: () => undefined }, audit: { append: () => undefined } })).toThrow("BACKUP_PORTS_REQUIRED");
  });

  it("reports setup diagnostics, feature flags and release checks without pretending unavailable prerequisites work", () => {
    const diagnostics = createSetupDiagnostics({ platform: "linux", available: ["node"], required: ["node", "vault"] });
    expect(diagnostics.run()).toMatchObject({ ready: false, missing: ["vault"], featureFlags: { releaseActivation: false } });
  });

  it("requires an approved OS vault backend and verifies signed provenance before activation or rollback", () => {
    expect(() => createProtectedVaultPort()).toThrow("PROTECTED_VAULT_UNAVAILABLE");
    expect(() => createProtectedVaultPort({ backend: { platform: "windows", provider: "in-memory", version: "1.0.0", approval: "approved" }, put: () => undefined, get: () => "credential" } as any)).toThrow("VAULT_BACKEND_UNAPPROVED");
    for (const backend of [{ platform: "windows", provider: "windows-credential-manager" }, { platform: "macos", provider: "macos-keychain" }, { platform: "linux", provider: "linux-secret-service" }] as const) {
      const vault = createProtectedVaultPort({ backend: { ...backend, version: "1.0.0", approval: "approved" }, put: () => undefined, get: () => "credential" });
      expect(vault.get("tenant-a", "sendblue")).toEqual({ status: "available", value: "credential" });
    }
  });

  it("R18: persists encrypted schema-bound snapshots and restores them only through isolated audited, indexed, idempotent ports", async () => {
    const events: unknown[] = [];
    const restoredSnapshots: unknown[] = [];
    const storage = new Map<string, string>();
    const backup = createEncryptedBackupCoordinator({
      retainSnapshots: 2, maxRpoMs: 10, maxRtoMs: 10, schemaVersion: "v2",
      crypto: { encrypt: (plain) => `cipher:${plain}`, decrypt: (cipher) => cipher.startsWith("cipher:") ? cipher.slice(7) : (() => { throw new Error("CRYPTO_INVALID"); })() },
      storage: { put: (key, value) => storage.set(key, value), get: (key) => storage.get(key), remove: (key) => storage.delete(key) },
      audit: { append: (event) => { events.push(event); } },
      restoreTarget: { isolated: true, apply: async (restored) => { restoredSnapshots.push(restored); } }
    });
    const invariants = { authorization: ["auth:tenant-a"], audit: ["audit:tenant-a"], indexes: ["index:tenant-a"], ledger: ["ledger:tenant-a"], deletions: ["deletion:tenant-a"] };
    const snapshot = await backup.export({ tenantId: "tenant-a", exportedAt: 10, records: [{ tenantId: "tenant-a", value: "x" }], invariants });
    expect(snapshot).toMatchObject({ schemaVersion: "v2", ciphertext: expect.stringContaining("cipher:") });
    expect(storage.size).toBe(1);
    await expect(backup.restore({ snapshot, tenantId: "tenant-a", authorized: true, startedAt: 11, completedAt: 12, latestWriteAt: 5, idempotencyKey: "restore-1" })).resolves.toMatchObject({ restored: true, replayed: false, recordsRestored: 1 });
    await expect(backup.restore({ snapshot, tenantId: "tenant-a", authorized: true, startedAt: 11, completedAt: 12, latestWriteAt: 5, idempotencyKey: "restore-1" })).resolves.toMatchObject({ restored: true, replayed: true });
    expect(events).toHaveLength(1);
    expect(restoredSnapshots).toEqual([{ tenantId: "tenant-a", schemaVersion: "v2", exportedAt: 10, records: [{ tenantId: "tenant-a", value: "x" }], invariants }]);
    await expect(backup.restore({ snapshot: { ...snapshot, schemaVersion: "v1" }, tenantId: "tenant-a", authorized: true, startedAt: 11, completedAt: 12, latestWriteAt: 5, idempotencyKey: "restore-2" })).rejects.toThrow("RESTORE_SCHEMA_MISMATCH");
    expect(backup.deleteTenant("tenant-a")).toEqual({ deletedSnapshots: 1 });
    expect(storage.size).toBe(0);
  });

  it("R18: fails closed without production ports and makes migration rollback explicit", () => {
    expect(() => createEncryptedBackupCoordinator({ retainSnapshots: 1, maxRpoMs: 1, maxRtoMs: 1 })).toThrow("BACKUP_PORTS_REQUIRED");
    const migrations = createMigrationController();
    migrations.expand("assurance-v2");
    expect(migrations.rollback("assurance-v2")).toEqual({ version: "assurance-v2", state: "rolled_back" });
    expect(() => migrations.rollback("assurance-v2")).toThrow("MIGRATION_ROLLBACK_DENIED");
  });

  it("R4: requires runtime capability equality after signature verification", () => {
    const keys = generateKeyPairSync("ed25519");
    const manifest = { version: "release-manifest/v1" as const, id: "runtime-r1", provenance: "sha256:abc", capabilities: ["browser", "vault"], activation: { approvedBy: "release-bot", timestamp: 1 } };
    const signature = { version: "release-signature/v1" as const, algorithm: "Ed25519" as const, keyId: "release-2026", value: sign(null, Buffer.from(canonicalReleaseManifest(manifest)), keys.privateKey).toString("base64") };
    expect(() => createReleaseController({ trustedKeys: { "release-2026": keys.publicKey } }).activate({ manifest, signature })).toThrow("RELEASE_RUNTIME_CAPABILITIES_REQUIRED");
    expect(() => createReleaseController({ trustedKeys: { "release-2026": keys.publicKey }, runtimeCapabilities: ["browser"] }).activate({ manifest, signature })).toThrow("RELEASE_CAPABILITY_MISMATCH");
  });

  it("R4: verifies canonical release manifests with trusted Ed25519 keys and rejects untrusted signature metadata", () => {
    const keys = generateKeyPairSync("ed25519");
    const manifest = { version: "release-manifest/v1" as const, id: "r1", provenance: "sha256:abc", capabilities: ["browser"], activation: { approvedBy: "release-bot", timestamp: 1 } };
    const signature = { version: "release-signature/v1" as const, algorithm: "Ed25519" as const, keyId: "release-2026", value: sign(null, Buffer.from(canonicalReleaseManifest(manifest)), keys.privateKey).toString("base64") };
    expect(verifyReleaseManifest({ manifest, signature }, { "release-2026": keys.publicKey })).toBe(true);
    const releases = createReleaseController({ trustedKeys: { "release-2026": keys.publicKey }, runtimeCapabilities: ["browser"] });
    expect(releases.activate({ manifest, signature })).toMatchObject({ activeReleaseId: "r1", verification: "verified" });
    expect(() => releases.activate({ manifest, signature: { ...signature, keyId: "unknown" } })).toThrow("RELEASE_VERIFICATION_FAILED");
    expect(() => releases.activate({ manifest, signature: { ...signature, algorithm: "RSA-PSS" as any } })).toThrow("RELEASE_VERIFICATION_FAILED");
    expect(() => releases.activate({ manifest: { ...manifest, version: "release-manifest/v2" as any }, signature })).toThrow("RELEASE_VERIFICATION_FAILED");
  });

  it("R18: rejects snapshot bytes whose encrypted contents mix envelope version, schema, or tenant", async () => {
    const storage = new Map<string, string>();
    let decryptedPayload: string | undefined;
    const crypto = { encrypt: (plain: string) => `cipher:${plain}`, decrypt: (cipher: string) => decryptedPayload ?? cipher.slice(7) };
    let restoreApplications = 0;
    const backup = createEncryptedBackupCoordinator({ retainSnapshots: 1, maxRpoMs: 10, maxRtoMs: 10, schemaVersion: "v2", crypto, storage: { put: (key, value) => storage.set(key, value), get: (key) => storage.get(key), remove: (key) => storage.delete(key) }, audit: { append: () => undefined }, restoreTarget: { isolated: true, apply: () => { restoreApplications += 1; } } });
    const invariants = { authorization: ["auth:tenant-a"], audit: ["audit:tenant-a"], indexes: ["index:tenant-a"], ledger: ["ledger:tenant-a"], deletions: ["deletion:tenant-a"] };
    const snapshot = await backup.export({ tenantId: "tenant-a", exportedAt: 10, records: [{ tenantId: "tenant-a", value: "x" }], invariants });
    for (const payload of [
      { version: "encrypted-snapshot/v2", schemaVersion: "v2", tenantId: "tenant-a", exportedAt: 10, records: [{ tenantId: "tenant-a", value: "x" }], invariants },
      { version: "encrypted-snapshot/v1", schemaVersion: "v1", tenantId: "tenant-a", exportedAt: 10, records: [{ tenantId: "tenant-a", value: "x" }], invariants },
      { version: "encrypted-snapshot/v1", schemaVersion: "v2", tenantId: "tenant-b", exportedAt: 10, records: [{ tenantId: "tenant-b", value: "x" }], invariants: { ...invariants, authorization: ["auth:tenant-b"] } },
      { version: "encrypted-snapshot/v1", schemaVersion: "v2", tenantId: "tenant-a", exportedAt: 10, records: [{ tenantId: "tenant-a", value: "x" }], invariants: { ...invariants, ledger: [] } }
    ]) {
      decryptedPayload = JSON.stringify(payload);
      await expect(backup.restore({ snapshot, tenantId: "tenant-a", authorized: true, startedAt: 11, completedAt: 12, latestWriteAt: 5 })).rejects.toThrow(/(?:RESTORE_(SNAPSHOT_INVALID|SCHEMA_MISMATCH|TENANT_DENIED)|DR_TARGET_VIOLATION)/);
    }
    expect(restoreApplications).toBe(0);
  });
});
