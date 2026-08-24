export type VaultResult = { status: "available"; value: string } | { status: "unsupported"; code: "VAULT_UNSUPPORTED" };
export type VaultPlatform = "windows" | "macos" | "linux";
export type ApprovedVaultBackendProvider = "windows-credential-manager" | "macos-keychain" | "linux-secret-service";
/** The only production vault host boundaries approved for credential persistence. */
export enum VaultHostPlatform { WindowsCredentialManager = "windows-credential-manager", MacosKeychain = "macos-keychain", LinuxSecretService = "linux-secret-service" }
export type VaultHostApproval = Readonly<{ status: "approved"; approvedBy: string; approvedAt: number }>;
export type ApprovedVaultBackend = Readonly<{ platform: VaultPlatform; provider: ApprovedVaultBackendProvider; version: string; approval: "approved" }>;
export type VaultAccessPort = Readonly<{ boundary: "production" | "test-only"; put(tenantId: string, key: string, value: string): void; get(tenantId: string, key: string): VaultResult }>;
export type ProtectedVaultPort = VaultAccessPort & Readonly<{ boundary: "production"; backend: ApprovedVaultBackend }>;
export type TestOnlyInMemoryVaultPort = VaultAccessPort & Readonly<{ boundary: "test-only" }>;
export type ProtectedVault = ProtectedVaultPort;
export type ProtectedVaultHost = Readonly<{ backend: ApprovedVaultBackend; put(tenantId: string, key: string, value: string): void; get(tenantId: string, key: string): string | undefined }>;
export type ApprovedVaultHostFactory = Readonly<{ boundary: "production"; platform: VaultHostPlatform; approval: VaultHostApproval; createHost(): ProtectedVaultHost }>;
/** A process-local brand issued only after an approved OS backend and host have been verified together. */
export type ApprovedOsProtectedVaultPort = ProtectedVaultPort & Readonly<{ approval: VaultHostApproval }>;
export type ApprovedOsProtectedVaultInput = Readonly<{ platform: VaultHostPlatform; approval: VaultHostApproval; backend: ApprovedVaultBackend; host: ProtectedVaultHost }>;
const approvedVaultProviders: Readonly<Record<VaultPlatform, ApprovedVaultBackendProvider>> = Object.freeze({ windows: "windows-credential-manager", macos: "macos-keychain", linux: "linux-secret-service" });
const approvedVaultPlatforms: Readonly<Record<VaultHostPlatform, VaultPlatform>> = Object.freeze({ [VaultHostPlatform.WindowsCredentialManager]: "windows", [VaultHostPlatform.MacosKeychain]: "macos", [VaultHostPlatform.LinuxSecretService]: "linux" });
const approvedOsProtectedVaults = new WeakSet<object>();
export function isApprovedVaultBackend(value: unknown): value is ApprovedVaultBackend {
  if (!value || typeof value !== "object") return false;
  const backend = value as Partial<ApprovedVaultBackend>;
  return (backend.platform === "windows" || backend.platform === "macos" || backend.platform === "linux") && backend.provider === approvedVaultProviders[backend.platform] && typeof backend.version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(backend.version) && backend.approval === "approved";
}
export function isApprovedOperatingSystemVault(value: unknown): value is ProtectedVaultPort {
  return !!value && typeof value === "object" && (value as VaultAccessPort).boundary === "production" && typeof (value as VaultAccessPort).put === "function" && typeof (value as VaultAccessPort).get === "function" && isApprovedVaultBackend((value as Partial<ProtectedVaultPort>).backend);
}
export function isApprovedVaultHostFactory(value: unknown): value is ApprovedVaultHostFactory {
  if (!value || typeof value !== "object") return false;
  const factory = value as Partial<ApprovedVaultHostFactory>;
  return factory.boundary === "production" && Object.values(VaultHostPlatform).includes(factory.platform as VaultHostPlatform) && !!factory.approval && factory.approval.status === "approved" && typeof factory.approval.approvedBy === "string" && factory.approval.approvedBy.length > 0 && Number.isFinite(factory.approval.approvedAt) && (factory.approval.approvedAt ?? 0) > 0 && typeof factory.createHost === "function";
}
export function isApprovedOsProtectedVault(value: unknown): value is ApprovedOsProtectedVaultPort {
  return isApprovedOperatingSystemVault(value) && approvedOsProtectedVaults.has(value as object);
}
export function createApprovedVaultHostFactory(input: Omit<ApprovedVaultHostFactory, "boundary">): ApprovedVaultHostFactory {
  const factory = { boundary: "production" as const, platform: input?.platform, approval: input?.approval, createHost: input?.createHost };
  if (!isApprovedVaultHostFactory(factory)) throw new Error("VAULT_HOST_FACTORY_UNAPPROVED");
  return Object.freeze({ boundary: "production" as const, platform: factory.platform, approval: Object.freeze({ ...factory.approval }), createHost: factory.createHost });
}
export function createProtectedVaultPort(host?: ProtectedVaultHost): ProtectedVaultPort {
  if (!host || typeof host.put !== "function" || typeof host.get !== "function") throw new Error("PROTECTED_VAULT_UNAVAILABLE");
  if (!isApprovedVaultBackend(host.backend)) throw new Error("VAULT_BACKEND_UNAPPROVED");
  return Object.freeze({ boundary: "production" as const, backend: Object.freeze({ ...host.backend }), put(tenantId, key, value) { if (!tenantId || !key || !value) throw new Error("VAULT_INPUT_INVALID"); host.put(tenantId, key, value); }, get(tenantId, key) { if (!tenantId || !key) return { status: "unsupported", code: "VAULT_UNSUPPORTED" }; try { const value = host.get(tenantId, key); return value ? { status: "available", value } : { status: "unsupported", code: "VAULT_UNSUPPORTED" }; } catch { return { status: "unsupported", code: "VAULT_UNSUPPORTED" }; } } });
}
/** Creates the only branded production vault accepted by production integration factories. */
export function createApprovedOsProtectedVaultPort(input: ApprovedOsProtectedVaultInput): ApprovedOsProtectedVaultPort {
  if ((input as { host?: unknown } | undefined)?.host && (input as { host: { boundary?: unknown } }).host.boundary === "test-only") throw new Error("VAULT_TEST_ONLY_HOST_DENIED");
  if (!input?.host || !input.backend) throw new Error("APPROVED_OS_PROTECTED_VAULT_REQUIRED");
  const expectedPlatform = approvedVaultPlatforms[input.platform];
  if (!expectedPlatform || !isApprovedVaultBackend(input.backend) || input.backend.platform !== expectedPlatform || input.backend.provider !== input.platform) throw new Error("VAULT_BACKEND_UNAPPROVED");
  if (!input.approval || input.approval.status !== "approved" || !input.approval.approvedBy || !Number.isFinite(input.approval.approvedAt) || input.approval.approvedAt <= 0) throw new Error("VAULT_APPROVAL_UNAPPROVED");
  if (!isApprovedVaultBackend(input.host.backend) || input.host.backend.platform !== input.backend.platform || input.host.backend.provider !== input.backend.provider || input.host.backend.version !== input.backend.version || input.host.backend.approval !== input.backend.approval) throw new Error("VAULT_BACKEND_MISMATCH");
  const protectedVault = createProtectedVaultPort(input.host);
  const approvedVault = Object.freeze({ ...protectedVault, backend: Object.freeze({ ...input.backend }), approval: Object.freeze({ ...input.approval }) });
  approvedOsProtectedVaults.add(approvedVault);
  return approvedVault;
}
/** Test-only fixture; production adapter constructors reject this boundary. */
export function createTestOnlyInMemoryVault(options: { supported?: boolean } = {}): TestOnlyInMemoryVaultPort {
  const supported = options.supported === true; const values = new Map<string, string>(); const keyFor = (tenant: string, key: string) => `${tenant}\u0000${key}`;
  return Object.freeze({ boundary: "test-only" as const, put(tenantId, key, value) { if (!supported) throw new Error("VAULT_UNSUPPORTED"); if (!tenantId || !key || !value) throw new Error("VAULT_INPUT_INVALID"); values.set(keyFor(tenantId, key), value); }, get(tenantId, key) { if (!supported) return { status: "unsupported", code: "VAULT_UNSUPPORTED" }; const value = values.get(keyFor(tenantId, key)); return value === undefined ? { status: "unsupported", code: "VAULT_UNSUPPORTED" } : { status: "available", value }; } });
}
export type ReleaseActivation = Readonly<{ approvedBy: string; timestamp: number }>;
export type ReleaseManifest = Readonly<{ version: "release-manifest/v1"; id: string; provenance: string; capabilities: readonly string[]; activation: ReleaseActivation }>;
export type ReleaseSignature = Readonly<{ version: "release-signature/v1"; algorithm: "Ed25519"; keyId: string; value: string }>;
export type Release = Readonly<{ manifest: ReleaseManifest; signature: ReleaseSignature }>;
export type ReleasePublicKey = Readonly<{ kty: "OKP"; crv: "Ed25519"; x: string }>;
export type TrustedReleaseKeys = Readonly<Record<string, ReleasePublicKey>>;
export type SignatureVerifierPort = Readonly<{ verify(input: Readonly<{ algorithm: "Ed25519"; manifest: string; publicKey: ReleasePublicKey; signature: string }>): Promise<boolean> }>;
type WebCryptoPort = Readonly<{ subtle: Pick<SubtleCrypto, "importKey" | "verify"> }>;
function canonical(value: unknown): string { if (typeof value === "string") return JSON.stringify(value); if (typeof value === "number" || typeof value === "boolean" || value === null) return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (typeof value === "object" && value !== null) { const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`; } throw new Error("RELEASE_MANIFEST_INVALID"); }
export function canonicalReleaseManifest(manifest: ReleaseManifest): string { return canonical({ activation: manifest.activation, capabilities: [...manifest.capabilities], id: manifest.id, provenance: manifest.provenance, version: manifest.version }); }
function validManifest(manifest: ReleaseManifest): boolean { return manifest.version === "release-manifest/v1" && Boolean(manifest.id) && /^sha256:[a-f0-9]+$/i.test(manifest.provenance) && manifest.capabilities.length > 0 && new Set(manifest.capabilities).size === manifest.capabilities.length && Boolean(manifest.activation.approvedBy) && Number.isFinite(manifest.activation.timestamp) && manifest.activation.timestamp > 0; }
function decodeBase64(value: string): Uint8Array { const binary = globalThis.atob(value); return Uint8Array.from(binary, (character) => character.charCodeAt(0)); }
/** Portable WebCrypto adapter; Node-specific crypto belongs outside Convex-reachable modules. */
export function createWebCryptoSignatureVerifier(webCrypto: WebCryptoPort = globalThis.crypto): SignatureVerifierPort {
  if (!webCrypto?.subtle) throw new Error("WEBCRYPTO_UNAVAILABLE");
  return Object.freeze({ verify: async (input) => { try { const key = await webCrypto.subtle.importKey("jwk", input.publicKey, { name: "Ed25519" }, false, ["verify"]); return await webCrypto.subtle.verify({ name: "Ed25519" }, key, decodeBase64(input.signature) as BufferSource, new TextEncoder().encode(input.manifest)); } catch { return false; } } });
}
export async function verifyReleaseManifest(release: Release, trustedKeys: TrustedReleaseKeys, signatureVerifier: SignatureVerifierPort): Promise<boolean> { if (!validManifest(release.manifest) || release.signature.version !== "release-signature/v1" || release.signature.algorithm !== "Ed25519" || !release.signature.keyId || !/^[A-Za-z0-9+/]+={0,2}$/.test(release.signature.value)) return false; const key = trustedKeys[release.signature.keyId]; if (!key || !signatureVerifier || typeof signatureVerifier.verify !== "function") return false; try { return await signatureVerifier.verify({ algorithm: "Ed25519", manifest: canonicalReleaseManifest(release.manifest), publicKey: key, signature: release.signature.value }); } catch { return false; } }
function sameCapabilities(expected: readonly string[], actual: readonly string[]): boolean { return expected.length === actual.length && new Set(expected).size === expected.length && new Set(actual).size === actual.length && expected.every((capability) => actual.includes(capability)); }
export function createReleaseController(options: Readonly<{ trustedKeys: TrustedReleaseKeys; signatureVerifier?: SignatureVerifierPort; runtimeCapabilities?: readonly string[] }>) { if (!options || !options.trustedKeys || Object.keys(options.trustedKeys).length === 0) throw new Error("RELEASE_TRUST_STORE_REQUIRED"); if (!options.signatureVerifier || typeof options.signatureVerifier.verify !== "function") throw new Error("RELEASE_SIGNATURE_VERIFIER_REQUIRED"); let active: Release | undefined; const verified = new Map<string, Release>(); return Object.freeze({ activate: async (release: Release) => { if (!await verifyReleaseManifest(release, options.trustedKeys, options.signatureVerifier!)) throw new Error("RELEASE_VERIFICATION_FAILED"); if (!options.runtimeCapabilities?.length) throw new Error("RELEASE_RUNTIME_CAPABILITIES_REQUIRED"); if (!sameCapabilities(release.manifest.capabilities, options.runtimeCapabilities)) throw new Error("RELEASE_CAPABILITY_MISMATCH"); const frozen = Object.freeze({ manifest: Object.freeze({ ...release.manifest, capabilities: Object.freeze([...release.manifest.capabilities]), activation: Object.freeze({ ...release.manifest.activation }) }), signature: Object.freeze({ ...release.signature }) }); verified.set(release.manifest.id, frozen); active = frozen; return { activeReleaseId: release.manifest.id, verification: "verified" as const }; }, rollback(releaseId: string, activation: ReleaseActivation) { const target = verified.get(releaseId); if (!target || !active || !activation.approvedBy || !Number.isFinite(activation.timestamp) || activation.timestamp <= 0) throw new Error("ROLLBACK_VERIFICATION_FAILED"); const rollbackOf = active.manifest.id; active = target; return { activeReleaseId: target.manifest.id, rollbackOf, verification: "verified" as const }; }, active: () => active }); }
export type AdapterContract = Readonly<{ name: string; version: string; capabilities: readonly string[]; limits: Readonly<Record<string, number>>; credentialReference: `vault://${string}`; health(): Promise<{ healthy: boolean; code?: string }> }>;
export function createAdapterRegistry(vault: VaultAccessPort) { const adapters = new Map<string, AdapterContract>(); return Object.freeze({ register(adapter: AdapterContract) { if (!adapter.name || !adapter.version || !adapter.capabilities.length || !Object.keys(adapter.limits).length || adapter.credentialReference !== `vault://${adapter.name}` || typeof adapter.health !== "function") throw new Error("ADAPTER_CONTRACT_INVALID"); if (Object.values(adapter.limits).some((limit) => !Number.isFinite(limit) || limit < 0)) throw new Error("ADAPTER_CONTRACT_INVALID"); adapters.set(adapter.name, Object.freeze({ ...adapter, capabilities: [...adapter.capabilities], limits: { ...adapter.limits } })); }, describe: (name: string) => adapters.get(name), credential: (tenantId: string, name: string) => { if (!adapters.has(name)) throw new Error("ADAPTER_UNSUPPORTED"); return vault.get(tenantId, name); } }); }
type LedgerEntry = { tenantId: string; type: "usage" | "credit" | "refund"; idempotencyKey: string; amountMicros: number; providerCostMicros: number; units: number };
export function createCommercialLedger() { const plans = new Map<string, { planId: string; includedUnits: number; unitPriceMicros: number }>(); const entries = new Map<string, LedgerEntry>(); const key = (tenantId: string, id: string) => `${tenantId}\u0000${id}`; return Object.freeze({ setPlan(input: { tenantId: string; planId: string; includedUnits: number; unitPriceMicros: number }) { if (!input.tenantId || input.includedUnits < 0 || input.unitPriceMicros < 0) throw new Error("PLAN_INVALID"); plans.set(input.tenantId, { ...input }); }, recordUsage(input: { tenantId: string; idempotencyKey: string; units: number; providerCostMicros: number }) { const previous = entries.get(key(input.tenantId, input.idempotencyKey)); if (previous) return { replayed: true, overageUnits: Math.max(0, previous.units - (plans.get(input.tenantId)?.includedUnits ?? 0)), chargedMicros: previous.amountMicros }; const plan = plans.get(input.tenantId); if (!plan || input.units < 0 || input.providerCostMicros < 0) throw new Error("USAGE_INVALID"); const priorUnits = [...entries.values()].filter(x => x.tenantId === input.tenantId && x.type === "usage").reduce((sum, x) => sum + x.units, 0); const overageUnits = Math.max(0, priorUnits + input.units - plan.includedUnits); const chargedMicros = Math.max(0, overageUnits - Math.max(0, priorUnits - plan.includedUnits)) * plan.unitPriceMicros; entries.set(key(input.tenantId, input.idempotencyKey), { ...input, type: "usage", amountMicros: chargedMicros }); return { replayed: false, overageUnits, chargedMicros }; }, grantCredit(input: { tenantId: string; idempotencyKey: string; amountMicros: number }) { entries.set(key(input.tenantId, input.idempotencyKey), { ...input, type: "credit", providerCostMicros: 0, units: 0 }); }, refund(input: { tenantId: string; idempotencyKey: string; amountMicros: number }) { entries.set(key(input.tenantId, input.idempotencyKey), { ...input, type: "refund", providerCostMicros: 0, units: 0 }); }, invoice(input: { tenantId: string; invoiceId: string }) { const rows = [...entries.values()].filter(x => x.tenantId === input.tenantId); return { tenantId: input.tenantId, invoiceId: input.invoiceId, chargedMicros: rows.filter(x => x.type === "usage").reduce((s,x) => s+x.amountMicros,0), providerCostMicros: rows.reduce((s,x) => s+x.providerCostMicros,0), creditMicros: rows.filter(x=>x.type === "credit").reduce((s,x)=>s+x.amountMicros,0), refundMicros: rows.filter(x=>x.type === "refund").reduce((s,x)=>s+x.amountMicros,0) }; } }); }
export function createPrivacyController(policy: { regions: readonly string[]; retentionMs: number }) { const records: { tenantId: string; region: string; subjectId: string; value: string; createdAt: number }[] = []; const incidents = new Set<string>(); const own = (tenantId: string, subjectId: string) => records.filter(x => x.tenantId === tenantId && x.subjectId === subjectId); return Object.freeze({ record(record: typeof records[number]) { if (!policy.regions.includes(record.region)) throw new Error("REGION_UNSUPPORTED"); records.push({ ...record }); }, supportAccess(input: { tenantId: string; supportId: string; consent: boolean }) { if (!input.consent) throw new Error("SUPPORT_CONSENT_REQUIRED"); return { tenantId: input.tenantId, supportId: input.supportId, access: "granted" as const }; }, export(input: { tenantId: string; subjectId: string }) { return own(input.tenantId, input.subjectId).map(x => ({ ...x })); }, delete(input: { tenantId: string; subjectId: string }) { const found = own(input.tenantId, input.subjectId); for (const record of found) records.splice(records.indexOf(record), 1); return { deleted: found.length }; }, sweep(now: number) { const expired = records.filter(x => now - x.createdAt > policy.retentionMs); for (const record of expired) records.splice(records.indexOf(record), 1); return { deleted: expired.length }; }, incident(input: { tenantId: string; idempotencyKey: string; severity: "low" | "high" }) { incidents.add(`${input.tenantId}\u0000${input.idempotencyKey}`); return { recorded: true }; } }); }
export type BackupCryptoPort = Readonly<{ encrypt(plain: string): string; decrypt(ciphertext: string): string }>;
export type BackupStoragePort = Readonly<{ put(key: string, value: string): void; get(key: string): string | undefined; remove(key: string): void }>;
export type BackupAuditPort = Readonly<{ append(event: Readonly<{ action: "backup.restore"; tenantId: string; snapshotId: string; idempotencyKey: string }>): void }>;
export type BackupInvariantContents = Readonly<{ authorization: readonly string[]; audit: readonly string[]; indexes: readonly string[]; ledger: readonly string[]; deletions: readonly string[] }>;
export type IsolatedRestoreTarget = Readonly<{ isolated: true; apply(snapshot: Readonly<{ tenantId: string; schemaVersion: string; exportedAt: number; records: readonly { tenantId: string; value: string }[]; invariants: BackupInvariantContents }>): Promise<void> | void }>;
type EncryptedSnapshot = Readonly<{ id: string; tenantId: string; exportedAt: number; schemaVersion: string; ciphertext: string }>;
type EncryptedBackupPolicy = Readonly<{ retainSnapshots: number; maxRpoMs: number; maxRtoMs: number; schemaVersion?: string; crypto?: BackupCryptoPort; storage?: BackupStoragePort; audit?: BackupAuditPort; restoreTarget?: IsolatedRestoreTarget }>;
function backupSnapshotId(tenantId: string, exportedAt: number, schemaVersion: string) { return `${tenantId}:${schemaVersion}:${exportedAt}`; }
function validInvariants(value: unknown): value is BackupInvariantContents { if (!value || typeof value !== "object") return false; const record = value as Record<string, unknown>; return ["authorization", "audit", "indexes", "ledger", "deletions"].every((key) => Array.isArray(record[key]) && (record[key] as unknown[]).length > 0 && (record[key] as unknown[]).every((entry) => typeof entry === "string" && entry.length > 0)); }
/** Encrypted backups require injected crypto, durable storage, audit, and isolated restore ports; no production fallback exists. */
export function createEncryptedBackupCoordinator(policy: EncryptedBackupPolicy) {
  if (!Number.isSafeInteger(policy.retainSnapshots) || policy.retainSnapshots < 1 || policy.maxRpoMs < 0 || policy.maxRtoMs < 0) throw new RangeError("BACKUP_POLICY_INVALID");
  if (!policy.crypto || !policy.storage || !policy.audit || !policy.restoreTarget || policy.restoreTarget.isolated !== true || typeof policy.restoreTarget.apply !== "function") throw new Error("BACKUP_PORTS_REQUIRED");
  const { crypto, storage, audit, restoreTarget } = policy;
  const schemaVersion = policy.schemaVersion ?? "v1";
  const snapshots = new Map<string, EncryptedSnapshot[]>();
  const restored = new Map<string, { snapshotId: string; result: { restored: true; replayed: boolean; rpoMs: number; rtoMs: number; isolated: true; recordsRestored: number } }>();
  const retained = (tenantId: string) => snapshots.get(tenantId) ?? [];
  return Object.freeze({
    async export(input: { tenantId: string; exportedAt: number; records: readonly { tenantId: string; value: string }[]; invariants: BackupInvariantContents }) {
      if (!input.tenantId || !Number.isFinite(input.exportedAt) || !validInvariants(input.invariants)) throw new Error("BACKUP_INPUT_INVALID");
      const records = input.records.filter((record) => record.tenantId === input.tenantId).map((record) => ({ ...record })).sort((a, b) => a.value.localeCompare(b.value));
      const id = backupSnapshotId(input.tenantId, input.exportedAt, schemaVersion);
      const invariants = Object.freeze({ authorization: Object.freeze([...input.invariants.authorization]), audit: Object.freeze([...input.invariants.audit]), indexes: Object.freeze([...input.invariants.indexes]), ledger: Object.freeze([...input.invariants.ledger]), deletions: Object.freeze([...input.invariants.deletions]) });
      const snapshot = Object.freeze({ id, tenantId: input.tenantId, exportedAt: input.exportedAt, schemaVersion, ciphertext: crypto.encrypt(JSON.stringify({ version: "encrypted-snapshot/v1", schemaVersion, tenantId: input.tenantId, exportedAt: input.exportedAt, records, invariants })) });
      storage.put(id, snapshot.ciphertext);
      const tenantSnapshots = retained(input.tenantId); tenantSnapshots.push(snapshot); while (tenantSnapshots.length > policy.retainSnapshots) { const expired = tenantSnapshots.shift(); if (expired) storage.remove(expired.id); } snapshots.set(input.tenantId, tenantSnapshots);
      return snapshot;
    },
    async restore(input: { snapshot: EncryptedSnapshot; tenantId: string; authorized: boolean; startedAt: number; completedAt: number; latestWriteAt: number; idempotencyKey?: string; isolated?: boolean }) {
      if (input.authorized !== true) throw new Error("RESTORE_AUTH_REQUIRED");
      const indexed = retained(input.tenantId).find((snapshot) => snapshot.id === input.snapshot.id); if (input.tenantId !== input.snapshot.tenantId || !indexed) throw new Error("RESTORE_TENANT_DENIED");
      if (input.snapshot.schemaVersion !== schemaVersion) throw new Error("RESTORE_SCHEMA_MISMATCH");
      if (indexed.tenantId !== input.snapshot.tenantId || indexed.schemaVersion !== input.snapshot.schemaVersion || indexed.exportedAt !== input.snapshot.exportedAt || indexed.ciphertext !== input.snapshot.ciphertext || input.snapshot.id !== backupSnapshotId(input.snapshot.tenantId, input.snapshot.exportedAt, input.snapshot.schemaVersion)) throw new Error("RESTORE_TENANT_DENIED");
      if (input.isolated === false || !restoreTarget.isolated) throw new Error("RESTORE_ISOLATION_REQUIRED");
      const idempotencyKey = input.idempotencyKey ?? input.snapshot.id;
      const previous = restored.get(`${input.tenantId}\u0000${idempotencyKey}`); if (previous) { if (previous.snapshotId !== input.snapshot.id) throw new Error("RESTORE_IDEMPOTENCY_CONFLICT"); return { ...previous.result, replayed: true as const }; }
      const ciphertext = storage.get(input.snapshot.id); if (ciphertext !== input.snapshot.ciphertext) throw new Error("RESTORE_SNAPSHOT_UNAVAILABLE");
      let payload: { version: string; schemaVersion: string; tenantId: string; exportedAt: number; records: { tenantId: string; value: string }[]; invariants: BackupInvariantContents }; try { payload = JSON.parse(crypto.decrypt(ciphertext)) as typeof payload; } catch { throw new Error("RESTORE_DECRYPTION_FAILED"); }
      const rpoMs = input.snapshot.exportedAt - input.latestWriteAt, rtoMs = input.completedAt - input.startedAt;
      if (payload.version !== "encrypted-snapshot/v1" || !Array.isArray(payload.records) || payload.schemaVersion !== schemaVersion || payload.schemaVersion !== input.snapshot.schemaVersion) throw new Error("RESTORE_SCHEMA_MISMATCH");
      if (!validInvariants(payload.invariants)) throw new Error("RESTORE_SNAPSHOT_INVALID");
      if (payload.tenantId !== input.tenantId || payload.tenantId !== input.snapshot.tenantId || payload.exportedAt !== input.snapshot.exportedAt || payload.records.some((record) => !record || record.tenantId !== input.tenantId || typeof record.value !== "string") || rpoMs < 0 || rpoMs > policy.maxRpoMs || rtoMs < 0 || rtoMs > policy.maxRtoMs) throw new Error("DR_TARGET_VIOLATION");
      await restoreTarget.apply(Object.freeze({ tenantId: payload.tenantId, schemaVersion: payload.schemaVersion, exportedAt: payload.exportedAt, records: Object.freeze(payload.records.map((record) => Object.freeze({ ...record }))), invariants: Object.freeze({ authorization: Object.freeze([...payload.invariants.authorization]), audit: Object.freeze([...payload.invariants.audit]), indexes: Object.freeze([...payload.invariants.indexes]), ledger: Object.freeze([...payload.invariants.ledger]), deletions: Object.freeze([...payload.invariants.deletions]) }) }));
      const result = Object.freeze({ restored: true as const, replayed: false as const, rpoMs, rtoMs, isolated: true as const, recordsRestored: payload.records.length }); restored.set(`${input.tenantId}\u0000${idempotencyKey}`, { snapshotId: input.snapshot.id, result }); audit.append({ action: "backup.restore", tenantId: input.tenantId, snapshotId: input.snapshot.id, idempotencyKey }); return result;
    },
    deleteTenant(tenantId: string) { const tenantSnapshots = retained(tenantId); for (const snapshot of tenantSnapshots) storage.remove(snapshot.id); snapshots.delete(tenantId); for (const key of restored.keys()) if (key.startsWith(`${tenantId}\u0000`)) restored.delete(key); return { deletedSnapshots: tenantSnapshots.length }; },
    retentionCount: (tenantId?: string) => tenantId ? retained(tenantId).length : [...snapshots.values()].reduce((total, entries) => total + entries.length, 0)
  });
}
export function createMigrationController() { const states = new Map<string, "expanded" | "rolled_back">(); return Object.freeze({ expand(version: string) { states.set(version, "expanded"); }, rollback(version: string) { if (states.get(version) !== "expanded") throw new Error("MIGRATION_ROLLBACK_DENIED"); states.set(version, "rolled_back"); return { version, state: "rolled_back" as const }; } }); }
export function createSetupDiagnostics(input: { platform: string; available: readonly string[]; required: readonly string[] }) { return Object.freeze({ run() { const missing = input.required.filter(x => !input.available.includes(x)); return { ready: missing.length === 0, platform: input.platform, missing, featureFlags: { releaseActivation: missing.length === 0, migrations: input.available.includes("node") } }; } }); }

export type UpdateChannel = "canary" | "beta" | "stable";
export type ReleaseUpdateManifest = Readonly<{
  version: "release-update/v1";
  channel: UpdateChannel;
  release: Release;
  versionName: string;
  publishedAt: number;
  checksum: `sha256:${string}`;
  provenance: `sha256:${string}`;
  stable?: Readonly<{ oidc: true; signedProvenance: true }>;
}>;
export type ReleaseWorkerPort = Readonly<{ drain(): Promise<void>; resume(): Promise<void> }>;
export type ReleaseHealthPort = Readonly<{ check(release: Release): Promise<Readonly<{ healthy: boolean; code?: string }>> }>;
export type ReleaseTelemetryPort = Readonly<{ record(event: Readonly<{ event: "update_applied" | "update_rolled_back" | "update_rejected"; channel?: UpdateChannel; releaseId?: string; reason?: string }>): void }>;

function parseReleaseVersion(value: string): readonly [number, number, number] | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}
function releaseVersionIsNewer(candidate: string, active: string): boolean {
  const left = parseReleaseVersion(candidate); const right = parseReleaseVersion(active);
  return !!left && !!right && left.some((part, index) => part !== right[index] && part > right[index]);
}
function assertUpdateManifest(update: ReleaseUpdateManifest): void {
  if (!update || update.version !== "release-update/v1" || !["canary", "beta", "stable"].includes(update.channel) || !parseReleaseVersion(update.versionName) || !Number.isFinite(update.publishedAt) || update.publishedAt <= 0 || !/^sha256:[a-f0-9]+$/i.test(update.checksum) || update.provenance !== update.release?.manifest?.provenance) throw new Error("UPDATE_TAMPERED");
  if (update.channel === "stable" && (update.stable?.oidc !== true || update.stable.signedProvenance !== true)) throw new Error("UPDATE_STABLE_PROVENANCE_REQUIRED");
}
/** Fail-closed updater: verified manifests, monotonic versions, worker drain/resume and health-triggered rollback. */
export function createSecureUpdateController(options: Readonly<{ current: Release; currentVersion: string; trustedKeys: TrustedReleaseKeys; signatureVerifier: SignatureVerifierPort; runtimeCapabilities: readonly string[]; worker: ReleaseWorkerPort; health: ReleaseHealthPort; telemetry?: ReleaseTelemetryPort }>) {
  if (!options?.current || !parseReleaseVersion(options.currentVersion) || !options.worker || typeof options.worker.drain !== "function" || typeof options.worker.resume !== "function" || !options.health || typeof options.health.check !== "function") throw new Error("UPDATE_PORTS_REQUIRED");
  const releases = createReleaseController({ trustedKeys: options.trustedKeys, signatureVerifier: options.signatureVerifier, runtimeCapabilities: options.runtimeCapabilities });
  let initialized: Promise<void> | undefined;
  let activeVersion = options.currentVersion;
  const report = (event: Parameters<ReleaseTelemetryPort["record"]>[0]) => options.telemetry?.record(Object.freeze({ ...event }));
  const initialize = async () => { initialized ??= releases.activate(options.current).then(() => undefined); await initialized; };
  return Object.freeze({
    async install(update: ReleaseUpdateManifest) {
      try {
        assertUpdateManifest(update);
        if (!releaseVersionIsNewer(update.versionName, activeVersion)) throw new Error("UPDATE_DOWNGRADE_DENIED");
        await initialize();
        if (!await verifyReleaseManifest(update.release, options.trustedKeys, options.signatureVerifier)) throw new Error("UPDATE_SIGNATURE_INVALID");
        await options.worker.drain();
        try {
          await releases.activate(update.release);
          const health = await options.health.check(update.release);
          if (!health.healthy) {
            await releases.rollback(options.current.manifest.id, { approvedBy: "health-rollback", timestamp: update.publishedAt });
            report({ event: "update_rolled_back", channel: update.channel, releaseId: update.release.manifest.id, reason: health.code ?? "UPDATE_HEALTH_FAILED" });
            return Object.freeze({ outcome: "rolled_back" as const, activeVersion, reason: health.code ?? "UPDATE_HEALTH_FAILED" });
          }
          activeVersion = update.versionName;
          report({ event: "update_applied", channel: update.channel, releaseId: update.release.manifest.id });
          return Object.freeze({ outcome: "applied" as const, activeVersion });
        } finally { await options.worker.resume(); }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "UPDATE_REJECTED";
        report({ event: "update_rejected", channel: update?.channel, releaseId: update?.release?.manifest?.id, reason });
        throw error;
      }
    },
    diagnostics: () => Object.freeze({ activeVersion, activeReleaseId: releases.active()?.manifest.id, state: releases.active() ? "ready" as const : "uninitialized" as const })
  });
}


