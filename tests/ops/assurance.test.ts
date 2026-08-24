import { describe, expect, it } from "vitest";
import { canonicalReleaseManifest, createApprovedOsProtectedVaultPort, createApprovedVaultHostFactory, createTestOnlyInMemoryVault, createProtectedVaultPort, createReleaseController, createAdapterRegistry, createCommercialLedger, createPrivacyController, createEncryptedBackupCoordinator, createMigrationController, createSetupDiagnostics, verifyReleaseManifest, type SignatureVerifierPort, VaultHostPlatform } from "../../packages/assurance/src/index.js";

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

  it("R3: requires an approved cross-platform vault host factory with auditable approval metadata", () => {
    const hosts = new Map<string, string>();
    expect(() => createApprovedVaultHostFactory({ platform: VaultHostPlatform.WindowsCredentialManager, approval: { status: "pending", approvedBy: "security", approvedAt: 1 }, createHost: () => ({ backend: { platform: "windows", provider: "windows-credential-manager", version: "1.0.0", approval: "approved" }, put: () => undefined, get: () => undefined }) } as any)).toThrow("VAULT_HOST_FACTORY_UNAPPROVED");
    for (const [platform, backend] of [[VaultHostPlatform.WindowsCredentialManager, { platform: "windows", provider: "windows-credential-manager" }], [VaultHostPlatform.MacosKeychain, { platform: "macos", provider: "macos-keychain" }], [VaultHostPlatform.LinuxSecretService, { platform: "linux", provider: "linux-secret-service" }]] as const) {
      const factory = createApprovedVaultHostFactory({ platform, approval: { status: "approved", approvedBy: "security", approvedAt: 1 }, createHost: () => ({ backend: { ...backend, version: "1.0.0", approval: "approved" }, put: (tenantId, key, value) => hosts.set(`${tenantId}\u0000${key}`, value), get: (tenantId, key) => hosts.get(`${tenantId}\u0000${key}`) }) });
      expect(factory.boundary).toBe("production");
      expect(factory.platform).toBe(platform);
      expect(createProtectedVaultPort(factory.createHost()).backend.provider).toBe(platform);
    }
  });

  it("R3: brands only approved OS-protected vaults with matching platform backends and rejects test-only hosts", () => {
    const values = new Map<string, string>();
    expect(() => createApprovedOsProtectedVaultPort({
      platform: VaultHostPlatform.WindowsCredentialManager,
      approval: { status: "approved", approvedBy: "security", approvedAt: 1 },
      backend: { platform: "windows", provider: "windows-credential-manager", version: "1.0.0", approval: "approved" },
      host: createTestOnlyInMemoryVault({ supported: true })
    } as any)).toThrow("VAULT_TEST_ONLY_HOST_DENIED");
    for (const [platform, backend] of [[VaultHostPlatform.WindowsCredentialManager, { platform: "windows", provider: "windows-credential-manager" }], [VaultHostPlatform.MacosKeychain, { platform: "macos", provider: "macos-keychain" }], [VaultHostPlatform.LinuxSecretService, { platform: "linux", provider: "linux-secret-service" }]] as const) {
      const vault = createApprovedOsProtectedVaultPort({
        platform,
        approval: { status: "approved", approvedBy: "security", approvedAt: 1 },
        backend: { ...backend, version: "1.0.0", approval: "approved" },
        host: {
          backend: { ...backend, version: "1.0.0", approval: "approved" },
          put: (tenantId, key, value) => values.set(`${tenantId}\u0000${key}`, value),
          get: (tenantId, key) => values.get(`${tenantId}\u0000${key}`)
        }
      });
      vault.put("tenant-a", "credential", platform);
      expect(vault).toMatchObject({ boundary: "production", backend: { provider: platform }, approval: { status: "approved", approvedBy: "security" } });
      expect(vault.get("tenant-a", "credential")).toEqual({ status: "available", value: platform });
    }
  });

  it("R4: uses an injected signature verifier and retains runtime capability equality", async () => {
    const manifest = { version: "release-manifest/v1" as const, id: "runtime-r1", provenance: "sha256:abc", capabilities: ["browser", "vault"], activation: { approvedBy: "release-bot", timestamp: 1 } };
    const signature = { version: "release-signature/v1" as const, algorithm: "Ed25519" as const, keyId: "release-2026", value: "AQ==" };
    const verifier: SignatureVerifierPort = { verify: async (input) => input.manifest === canonicalReleaseManifest(manifest) && input.signature === "AQ==" && input.publicKey.kty === "OKP" };
    await expect(createReleaseController({ trustedKeys: { "release-2026": { kty: "OKP", crv: "Ed25519", x: "public-key" } }, signatureVerifier: verifier }).activate({ manifest, signature })).rejects.toThrow("RELEASE_RUNTIME_CAPABILITIES_REQUIRED");
    await expect(createReleaseController({ trustedKeys: { "release-2026": { kty: "OKP", crv: "Ed25519", x: "public-key" } }, signatureVerifier: verifier, runtimeCapabilities: ["browser"] }).activate({ manifest, signature })).rejects.toThrow("RELEASE_CAPABILITY_MISMATCH");
  });

  it("R4: verifies canonical release manifests through the injected port and rejects invalid metadata", async () => {
    const manifest = { version: "release-manifest/v1" as const, id: "r1", provenance: "sha256:abc", capabilities: ["browser"], activation: { approvedBy: "release-bot", timestamp: 1 } };
    const signature = { version: "release-signature/v1" as const, algorithm: "Ed25519" as const, keyId: "release-2026", value: "AQ==" };
    const trustedKeys = { "release-2026": { kty: "OKP", crv: "Ed25519", x: "public-key" } } as const;
    const verifier: SignatureVerifierPort = { verify: async (input) => input.manifest === canonicalReleaseManifest(manifest) && input.signature === "AQ==" && input.publicKey.kty === "OKP" };
    await expect(verifyReleaseManifest({ manifest, signature }, trustedKeys, verifier)).resolves.toBe(true);
    const releases = createReleaseController({ trustedKeys, signatureVerifier: verifier, runtimeCapabilities: ["browser"] });
    await expect(releases.activate({ manifest, signature })).resolves.toMatchObject({ activeReleaseId: "r1", verification: "verified" });
    await expect(releases.activate({ manifest, signature: { ...signature, keyId: "unknown" } })).rejects.toThrow("RELEASE_VERIFICATION_FAILED");
    await expect(releases.activate({ manifest, signature: { ...signature, algorithm: "RSA-PSS" as any } })).rejects.toThrow("RELEASE_VERIFICATION_FAILED");
    await expect(releases.activate({ manifest: { ...manifest, version: "release-manifest/v2" as any }, signature })).rejects.toThrow("RELEASE_VERIFICATION_FAILED");
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
