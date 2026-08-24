import { describe, expect, it } from "vitest";
import {
  createExecutableAdapterRegistry,
  createTauriVaultIpcPort,
  type ExecutableAdapterHost,
  type ProductionAdapterName,
} from "../../packages/adapters/src/production/index.js";

const names = ["composio", "sendblue", "apple", "browser", "model", "storage", "telemetry", "convex"] as const satisfies readonly ProductionAdapterName[];

describe("production adapter closure", () => {
  it("uses the typed Tauri vault IPC commands and propagates unsupported storage without a fallback", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const vault = createTauriVaultIpcPort(async (command, args) => {
      calls.push({ command, args });
      if (command === "vault_backend") return { platform: "windows", provider: "windows-credential-manager", version: "1.0.0", approval: "approved" };
      if (command === "vault_get") return { status: "unsupported", code: "VAULT_UNSUPPORTED" };
      return { status: "stored" };
    });

    await expect(vault.backend()).resolves.toMatchObject({ provider: "windows-credential-manager" });
    await expect(vault.put({ tenantId: "tenant-a", key: "model", value: "not-a-real-secret" })).resolves.toEqual({ status: "stored" });
    await expect(vault.get({ tenantId: "tenant-a", key: "model" })).resolves.toEqual({ status: "unsupported", code: "VAULT_UNSUPPORTED" });
    expect(calls).toEqual([
      { command: "vault_backend", args: undefined },
      { command: "vault_put", args: { args: { tenantId: "tenant-a", key: "model", value: "not-a-real-secret" } } },
      { command: "vault_get", args: { args: { tenantId: "tenant-a", key: "model" } } },
    ]);
  });

  it("registers executable providers with health, limits, credential references, execution, and explicit degraded reconciliation", async () => {
    const executed: string[] = [];
    const vault = createTauriVaultIpcPort(async (command) => {
      if (command === "vault_backend") return { platform: "windows", provider: "windows-credential-manager", version: "1.0.0", approval: "approved" };
      return { status: "available", value: "credential-from-native-vault" };
    });
    const hosts = Object.fromEntries(names.map((name) => [name, {
      health: async () => ({ healthy: true }),
      execute: async (input: { operation: string; idempotencyKey: string; input: unknown; credential: string }) => { executed.push(`${name}:${input.credential}`); return { state: "completed" as const, externalId: `${name}-1` }; },
      ...(name === "telemetry" ? {} : { reconcile: async () => ({ state: "completed" as const }) }),
    } satisfies ExecutableAdapterHost])) as unknown as Record<ProductionAdapterName, ExecutableAdapterHost>;

    const registry = createExecutableAdapterRegistry({ vault, hosts });
    expect(registry.names).toEqual(names);
    for (const name of names) {
      expect(await registry.health(name)).toEqual({ healthy: true });
      expect(registry.describe(name)).toMatchObject({ name, credentialReference: `vault://${name}`, limits: expect.any(Object) });
      await expect(registry.execute({ name, tenantId: "tenant-a", operation: `${name}.execute`, idempotencyKey: `${name}-key`, input: { safe: true } })).resolves.toMatchObject({ state: "completed" });
    }
    await expect(registry.reconcile({ name: "telemetry", tenantId: "tenant-a", idempotencyKey: "telemetry-key" })).resolves.toEqual({ state: "unsupported", code: "ADAPTER_RECONCILE_UNSUPPORTED" });
    expect(executed).toHaveLength(names.length);
    expect(executed.every((entry) => entry.endsWith(":credential-from-native-vault"))).toBe(true);
  });

  it("turns rejected provider boundaries into explicit degraded or failed states", async () => {
    const vault = createTauriVaultIpcPort(async (command) => command === "vault_backend"
      ? { platform: "windows", provider: "windows-credential-manager", version: "1.0.0", approval: "approved" }
      : { status: "available", value: "credential" });
    const healthyHost: ExecutableAdapterHost = {
      health: async () => ({ healthy: true }),
      execute: async () => ({ state: "completed" }),
      reconcile: async () => ({ state: "completed" }),
    };
    const hosts = Object.fromEntries(names.map((name) => [name, name === "model" ? {
      ...healthyHost,
      health: async () => { throw new Error("provider offline"); },
      execute: async () => { throw new Error("provider offline"); },
    } satisfies ExecutableAdapterHost : healthyHost])) as unknown as Record<ProductionAdapterName, ExecutableAdapterHost>;
    const registry = createExecutableAdapterRegistry({ vault, hosts });
    await expect(registry.health("model")).resolves.toEqual({ healthy: false, code: "ADAPTER_HEALTH_UNAVAILABLE" });
    await expect(registry.execute({ name: "model", tenantId: "tenant-a", operation: "model.infer", idempotencyKey: "model-1", input: {} })).resolves.toEqual({ state: "failed", code: "ADAPTER_EXECUTION_UNAVAILABLE" });
  });
});
