export type HealthComponent = "database" | "backup" | "provider";
export type OpsMode = "normal" | "degraded" | "read_only";
const healthComponents: readonly HealthComponent[] = ["database", "backup", "provider"];
const sensitive = /authorization|secret|token|password|credential/i;
const sensitiveValue = /(?:bearer\s+\S+|sk_(?:live|test)_[A-Za-z0-9_-]+|(?:api[_-]?key|password|secret|token)\s*[=:]\s*\S+)/gi;

export function redactAuditMetadata(metadata: Record<string, string>) { return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, sensitive.test(key) ? "[REDACTED]" : value.replace(sensitiveValue, (match) => match.toLowerCase().startsWith("bearer") ? "Bearer [REDACTED]" : "[REDACTED]")])); }
export function replayQualityGate(samples: readonly { expected: string; actual: string }[], policy: { minimumPassRate: number }) {
  if (!samples.length || policy.minimumPassRate < 0 || policy.minimumPassRate > 1) throw new RangeError("QUALITY_GATE_INVALID");
  const passRate = samples.filter((sample) => sample.expected === sample.actual).length / samples.length;
  return { passed: passRate >= policy.minimumPassRate, passRate };
}
/** Database and backup are mandatory. The runbook permits provider-only degradation. */
export function evaluateReadiness(health: Partial<Record<HealthComponent, boolean>>, mode: OpsMode = "normal") {
  const reasons = healthComponents.filter((component) => health[component] !== true).map((component) => `${component.toUpperCase()}_UNAVAILABLE`);
  const complete = healthComponents.every((component) => Object.hasOwn(health, component));
  const ready = complete && health.database === true && health.backup === true;
  return { ready, mode: mode === "read_only" ? "read_only" as const : reasons.length ? "degraded" as const : "normal" as const, reasons };
}
export function createOpsController(config: { availabilityTarget: number; errorBudgetEvents: number }) {
  if (config.availabilityTarget <= 0 || config.availabilityTarget > 1 || !Number.isSafeInteger(config.errorBudgetEvents) || config.errorBudgetEvents < 0) throw new RangeError("OPS_CONFIG_INVALID");
  let remaining = config.errorBudgetEvents;
  return Object.freeze({
    readiness: (health: Partial<Record<HealthComponent, boolean>>) => evaluateReadiness(health, remaining === 0 ? "read_only" : "normal"),
    recordOutcome: (outcome: "success" | "error") => { if (outcome === "error") remaining = Math.max(0, remaining - 1); return { remainingErrorBudget: remaining, mode: remaining === 0 ? "read_only" as const : outcome === "error" ? "degraded" as const : "normal" as const }; }
  });
}

type BackupSnapshot = Readonly<{ tenantId: string; exportedAt: number; records: readonly { tenantId: string; value: string }[]; checksum: string }>;
function checksum(value: string) { let hash = 2166136261; for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619); return (hash >>> 0).toString(16).padStart(8, "0"); }
export function createBackupCoordinator(policy: { retainSnapshots: number; maxRpoMs: number; maxRtoMs: number }) {
  if (!Number.isSafeInteger(policy.retainSnapshots) || policy.retainSnapshots < 1 || policy.maxRpoMs < 0 || policy.maxRtoMs < 0) throw new RangeError("BACKUP_POLICY_INVALID");
  const snapshotsByTenant = new Map<string, BackupSnapshot[]>();
  const retained = (tenantId: string) => snapshotsByTenant.get(tenantId) ?? [];
  return Object.freeze({
    export: async (input: { tenantId: string; exportedAt: number; records: readonly { tenantId: string; value: string }[] }) => {
      const records = input.records.filter((record) => record.tenantId === input.tenantId).map((record) => ({ ...record })).sort((a, b) => a.value.localeCompare(b.value));
      const snapshot: BackupSnapshot = Object.freeze({ tenantId: input.tenantId, exportedAt: input.exportedAt, records: Object.freeze(records), checksum: checksum(JSON.stringify([input.tenantId, input.exportedAt, records])) });
      const snapshots = retained(input.tenantId); snapshots.push(snapshot); while (snapshots.length > policy.retainSnapshots) snapshots.shift(); snapshotsByTenant.set(input.tenantId, snapshots); return snapshot;
    },
    restore: async (input: { snapshot: BackupSnapshot; tenantId?: string; authorized?: boolean; startedAt: number; completedAt: number; latestWriteAt: number }) => {
      if (input.authorized !== true) throw new Error("RESTORE_AUTH_REQUIRED");
      if (input.tenantId && input.tenantId !== input.snapshot.tenantId) throw new Error("RESTORE_TENANT_DENIED");
      if (!retained(input.snapshot.tenantId).some((snapshot) => snapshot.checksum === input.snapshot.checksum)) throw new Error("RESTORE_SNAPSHOT_UNAVAILABLE");
      const expected = checksum(JSON.stringify([input.snapshot.tenantId, input.snapshot.exportedAt, input.snapshot.records]));
      const rpoMs = input.snapshot.exportedAt - input.latestWriteAt; const rtoMs = input.completedAt - input.startedAt;
      if (expected !== input.snapshot.checksum || input.snapshot.records.some((record) => record.tenantId !== input.snapshot.tenantId) || rpoMs < 0 || rpoMs > policy.maxRpoMs || rtoMs < 0 || rtoMs > policy.maxRtoMs) throw new Error("DR_TARGET_VIOLATION");
      return { restored: true as const, rpoMs, rtoMs };
    },
    deleteTenant: (tenantId: string) => { const snapshots = retained(tenantId); snapshotsByTenant.delete(tenantId); return { deletedSnapshots: snapshots.length }; },
    retentionCount: (tenantId?: string) => tenantId ? retained(tenantId).length : [...snapshotsByTenant.values()].reduce((count, snapshots) => count + snapshots.length, 0)
  });
}
