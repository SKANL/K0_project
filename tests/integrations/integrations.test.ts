import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { convexTest } from "convex-test";
import schema from "../../convex/schema.js";
import { api } from "../../convex/_generated/api.js";
import {
  appleCapabilityMatrix,
  createAppleAdapter,
  createComposioAdapter,
  createIntegrationController,
  createProductionIntegrationAdapters,
  createProviderSecretPort,
  createSendblueAdapter,
  createWebhookSignature,
  verifyWebhook,
  type IntegrationProviderPort,
  type IntegrationCapabilityContract,
} from "../../packages/adapters/src/integrations/index.js";
import { createProtectedVaultPort, createTestOnlyInMemoryVault } from "../../packages/assurance/src/index.js";

const modules = import.meta.glob("../../convex/**/*.ts");
const NOW = 1_741_506_400_000;

function testProductionVault() {
  const values = new Map<string, string>();
  return createProtectedVaultPort({
    put: (tenantId, key, value) => values.set(`${tenantId}\u0000${key}`, value),
    get: (tenantId, key) => values.get(`${tenantId}\u0000${key}`)
  });
}

function provider(): IntegrationProviderPort {
  return { provider: "sendblue", toolkitVersion: "2026-08", capability: { version: "integration-capability/v1", capabilities: ["message.send"], limits: { maxRequests: 1 }, credentialReference: "vault://sendblue", health: async () => ({ healthy: true }) }, connect: async () => ({ externalAccountId: "account-1" }), execute: async () => ({ providerDeliveryId: "delivery-1", state: "sent", costMicros: 12, latencyMs: 34 }), reconcile: async () => ({ state: "delivered", providerDeliveryId: "delivery-1" }) };
}

async function setup() {
  const t = convexTest(schema, modules);
  const workspaceA = await t.run((ctx) => ctx.db.insert("workspaces", { slug: "a", status: "active", version: 0 }));
  const workspaceB = await t.run((ctx) => ctx.db.insert("workspaces", { slug: "b", status: "active", version: 0 }));
  const suspendedWorkspace = await t.run((ctx) => ctx.db.insert("workspaces", { slug: "suspended", status: "suspended", version: 0 }));
  await t.run(async (ctx) => {
    await ctx.db.insert("memberships", { workspaceId: workspaceA, subject: "alice", role: "admin", status: "active" });
    await ctx.db.insert("memberships", { workspaceId: workspaceA, subject: "stale", role: "editor", status: "stale" });
    await ctx.db.insert("memberships", { workspaceId: workspaceB, subject: "bob", role: "admin", status: "active" });
    await ctx.db.insert("memberships", { workspaceId: workspaceA, subject: "revoked", role: "editor", status: "revoked" });
    await ctx.db.insert("memberships", { workspaceId: suspendedWorkspace, subject: "alice", role: "admin", status: "active" });
  });
  return { t, workspaceA, workspaceB, suspendedWorkspace };
}

describe("integration remediation", () => {
  it("keeps the portable adapter free of static Node crypto imports", async () => {
    const source = await readFile(new URL("../../packages/adapters/src/integrations/index.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from\s+["']node:crypto["']/);
  });

  it("rejects secrets in runtime tool inputs instead of relying on metadata and validates Sendblue capability before E.164 sending", async () => {
    const controller = createIntegrationController({ providers: [provider()] });
    const connected = await controller.connect({ provider: "sendblue", tenantId: "tenant-a", userId: "alice", scopes: ["message.send"], authorizationCode: "secret" });
    await expect(controller.execute({ provider: "sendblue", tenantId: "tenant-a", userId: "alice", connectionId: connected.id!, operation: "message.send", idempotencyKey: "delivery-a", metadata: { destination: "+15551234567" } })).resolves.toMatchObject({ state: "sent", audit: { costMicros: 12, latencyMs: 34 } });
    await expect(controller.execute({ provider: "sendblue", tenantId: "tenant-a", userId: "alice", connectionId: connected.id!, operation: "message.send", idempotencyKey: "delivery-b", metadata: { destination: "+15551234567" }, toolInput: { apiKey: "do-not-leak" } as any })).resolves.toMatchObject({ state: "denied", code: "INTEGRATION_SECRET_INPUT_DENIED" });
    const adapter = createSendblueAdapter({ vault: testProductionVault(), connect: async () => "s", lookupDestinationCapability: async () => ({ capable: true }), send: async () => ({ state: "sent", costMicros: 1, latencyMs: 2 }), status: async () => ({ state: "delivered" }) });
    await expect(adapter.execute({ connection: connected as any, operation: "message.send", idempotencyKey: "x", metadata: { destination: "bad" } })).resolves.toMatchObject({ state: "error" });
    expect(appleCapabilityMatrix({ platform: "ios", permission: "granted", consent: "granted" }).iMessage).toMatchObject({ available: false, fallback: "manual_share" });
  });

  it("enforces an auth-derived tenant boundary through public connection and delivery APIs", async () => {
    const { t, workspaceA, workspaceB } = await setup();
    const alice = t.withIdentity({ subject: "alice" });
    const anonymous = t;
    await expect(anonymous.mutation(api.integrations.upsertConnection, { workspaceId: workspaceA, connectionId: "conn-a", provider: "sendblue", scopes: ["message.send"], toolkitVersion: "2026-08", now: NOW })).rejects.toThrow("AUTH_REQUIRED");
    await expect(t.withIdentity({ subject: "stale" }).mutation(api.integrations.upsertConnection, { workspaceId: workspaceA, connectionId: "conn-a", provider: "sendblue", scopes: [], toolkitVersion: "2026-08", now: NOW })).rejects.toThrow("MEMBERSHIP_STALE");
    await expect(t.withIdentity({ subject: "revoked" }).mutation(api.integrations.upsertConnection, { workspaceId: workspaceA, connectionId: "conn-a", provider: "sendblue", scopes: [], toolkitVersion: "2026-08", now: NOW })).rejects.toThrow("MEMBERSHIP_REVOKED");
    await expect(t.withIdentity({ subject: "bob" }).mutation(api.integrations.upsertConnection, { workspaceId: workspaceA, connectionId: "conn-a", provider: "sendblue", scopes: [], toolkitVersion: "2026-08", now: NOW })).rejects.toThrow("TENANT_ACCESS_DENIED");
    const created = await alice.mutation(api.integrations.upsertConnection, { workspaceId: workspaceA, connectionId: "conn-a", provider: "sendblue", scopes: ["message.send"], toolkitVersion: "2026-08", now: NOW });
    expect(created).toMatchObject({ state: "active", replay: false });
    await expect(alice.mutation(api.integrations.queueDelivery, { workspaceId: workspaceB, connectionId: "conn-a", idempotencyKey: "delivery-a", destination: "+15551234567", now: NOW })).rejects.toThrow("TENANT_ACCESS_DENIED");
    expect(await alice.mutation(api.integrations.queueDelivery, { workspaceId: workspaceA, connectionId: "conn-a", idempotencyKey: "delivery-a", destination: "+15551234567", now: NOW })).toMatchObject({ state: "queued", replay: false });
  });

  it("replays connection records, tracks scope/toolkit changes, and refuses revoked or failed connections", async () => {
    const { t, workspaceA } = await setup(); const alice = t.withIdentity({ subject: "alice" });
    await expect(alice.mutation(api.integrations.upsertConnection, { workspaceId: workspaceA, connectionId: "conn-a", provider: "sendblue", scopes: ["message.send"], toolkitVersion: "2026-08", now: NOW })).resolves.toMatchObject({ state: "active", replay: false });
    await expect(alice.mutation(api.integrations.upsertConnection, { workspaceId: workspaceA, connectionId: "conn-a", provider: "sendblue", scopes: ["message.send", "message.status"], toolkitVersion: "2026-09", now: NOW + 1 })).resolves.toMatchObject({ state: "active", replay: true });
    await expect(alice.mutation(api.integrations.upsertConnection, { workspaceId: workspaceA, connectionId: "conn-a", provider: "sendblue", scopes: [], toolkitVersion: "2026-09", state: "revoked", now: NOW + 2 })).resolves.toMatchObject({ state: "revoked", replay: true });
    await expect(alice.mutation(api.integrations.queueDelivery, { workspaceId: workspaceA, connectionId: "conn-a", idempotencyKey: "revoked", destination: "+15551234567", now: NOW + 3 })).rejects.toThrow("INTEGRATION_CONNECTION_DENIED");
    await expect(alice.mutation(api.integrations.upsertConnection, { workspaceId: workspaceA, connectionId: "conn-a", provider: "sendblue", scopes: [], toolkitVersion: "2026-09", state: "failed", now: NOW + 4 })).resolves.toMatchObject({ state: "failed", replay: true });
  });

  it("denies authenticated inactive workspaces and reads persisted connection lifecycle across a fresh public boundary", async () => {
    const { t, workspaceA, suspendedWorkspace } = await setup();
    const alice = t.withIdentity({ subject: "alice" });
    await expect(alice.mutation(api.integrations.upsertConnection, { workspaceId: suspendedWorkspace, connectionId: "conn-suspended", provider: "sendblue", scopes: ["message.send"], toolkitVersion: "2026-08", now: NOW })).rejects.toThrow("WORKSPACE_INACTIVE");
    await alice.mutation(api.integrations.upsertConnection, { workspaceId: workspaceA, connectionId: "conn-durable", provider: "sendblue", scopes: ["message.send"], toolkitVersion: "2026-08", now: NOW });
    await alice.mutation(api.integrations.upsertConnection, { workspaceId: workspaceA, connectionId: "conn-durable", provider: "sendblue", scopes: ["message.send", "message.status"], toolkitVersion: "2026-09", now: NOW + 1 });
    const freshAlice = t.withIdentity({ subject: "alice" });
    await expect(freshAlice.query(api.integrations.getConnection, { workspaceId: workspaceA, connectionId: "conn-durable" })).resolves.toMatchObject({ connectionId: "conn-durable", userId: "alice", state: "active", scopes: ["message.send", "message.status"], toolkitVersion: "2026-09", updatedAt: NOW + 1, createdAt: NOW });
    await expect(t.withIdentity({ subject: "stale" }).query(api.integrations.getConnection, { workspaceId: workspaceA, connectionId: "conn-durable" })).rejects.toThrow("MEMBERSHIP_STALE");
  });

  it("admits only signatures verified against trusted provider configuration, with atomic provider-scoped dedupe", async () => {
    const { t, workspaceA } = await setup();
    const alice = t.withIdentity({ subject: "alice" });
    const payload = JSON.stringify({ id: "event-1", token: "redact-me", event: "message.sent" });
    const configured = createProviderSecretPort({ sendblue: "configured-webhook-secret", composio: "composio-webhook-secret", apple: "apple-webhook-secret" });
    process.env.SENDBLUE_WEBHOOK_SECRET = "configured-webhook-secret"; process.env.COMPOSIO_WEBHOOK_SECRET = "composio-webhook-secret";
    const configuredSignature = await createWebhookSignature("sendblue", configured.getSecret("sendblue")!, payload, NOW);
    await expect(verifyWebhook({ provider: "sendblue", payload, signature: configuredSignature, providerSecrets: configured, timestamp: NOW, now: NOW, replayKeys: new Set() })).resolves.toMatchObject({ accepted: true, eventId: "event-1" });
    const forgedSignature = await createWebhookSignature("sendblue", "caller-forged-secret", payload, NOW);
    await expect(alice.mutation(api.integrations.admitWebhook, { workspaceId: workspaceA, provider: "sendblue", payload, signature: forgedSignature, timestamp: NOW, now: NOW })).resolves.toMatchObject({ accepted: false, code: "WEBHOOK_SIGNATURE_INVALID" });
    await expect(alice.mutation(api.integrations.admitWebhook, { workspaceId: workspaceA, provider: "sendblue", payload, signature: configuredSignature, timestamp: NOW, now: NOW, secret: "caller-forged-secret" } as any)).rejects.toThrow();
    await expect(alice.mutation(api.integrations.admitWebhook, { workspaceId: workspaceA, provider: "sendblue", payload, signature: configuredSignature, timestamp: NOW, now: NOW })).resolves.toMatchObject({ accepted: true, replay: false });
    await expect(alice.mutation(api.integrations.admitWebhook, { workspaceId: workspaceA, provider: "sendblue", payload, signature: configuredSignature, timestamp: NOW, now: NOW })).resolves.toMatchObject({ accepted: false, code: "WEBHOOK_REPLAY" });
    const composioSignature = await createWebhookSignature("composio", configured.getSecret("composio")!, payload, NOW);
    await expect(alice.mutation(api.integrations.admitWebhook, { workspaceId: workspaceA, provider: "composio", payload, signature: composioSignature, timestamp: NOW, now: NOW })).resolves.toMatchObject({ accepted: true, replay: false });
    const inbox = await t.run((ctx) => ctx.db.query("integrationInbox").withIndex("by_workspace_provider_event", (q: any) => q.eq("workspaceId", workspaceA).eq("provider", "sendblue").eq("eventId", "event-1")).unique());
    expect(inbox?.payload).toContain("[REDACTED]"); expect(inbox?.payload).not.toContain("redact-me");
  });

  it("requires a non-empty semantic Composio toolkit version and persists it on the connection", async () => {
    const vault = testProductionVault();
    expect(() => createComposioAdapter({ vault, toolkitVersion: "pinned", connect: async () => "account", execute: async () => ({ state: "sent", costMicros: 1, latencyMs: 1 }), reconcile: async () => ({ state: "sent" }) })).toThrow("COMPOSIO_TOOLKIT_VERSION_INVALID");
    const adapter = createComposioAdapter({ vault, toolkitVersion: "2026.9.1", connect: async () => "account", execute: async () => ({ state: "sent", costMicros: 1, latencyMs: 1 }), reconcile: async () => ({ state: "sent" }) });
    const controller = createIntegrationController({ providers: [adapter] });
    const connection = await controller.connect({ provider: "composio", tenantId: "tenant", userId: "alice", scopes: ["calendar.read"], authorizationCode: "code" });
    expect(connection).toMatchObject({ toolkitVersion: "2026.9.1", state: "active" });
    const { t, workspaceA } = await setup(); const alice = t.withIdentity({ subject: "alice" });
    await expect(alice.mutation(api.integrations.upsertConnection, { workspaceId: workspaceA, connectionId: "composio-1", provider: "composio", scopes: ["calendar.read"], toolkitVersion: "pinned", now: NOW })).rejects.toThrow("COMPOSIO_TOOLKIT_VERSION_INVALID");
    await alice.mutation(api.integrations.upsertConnection, { workspaceId: workspaceA, connectionId: "composio-1", provider: "composio", scopes: ["calendar.read"], toolkitVersion: "2026.9.1", now: NOW });
    await expect(alice.query(api.integrations.getConnection, { workspaceId: workspaceA, connectionId: "composio-1" })).resolves.toMatchObject({ toolkitVersion: "2026.9.1", createdAt: NOW });
  });

  it("uses fenced leases, retry scheduling, monotonic reconciliation, and persisted audits", async () => {
    const { t, workspaceA } = await setup(); const alice = t.withIdentity({ subject: "alice" });
    await alice.mutation(api.integrations.upsertConnection, { workspaceId: workspaceA, connectionId: "conn-a", provider: "sendblue", scopes: ["message.send"], toolkitVersion: "2026-08", now: NOW });
    await alice.mutation(api.integrations.queueDelivery, { workspaceId: workspaceA, connectionId: "conn-a", idempotencyKey: "delivery-a", destination: "+15551234567", now: NOW });
    const lease = await alice.mutation(api.integrations.claimDelivery, { workspaceId: workspaceA, idempotencyKey: "delivery-a", workerId: "worker-a", now: NOW, leaseMs: 60_000 });
    expect(lease).toMatchObject({ acquired: true, fence: 1 });
    await expect(alice.mutation(api.integrations.reconcileDelivery, { workspaceId: workspaceA, idempotencyKey: "delivery-a", fence: 1, providerDeliveryId: "provider-1", state: "sent", costMicros: 8, latencyMs: 21, now: NOW + 1 })).resolves.toMatchObject({ state: "sent" });
    await expect(alice.mutation(api.integrations.reconcileDelivery, { workspaceId: workspaceA, idempotencyKey: "delivery-a", fence: 1, providerDeliveryId: "provider-1", state: "queued", costMicros: 0, latencyMs: 0, now: NOW + 2 })).resolves.toMatchObject({ state: "sent" });
    await expect(alice.mutation(api.integrations.reconcileDelivery, { workspaceId: workspaceA, idempotencyKey: "delivery-a", fence: 0, providerDeliveryId: "provider-1", state: "error", costMicros: 0, latencyMs: 0, now: NOW + 3 })).rejects.toThrow("OUTBOX_FENCE_DENIED");
    await expect(alice.mutation(api.integrations.reconcileDelivery, { workspaceId: workspaceA, idempotencyKey: "delivery-a", fence: 1, providerDeliveryId: "provider-1", state: "unknown", costMicros: 13, latencyMs: 55, now: NOW + 4 })).resolves.toMatchObject({ state: "unknown" });
    const retried = await t.run((ctx) => ctx.db.query("integrationOutbox").withIndex("by_workspace_key", (q: any) => q.eq("workspaceId", workspaceA).eq("idempotencyKey", "delivery-a")).unique());
    expect(retried).toMatchObject({ state: "unknown", provider: "sendblue", providerDeliveryId: "provider-1", auditCostMicros: 13, auditLatencyMs: 55, nextAttemptAt: NOW + 2_004 });
    await expect(alice.mutation(api.integrations.claimDelivery, { workspaceId: workspaceA, idempotencyKey: "delivery-a", workerId: "worker-early", now: NOW + 2_003, leaseMs: 60_000 })).resolves.toMatchObject({ acquired: false, fence: 1 });
    const retryLease = await alice.mutation(api.integrations.claimDelivery, { workspaceId: workspaceA, idempotencyKey: "delivery-a", workerId: "worker-b", now: NOW + 2_004, leaseMs: 60_000 });
    await expect(alice.mutation(api.integrations.reconcileDelivery, { workspaceId: workspaceA, idempotencyKey: "delivery-a", fence: retryLease.fence, providerDeliveryId: "provider-1", state: "delivered", costMicros: 21, latencyMs: 34, now: NOW + 60_002 })).resolves.toMatchObject({ state: "delivered" });
    await expect(alice.mutation(api.integrations.reconcileDelivery, { workspaceId: workspaceA, idempotencyKey: "delivery-a", fence: retryLease.fence, providerDeliveryId: "provider-1", state: "error", costMicros: 0, latencyMs: 0, now: NOW + 60_003 })).resolves.toMatchObject({ state: "delivered" });
  });

  it("denies a Sendblue destination without capability and preserves provider delivery reconciliation semantics", async () => {
    const adapter = createSendblueAdapter({ vault: testProductionVault(), connect: async () => "account", lookupDestinationCapability: async () => ({ capable: false }), send: async () => ({ state: "sent", costMicros: 1, latencyMs: 2, providerDeliveryId: "should-not-send" }), status: async () => ({ state: "unknown", providerDeliveryId: "delivery-2" }) });
    const connection = { id: "conn", provider: "sendblue", tenantId: "tenant", userId: "user", scopes: ["message.send"], toolkitVersion: "api", externalAccountId: "account", state: "active" } as const;
    await expect(adapter.execute({ connection, operation: "message.send", idempotencyKey: "delivery-2", metadata: { destination: "+15551234567" } })).resolves.toMatchObject({ state: "error", costMicros: 0, latencyMs: 0 });
    await expect(adapter.reconcile({ connection, idempotencyKey: "delivery-2", providerDeliveryId: "delivery-2" })).resolves.toEqual({ state: "unknown", providerDeliveryId: "delivery-2" });
  });

  it("uses one health, limits, and credential-reference capability contract for every provider", async () => {
    const vault = testProductionVault();
    const composio = createComposioAdapter({ vault, toolkitVersion: "2026.9.1", connect: async () => "account", execute: async () => ({ state: "sent", costMicros: 1, latencyMs: 1 }), reconcile: async () => ({ state: "sent" }) });
    const sendblue = createSendblueAdapter({ vault, connect: async () => "account", lookupDestinationCapability: async () => ({ capable: true }), send: async () => ({ state: "sent", costMicros: 1, latencyMs: 1 }), status: async () => ({ state: "sent" }) });
    const apple = createAppleAdapter({ vault, execute: async () => ({ state: "error", costMicros: 0, latencyMs: 0 }) });
    const providers: readonly IntegrationProviderPort[] = [composio, sendblue, apple];
    const contracts: readonly IntegrationCapabilityContract[] = providers.map((provider) => provider.capability);
    for (const contract of contracts) {
      expect(contract.version).toBe("integration-capability/v1");
      expect(contract.credentialReference).toMatch(/^vault:\/\//);
      expect(Object.keys(contract.limits).length).toBeGreaterThan(0);
      await expect(contract.health()).resolves.toMatchObject({ healthy: true });
    }
  });

  it("R3/R15: refuses production construction without a vault and resolves every provider credential by tenant reference when executing", async () => {
    expect(() => createProductionIntegrationAdapters({} as any)).toThrow("PROTECTED_VAULT_REQUIRED");
    const testOnlyVault = createTestOnlyInMemoryVault({ supported: true });
    expect(() => createProductionIntegrationAdapters({ vault: testOnlyVault } as any)).toThrow("PROTECTED_VAULT_PRODUCTION_REQUIRED");
    expect(() => createComposioAdapter({ vault: testOnlyVault, toolkitVersion: "2026.9.1" } as any)).toThrow("PROTECTED_VAULT_PRODUCTION_REQUIRED");
    expect(() => createSendblueAdapter({ vault: testOnlyVault } as any)).toThrow("PROTECTED_VAULT_PRODUCTION_REQUIRED");
    expect(() => createAppleAdapter({ vault: testOnlyVault } as any)).toThrow("PROTECTED_VAULT_PRODUCTION_REQUIRED");
    const vault = testProductionVault();
    for (const providerName of ["composio", "sendblue", "apple"] as const) vault.put("tenant-a", providerName, `${providerName}-credential`);
    const credentials: string[] = [];
    const adapters = createProductionIntegrationAdapters({
      vault,
      composio: { toolkitVersion: "2026.9.1", connect: async () => "composio-account", execute: async (input: any) => { credentials.push(input.credential); return { state: "sent", costMicros: 1, latencyMs: 1 }; }, reconcile: async () => ({ state: "sent" }) },
      sendblue: { connect: async () => "sendblue-account", lookupDestinationCapability: async () => ({ capable: true }), send: async (input: any) => { credentials.push(input.credential); return { state: "sent", costMicros: 1, latencyMs: 1 }; }, status: async () => ({ state: "sent" }) },
      apple: { execute: async (input: any) => { credentials.push(input.credential); return { state: "sent", costMicros: 0, latencyMs: 0 }; } }
    });
    const controller = createIntegrationController({ providers: adapters });
    for (const providerName of ["composio", "sendblue", "apple"] as const) {
      const operation = providerName === "composio" ? "tool.execute" : providerName === "sendblue" ? "message.send" : "notes";
      const connection = await controller.connect({ provider: providerName, tenantId: "tenant-a", userId: "alice", scopes: [operation], authorizationCode: "authorization-code" });
      await expect(controller.execute({ provider: providerName, tenantId: "tenant-a", userId: "alice", connectionId: connection.id!, operation, idempotencyKey: `${providerName}-1`, metadata: providerName === "sendblue" ? { destination: "+15551234567" } : {} })).resolves.toMatchObject({ state: "sent" });
    }
    expect(credentials).toEqual(["composio-credential", "sendblue-credential", "apple-credential"]);
  });
});
