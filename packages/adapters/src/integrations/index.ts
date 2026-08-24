/** Provider-neutral integration ports; secrets never become policy or prompt metadata. */
import type { ProtectedVaultPort } from "../../../assurance/src/index.js";
export type IntegrationProvider = "composio" | "sendblue" | "apple";
export type ConnectionState = "pending" | "active" | "failed" | "revoked";
export type DeliveryState = "queued" | "sent" | "delivered" | "error" | "unknown";
export type IntegrationPolicy = Readonly<{ tenantId: string; userId: string; scopes: readonly string[]; toolkitVersion: string }>;
export type IntegrationConnection = Readonly<IntegrationPolicy & { id: string; provider: IntegrationProvider; externalAccountId: string; state: ConnectionState }>;
export type IntegrationCapabilityContract = Readonly<{ version: "integration-capability/v1"; capabilities: readonly string[]; limits: Readonly<Record<string, number>>; credentialReference: `vault://${IntegrationProvider}`; health(): Promise<{ healthy: boolean; code?: string }> }>;
export type IntegrationProviderPort = Readonly<{
  provider: IntegrationProvider; toolkitVersion: string; capability: IntegrationCapabilityContract;
  connect(input: { tenantId: string; userId: string; scopes: readonly string[]; authorizationCode: string }): Promise<{ externalAccountId: string }>;
  execute(input: { connection: IntegrationConnection; operation: string; idempotencyKey: string; metadata: Readonly<Record<string, string>> }): Promise<{ providerDeliveryId?: string; state: Exclude<DeliveryState, "queued" | "unknown">; costMicros: number; latencyMs: number }>;
  reconcile(input: { connection: IntegrationConnection; providerDeliveryId?: string; idempotencyKey: string }): Promise<{ providerDeliveryId?: string; state: Exclude<DeliveryState, "queued"> }>;
}>;
export type IntegrationAudit = Readonly<{ idempotencyKey: string; costMicros: number; latencyMs: number; providerDeliveryId?: string }>;
export type ProviderSecretPort = Readonly<{ getSecret(provider: IntegrationProvider): string | undefined }>;
export function createProviderSecretPort(config: Readonly<Partial<Record<IntegrationProvider, string | undefined>>>): ProviderSecretPort {
  const secrets = Object.freeze({ ...config });
  return Object.freeze({ getSecret: (provider) => { const secret = secrets[provider]; return typeof secret === "string" && secret.trim().length > 0 ? secret : undefined; } });
}
type ControllerResult = Readonly<{ state: ConnectionState | DeliveryState | "denied"; code?: string; toolkitVersion?: string; audit?: IntegrationAudit }>;

const secretMetadata = /(?:token|secret|authorization|password|api[-_]?key)/i;
const e164 = /^\+[1-9]\d{7,14}$/;
const webhookWindowMs = 5 * 60 * 1000;
function deterministicConnectionId(provider: IntegrationProvider, tenantId: string, userId: string) { return `connection-${provider}-${tenantId}-${userId}`; }
function containsSecret(value: unknown): boolean {
  if (typeof value === "string") return secretMetadata.test(value);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => secretMetadata.test(key) || containsSecret(nested));
}
function validMetadata(metadata: Readonly<Record<string, string>>) { return !containsSecret(metadata); }

function validCapabilityContract(contract: IntegrationCapabilityContract): boolean { return contract.version === "integration-capability/v1" && contract.capabilities.length > 0 && Object.keys(contract.limits).length > 0 && contract.credentialReference.startsWith("vault://") && Object.values(contract.limits).every((limit) => Number.isFinite(limit) && limit >= 0) && typeof contract.health === "function"; }
export function createIntegrationController(options: { providers: readonly IntegrationProviderPort[] }) {
  if (!options?.providers?.every((provider) => validCapabilityContract(provider.capability))) throw new Error("INTEGRATION_CAPABILITY_CONTRACT_INVALID");
  const providers = new Map(options.providers.map((provider) => [provider.provider, provider])); const connections = new Map<string, IntegrationConnection>();
  return Object.freeze({
    connect: async (input: { provider: IntegrationProvider; tenantId: string; userId: string; scopes: readonly string[]; authorizationCode: string }): Promise<ControllerResult & Partial<IntegrationConnection>> => {
      const provider = providers.get(input.provider); if (!provider) return { state: "failed", code: "INTEGRATION_PROVIDER_UNAVAILABLE" };
      try { const external = await provider.connect(input); const connection: IntegrationConnection = Object.freeze({ id: deterministicConnectionId(input.provider, input.tenantId, input.userId), provider: input.provider, tenantId: input.tenantId, userId: input.userId, scopes: Object.freeze([...input.scopes]), toolkitVersion: provider.toolkitVersion, externalAccountId: external.externalAccountId, state: "active" }); connections.set(connection.id, connection); return connection; } catch { return { state: "failed", code: "INTEGRATION_CONNECTION_FAILED" }; }
    },
    execute: async (input: { provider: IntegrationProvider; tenantId: string; userId: string; connectionId: string; operation: string; idempotencyKey: string; metadata: Readonly<Record<string, string>>; toolInput?: unknown }): Promise<ControllerResult> => {
      const connection = connections.get(input.connectionId); const provider = providers.get(input.provider);
      if (!connection || !provider || connection.provider !== input.provider || connection.tenantId !== input.tenantId || connection.userId !== input.userId || connection.state !== "active") return { state: "denied", code: "INTEGRATION_CONNECTION_DENIED" };
      if (!connection.scopes.includes(input.operation)) return { state: "denied", code: "INTEGRATION_SCOPE_DENIED" };
      if (containsSecret(input.toolInput) || !validMetadata(input.metadata)) return { state: "denied", code: "INTEGRATION_SECRET_INPUT_DENIED" };
      const result = await provider.execute({ connection, operation: input.operation, idempotencyKey: input.idempotencyKey, metadata: input.metadata }); return { state: result.state, audit: { idempotencyKey: input.idempotencyKey, costMicros: result.costMicros, latencyMs: result.latencyMs, providerDeliveryId: result.providerDeliveryId } };
    },
    reconcile: async (input: { provider: IntegrationProvider; connectionId: string; idempotencyKey: string; providerDeliveryId?: string }): Promise<ControllerResult> => { const connection = connections.get(input.connectionId); const provider = providers.get(input.provider); return !connection || !provider ? { state: "denied", code: "INTEGRATION_CONNECTION_DENIED" } : provider.reconcile({ connection, idempotencyKey: input.idempotencyKey, providerDeliveryId: input.providerDeliveryId }); }
  });
}

function hex(bytes: Uint8Array) { return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function equalConstantTime(left: Uint8Array, right: Uint8Array) { if (left.length !== right.length) return false; let mismatch = 0; for (let index = 0; index < left.length; index += 1) mismatch |= left[index] ^ right[index]; return mismatch === 0; }
export async function createWebhookSignature(provider: IntegrationProvider, secret: string, payload: string, timestamp: number): Promise<string> { const encoder = new TextEncoder(); const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${provider}.${timestamp}.${payload}`)))); }
export async function verifyWebhook(input: { provider: IntegrationProvider; payload: string; signature: string; providerSecrets: ProviderSecretPort; timestamp: number; now: number; replayKeys: ReadonlySet<string> }): Promise<{ accepted: true; eventId: string } | { accepted: false; code: string }> {
  if (input.payload.length > 16_384) return { accepted: false, code: "WEBHOOK_PAYLOAD_TOO_LARGE" }; if (Math.abs(input.now - input.timestamp) > webhookWindowMs) return { accepted: false, code: "WEBHOOK_TIMESTAMP_INVALID" };
  let eventId = ""; try { eventId = JSON.parse(input.payload).id; } catch { return { accepted: false, code: "WEBHOOK_PAYLOAD_INVALID" }; }
  const replayKey = `${input.provider}:${eventId}`; if (!eventId || input.replayKeys.has(replayKey)) return { accepted: false, code: "WEBHOOK_REPLAY" };
  const secret = input.providerSecrets.getSecret(input.provider); if (!secret) return { accepted: false, code: "WEBHOOK_PROVIDER_UNCONFIGURED" };
  const expected = await createWebhookSignature(input.provider, secret, input.payload, input.timestamp); const actual = new Uint8Array(input.signature.match(/.{1,2}/g)?.map((value) => Number.parseInt(value, 16)) ?? []); const expectedBytes = new Uint8Array(expected.match(/.{1,2}/g)?.map((value) => Number.parseInt(value, 16)) ?? []);
  return equalConstantTime(actual, expectedBytes) ? { accepted: true, eventId } : { accepted: false, code: "WEBHOOK_SIGNATURE_INVALID" };
}export function redactIntegrationPayload(payload: string) { return payload.replace(/("?(?:token|secret|authorization|password|api[-_]?key)"?\s*[:=]\s*)"?[^",}\s]+"?/gi, "$1[REDACTED]"); }
export function appleCapabilityMatrix(input: { platform: "ios" | "macos" | "other"; permission: "granted" | "denied" | "unknown"; consent: "granted" | "denied" }) { const available = input.consent === "granted" && input.permission === "granted"; return Object.freeze({ notes: { available: available && input.platform === "macos", fallback: input.consent === "denied" ? "manual_export" : input.permission === "denied" ? "ask_permission" : "unsupported_platform" }, shortcuts: { available: available && input.platform !== "other", fallback: available ? "manual_shortcut" : "ask_permission" }, iMessage: { available: false, fallback: "manual_share" } }); }
export const integrationToolMetadata = Object.freeze({ version: "integration-policy/v2", noTokensInPrompts: true, audit: ["idempotencyKey", "costMicros", "latencyMs"] as const });
export function createIntegrationCapabilityContract(provider: IntegrationProvider, capabilities: readonly string[], limits: Readonly<Record<string, number>>): IntegrationCapabilityContract { return Object.freeze({ version: "integration-capability/v1", capabilities: Object.freeze([...capabilities]), limits: Object.freeze({ ...limits }), credentialReference: `vault://${provider}`, health: async () => ({ healthy: true }) }); }
type VaultBound = Readonly<{ vault: ProtectedVaultPort }>;
function requireVault(vault: ProtectedVaultPort | undefined): ProtectedVaultPort { if (!vault || typeof vault.get !== "function") throw new Error("PROTECTED_VAULT_REQUIRED"); if (vault.boundary !== "production") throw new Error("PROTECTED_VAULT_PRODUCTION_REQUIRED"); return vault; }
function requiredCredential(vault: ProtectedVaultPort | undefined, tenantId: string, provider: IntegrationProvider): string | undefined { const result = requireVault(vault).get(tenantId, provider); return result.status === "available" ? result.value : undefined; }
export type SendblueHost = VaultBound & { connect: (input: { tenantId: string; userId: string; scopes: readonly string[]; authorizationCode: string }) => Promise<string>; lookupDestinationCapability: (destination: string) => Promise<{ capable: boolean }>; send: (input: { destination: string; idempotencyKey: string; credential: string }) => Promise<{ state: "sent" | "delivered" | "error"; costMicros: number; latencyMs: number; providerDeliveryId?: string }>; status: (input: { idempotencyKey: string; providerDeliveryId?: string }) => Promise<{ state: "sent" | "delivered" | "error" | "unknown"; providerDeliveryId?: string }> };
export function createSendblueAdapter(host: SendblueHost): IntegrationProviderPort { requireVault(host?.vault); return Object.freeze({ provider: "sendblue", toolkitVersion: "api", capability: createIntegrationCapabilityContract("sendblue", ["message.send", "message.reconcile"], { maxDestinationLength: 16, maxRequestsPerMinute: 60 }), connect: async (input) => ({ externalAccountId: await host.connect(input) }), execute: async (input) => { const credential = requiredCredential(host.vault, input.connection.tenantId, "sendblue"); const destination = input.metadata.destination ?? ""; if (!credential || !e164.test(destination) || !(await host.lookupDestinationCapability(destination)).capable) return { state: "error", costMicros: 0, latencyMs: 0 }; return host.send({ destination, idempotencyKey: input.idempotencyKey, credential }); }, reconcile: async (input) => host.status(input) }); }
export type ComposioHost = VaultBound & { toolkitVersion: string; connect: (input: { tenantId: string; userId: string; scopes: readonly string[]; authorizationCode: string }) => Promise<string>; execute: (input: { operation: string; idempotencyKey: string; metadata: Readonly<Record<string, string>>; credential: string }) => Promise<{ state: "sent" | "delivered" | "error"; costMicros: number; latencyMs: number }>; reconcile: (input: { idempotencyKey: string; providerDeliveryId?: string }) => Promise<{ state: "sent" | "delivered" | "error"; providerDeliveryId?: string }> };
export function createComposioAdapter(host: ComposioHost): IntegrationProviderPort { requireVault(host?.vault); if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(host.toolkitVersion)) throw new Error("COMPOSIO_TOOLKIT_VERSION_INVALID"); return Object.freeze({ provider: "composio", toolkitVersion: host.toolkitVersion, capability: createIntegrationCapabilityContract("composio", ["tool.execute", "tool.reconcile"], { maxMetadataEntries: 32, maxRequestsPerMinute: 60 }), connect: async (input) => ({ externalAccountId: await host.connect(input) }), execute: async (input) => { const credential = requiredCredential(host.vault, input.connection.tenantId, "composio"); return credential ? host.execute({ operation: input.operation, idempotencyKey: input.idempotencyKey, metadata: input.metadata, credential }) : { state: "error", costMicros: 0, latencyMs: 0 }; }, reconcile: async (input) => host.reconcile(input) }); }
export type AppleHost = VaultBound & { execute: (input: { operation: string; idempotencyKey: string; metadata: Readonly<Record<string, string>>; credential: string }) => Promise<{ state: "sent" | "delivered" | "error"; costMicros: number; latencyMs: number }> };
export function createAppleAdapter(host: AppleHost): IntegrationProviderPort {
  requireVault(host?.vault);
  const adapter: IntegrationProviderPort = {
    provider: "apple",
    toolkitVersion: "capability-matrix/v1",
    capability: createIntegrationCapabilityContract("apple", ["notes", "shortcuts"], { maxRequestsPerMinute: 30, maxPayloadChars: 16_384 }),
    connect: async () => ({ externalAccountId: "local-consent" }),
    execute: async (input) => {
      const credential = requiredCredential(host.vault, input.connection.tenantId, "apple");
      return credential ? host.execute({ operation: input.operation, idempotencyKey: input.idempotencyKey, metadata: input.metadata, credential }) : { state: "error", costMicros: 0, latencyMs: 0 };
    },
    reconcile: async () => ({ state: "unknown" })
  };
  return Object.freeze(adapter);
}
export function createProductionIntegrationAdapters(input: Readonly<{ vault: ProtectedVaultPort; composio: Omit<ComposioHost, "vault">; sendblue: Omit<SendblueHost, "vault">; apple: Omit<AppleHost, "vault"> }>): readonly IntegrationProviderPort[] { if (!input?.vault) throw new Error("PROTECTED_VAULT_REQUIRED"); return Object.freeze([createComposioAdapter({ ...input.composio, vault: input.vault }), createSendblueAdapter({ ...input.sendblue, vault: input.vault }), createAppleAdapter({ ...input.apple, vault: input.vault })]); }
