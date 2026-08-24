/**
 * Production-only adapter composition.
 *
 * Hosts are real runtime boundaries (HTTP SDKs, browser drivers, Convex clients, etc.)
 * supplied by composition code. This module never stores credentials or substitutes an
 * in-memory implementation when the native vault or a host is unavailable.
 */
export const productionAdapterNames = ["composio", "sendblue", "apple", "browser", "model", "storage", "telemetry", "convex"] as const;
export type ProductionAdapterName = typeof productionAdapterNames[number];
export type AdapterHealth = Readonly<{ healthy: boolean; code?: string }>;
export type AdapterExecution = Readonly<{ state: "completed" | "degraded" | "unsupported" | "failed"; externalId?: string; code?: string }>;
export type AdapterReconciliation = Readonly<{ state: "completed" | "degraded" | "unsupported" | "unknown"; code?: string }>;
export type VaultBackend = Readonly<{ platform: "windows" | "macos" | "linux"; provider: "windows-credential-manager" | "macos-keychain" | "linux-secret-service"; version: string; approval: "approved" }>;
export type VaultRead = Readonly<{ status: "available"; value: string }> | Readonly<{ status: "unsupported"; code: "VAULT_UNSUPPORTED" }>;
/** Compatible with Tauri's generic `invoke` while remaining injectable in contract tests. */
export type TauriInvoke = (command: string, args?: any) => Promise<unknown>;
export type TauriVaultIpcPort = Readonly<{
  boundary: "production";
  backend(): Promise<VaultBackend>;
  put(input: Readonly<{ tenantId: string; key: string; value: string }>): Promise<Readonly<{ status: "stored" }>>;
  get(input: Readonly<{ tenantId: string; key: string }>): Promise<VaultRead>;
}>;

type TauriVaultBackendResponse = VaultBackend;
type TauriVaultPutResponse = Readonly<{ status: "stored" }>;
type TauriVaultGetResponse = Readonly<{ status: "available"; value: string }> | Readonly<{ status: "unsupported"; code: "VAULT_UNSUPPORTED" }>;

function requireText(value: string, code: string): void {
  if (!value.trim()) throw new Error(code);
}

/** The sole TypeScript production credential port. It invokes the typed Tauri commands directly. */
export function createTauriVaultIpcPort(invoke: TauriInvoke): TauriVaultIpcPort {
  if (typeof invoke !== "function") throw new Error("TAURI_VAULT_INVOKE_REQUIRED");
  return Object.freeze({
    boundary: "production" as const,
    async backend(): Promise<VaultBackend> {
      const response = await invoke("vault_backend") as TauriVaultBackendResponse;
      if (!validVaultBackend(response)) throw new Error("TAURI_VAULT_BACKEND_INVALID");
      return Object.freeze({ ...response });
    },
    async put(input): Promise<Readonly<{ status: "stored" }>> {
      requireText(input.tenantId, "VAULT_INPUT_INVALID"); requireText(input.key, "VAULT_INPUT_INVALID"); requireText(input.value, "VAULT_INPUT_INVALID");
      const response = await invoke("vault_put", { args: input }) as TauriVaultPutResponse;
      if (response?.status !== "stored") throw new Error("TAURI_VAULT_WRITE_INVALID");
      return Object.freeze({ status: "stored" });
    },
    async get(input): Promise<VaultRead> {
      requireText(input.tenantId, "VAULT_INPUT_INVALID"); requireText(input.key, "VAULT_INPUT_INVALID");
      const response = await invoke("vault_get", { args: input }) as TauriVaultGetResponse;
      if (response?.status === "available" && typeof response.value === "string" && response.value.length > 0) return Object.freeze({ status: "available", value: response.value });
      if (response?.status === "unsupported" && response.code === "VAULT_UNSUPPORTED") return Object.freeze({ status: "unsupported", code: "VAULT_UNSUPPORTED" });
      throw new Error("TAURI_VAULT_READ_INVALID");
    },
  });
}

function validVaultBackend(value: unknown): value is VaultBackend {
  if (!value || typeof value !== "object") return false;
  const backend = value as Partial<VaultBackend>;
  const approved: Readonly<Record<VaultBackend["platform"], VaultBackend["provider"]>> = {
    windows: "windows-credential-manager", macos: "macos-keychain", linux: "linux-secret-service",
  };
  return (backend.platform === "windows" || backend.platform === "macos" || backend.platform === "linux")
    && backend.provider === approved[backend.platform]
    && typeof backend.version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(backend.version)
    && backend.approval === "approved";
}

export type ExecutableAdapterHost = Readonly<{
  health(): Promise<AdapterHealth>;
  execute(input: Readonly<{ operation: string; idempotencyKey: string; input: unknown; credential: string }>): Promise<AdapterExecution>;
  reconcile?(input: Readonly<{ idempotencyKey: string; externalId?: string; credential: string }>): Promise<AdapterReconciliation>;
}>;
export type ExecutableAdapterContract = Readonly<{
  name: ProductionAdapterName;
  version: "production-adapter/v1";
  capabilities: readonly string[];
  limits: Readonly<Record<string, number>>;
  credentialReference: `vault://${ProductionAdapterName}`;
}>;

const defaults: Readonly<Record<ProductionAdapterName, Omit<ExecutableAdapterContract, "name" | "credentialReference">>> = Object.freeze({
  composio: { version: "production-adapter/v1", capabilities: ["tool.execute", "tool.reconcile"], limits: { maxRequestsPerMinute: 60 } },
  sendblue: { version: "production-adapter/v1", capabilities: ["message.send", "message.reconcile"], limits: { maxRequestsPerMinute: 60, maxDestinationLength: 16 } },
  apple: { version: "production-adapter/v1", capabilities: ["notes.execute", "shortcuts.execute"], limits: { maxRequestsPerMinute: 30 } },
  browser: { version: "production-adapter/v1", capabilities: ["browser.navigate", "browser.reconcile"], limits: { maxSessions: 1 } },
  model: { version: "production-adapter/v1", capabilities: ["model.infer"], limits: { maxRequestsPerMinute: 60 } },
  storage: { version: "production-adapter/v1", capabilities: ["storage.read", "storage.write"], limits: { maxObjectBytes: 16_777_216 } },
  telemetry: { version: "production-adapter/v1", capabilities: ["telemetry.emit"], limits: { maxEventsPerMinute: 600 } },
  convex: { version: "production-adapter/v1", capabilities: ["convex.query", "convex.mutation"], limits: { maxMutationsPerMinute: 120 } },
});

function contractFor(name: ProductionAdapterName): ExecutableAdapterContract {
  const definition = defaults[name];
  return Object.freeze({ name, version: definition.version, capabilities: Object.freeze([...definition.capabilities]), limits: Object.freeze({ ...definition.limits }), credentialReference: `vault://${name}` });
}

function validContract(value: ExecutableAdapterContract): boolean {
  return value.version === "production-adapter/v1"
    && productionAdapterNames.includes(value.name)
    && value.credentialReference === `vault://${value.name}`
    && value.capabilities.length > 0
    && Object.keys(value.limits).length > 0
    && Object.values(value.limits).every((limit) => Number.isFinite(limit) && limit >= 0);
}

function requireHost(name: ProductionAdapterName, value: ExecutableAdapterHost | undefined): ExecutableAdapterHost {
  if (!value || typeof value.health !== "function" || typeof value.execute !== "function") throw new Error(`ADAPTER_HOST_INVALID:${name}`);
  return value;
}

export type ExecutableAdapterRegistry = Readonly<{
  names: readonly ProductionAdapterName[];
  describe(name: ProductionAdapterName): ExecutableAdapterContract;
  health(name: ProductionAdapterName): Promise<AdapterHealth>;
  execute(input: Readonly<{ name: ProductionAdapterName; tenantId: string; operation: string; idempotencyKey: string; input: unknown }>): Promise<AdapterExecution>;
  reconcile(input: Readonly<{ name: ProductionAdapterName; tenantId: string; idempotencyKey: string; externalId?: string }>): Promise<AdapterReconciliation>;
}>;

/** Validates every production host before it can execute, so declarations cannot stand in for behavior. */
export function createExecutableAdapterRegistry(input: Readonly<{ vault: TauriVaultIpcPort; hosts: Readonly<Record<ProductionAdapterName, ExecutableAdapterHost>> }>): ExecutableAdapterRegistry {
  if (input?.vault?.boundary !== "production") throw new Error("PRODUCTION_VAULT_REQUIRED");
  const contracts = new Map<ProductionAdapterName, ExecutableAdapterContract>();
  const hosts = new Map<ProductionAdapterName, ExecutableAdapterHost>();
  for (const name of productionAdapterNames) {
    const contract = contractFor(name);
    if (!validContract(contract)) throw new Error(`ADAPTER_CONTRACT_INVALID:${name}`);
    contracts.set(name, contract);
    hosts.set(name, requireHost(name, input.hosts?.[name]));
  }
  const credential = async (tenantId: string, name: ProductionAdapterName): Promise<string | undefined> => {
    requireText(tenantId, "ADAPTER_TENANT_INVALID");
    const result = await input.vault.get({ tenantId, key: name });
    return result.status === "available" ? result.value : undefined;
  };
  return Object.freeze({
    names: Object.freeze([...productionAdapterNames]),
    describe(name) { return contracts.get(name)!; },
    async health(name) {
      try {
        const result = await hosts.get(name)!.health();
        return result?.healthy === true ? Object.freeze({ healthy: true }) : Object.freeze({ healthy: false, code: result?.code ?? "ADAPTER_DEGRADED" });
      } catch {
        return Object.freeze({ healthy: false, code: "ADAPTER_HEALTH_UNAVAILABLE" });
      }
    },
    async execute(request) {
      requireText(request.operation, "ADAPTER_OPERATION_INVALID"); requireText(request.idempotencyKey, "ADAPTER_IDEMPOTENCY_INVALID");
      const value = await credential(request.tenantId, request.name);
      if (!value) return Object.freeze({ state: "unsupported" as const, code: "VAULT_UNSUPPORTED" });
      try {
        const result = await hosts.get(request.name)!.execute({ operation: request.operation, idempotencyKey: request.idempotencyKey, input: request.input, credential: value });
        return validExecution(result) ? Object.freeze({ ...result }) : Object.freeze({ state: "failed" as const, code: "ADAPTER_EXECUTION_INVALID" });
      } catch {
        return Object.freeze({ state: "failed" as const, code: "ADAPTER_EXECUTION_UNAVAILABLE" });
      }
    },
    async reconcile(request) {
      requireText(request.idempotencyKey, "ADAPTER_IDEMPOTENCY_INVALID");
      const host = hosts.get(request.name)!;
      if (typeof host.reconcile !== "function") return Object.freeze({ state: "unsupported" as const, code: "ADAPTER_RECONCILE_UNSUPPORTED" });
      const value = await credential(request.tenantId, request.name);
      if (!value) return Object.freeze({ state: "unsupported" as const, code: "VAULT_UNSUPPORTED" });
      try {
        const result = await host.reconcile({ idempotencyKey: request.idempotencyKey, externalId: request.externalId, credential: value });
        return validReconciliation(result) ? Object.freeze({ ...result }) : Object.freeze({ state: "unknown" as const, code: "ADAPTER_RECONCILIATION_INVALID" });
      } catch {
        return Object.freeze({ state: "unknown" as const, code: "ADAPTER_RECONCILIATION_UNAVAILABLE" });
      }
    },
  });
}

function validExecution(value: AdapterExecution): boolean { return value.state === "completed" || value.state === "degraded" || value.state === "unsupported" || value.state === "failed"; }
function validReconciliation(value: AdapterReconciliation): boolean { return value.state === "completed" || value.state === "degraded" || value.state === "unsupported" || value.state === "unknown"; }
