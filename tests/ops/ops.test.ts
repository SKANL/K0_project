import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "../../convex/_generated/api.js";
import schema from "../../convex/schema.js";
import { createBackupCoordinator, createOpsController, redactAuditMetadata, replayQualityGate } from "../../packages/ops/src/index.js";

const modules = import.meta.glob("../../convex/**/*.ts");

describe("operational controls", () => {
  it("reports readiness degradation, consumes an error budget, and redacts audit metadata", () => {
    const controller = createOpsController({ availabilityTarget: 0.99, errorBudgetEvents: 2 });
    expect(controller.readiness({ database: true, backup: true, provider: false })).toEqual({ ready: true, mode: "degraded", reasons: ["PROVIDER_UNAVAILABLE"] });
    expect(controller.recordOutcome("error")).toEqual({ remainingErrorBudget: 1, mode: "degraded" });
    expect(controller.recordOutcome("error")).toEqual({ remainingErrorBudget: 0, mode: "read_only" });
    expect(redactAuditMetadata({ requestId: "r-1", authorization: "secret", token: "private", detail: "Bearer live-token and sk_live_123" })).toEqual({ requestId: "r-1", authorization: "[REDACTED]", token: "[REDACTED]", detail: "Bearer [REDACTED] and [REDACTED]" });
  });

  it("allows only operators to write health while viewers remain read-only", async () => {
    const t = convexTest(schema, modules);
    const workspace = await t.run((ctx) => ctx.db.insert("workspaces", { slug: "ops-auth", status: "active", version: 0 }));
    await t.run(async (ctx) => {
      await ctx.db.insert("memberships", { workspaceId: workspace, subject: "operator", role: "admin", status: "active" });
      await ctx.db.insert("memberships", { workspaceId: workspace, subject: "viewer", role: "viewer", status: "active" });
    });
    const operator = t.withIdentity({ subject: "operator" });
    const viewer = t.withIdentity({ subject: "viewer" });
    expect(await viewer.mutation(api.ops.recordHealth, { workspaceId: workspace, component: "database", healthy: true, checkedAt: 1, detail: "ok" })).toMatchObject({ outcome: "denied" });
    expect(await operator.mutation(api.ops.recordHealth, { workspaceId: workspace, component: "database", healthy: true, checkedAt: 2, detail: "ok" })).toMatchObject({ outcome: "accepted" });
    expect(await viewer.query(api.ops.readiness, { workspaceId: workspace })).toMatchObject({ ready: false, mode: "degraded", reasons: ["BACKUP_UNAVAILABLE", "PROVIDER_UNAVAILABLE"] });
  });

  it("persists and enforces an availability target and error budget with operator-only writes", async () => {
    const t = convexTest(schema, modules);
    const workspace = await t.run((ctx) => ctx.db.insert("workspaces", { slug: "slo", status: "active", version: 0 }));
    await t.run(async (ctx) => {
      await ctx.db.insert("memberships", { workspaceId: workspace, subject: "operator", role: "admin", status: "active" });
      await ctx.db.insert("memberships", { workspaceId: workspace, subject: "viewer", role: "viewer", status: "active" });
    });
    const operator = t.withIdentity({ subject: "operator" });
    const viewer = t.withIdentity({ subject: "viewer" });
    expect(await viewer.mutation(api.ops.recordSloOutcome, { workspaceId: workspace, availabilityTarget: 0.99, errorBudgetEvents: 1, outcome: "success", recordedAt: 1 })).toMatchObject({ outcome: "denied", code: "OPERATOR_REQUIRED" });
    expect(await operator.mutation(api.ops.recordSloOutcome, { workspaceId: workspace, availabilityTarget: 0.99, errorBudgetEvents: 1, outcome: "error", recordedAt: 2 })).toMatchObject({ outcome: "accepted", remainingErrorBudget: 0, mode: "read_only" });
    expect(await operator.mutation(api.ops.recordSloOutcome, { workspaceId: workspace, availabilityTarget: 1, errorBudgetEvents: 1, outcome: "success", recordedAt: 3 })).toMatchObject({ outcome: "denied", code: "AVAILABILITY_TARGET_MISMATCH" });
    expect(await viewer.query(api.ops.sloState, { workspaceId: workspace })).toMatchObject({ availabilityTarget: 0.99, remainingErrorBudget: 0, mode: "read_only" });
  });

  it("persists tenant-isolated health/audit state and evaluates provider-agnostic replay gates", async () => {
    const t = convexTest(schema, modules);
    const workspace = await t.run((ctx) => ctx.db.insert("workspaces", { slug: "ops-a", status: "active", version: 0 }));
    await t.run((ctx) => ctx.db.insert("memberships", { workspaceId: workspace, subject: "admin-a", role: "admin", status: "active" }));
    const actor = t.withIdentity({ subject: "admin-a" });
    expect(await actor.mutation(api.ops.recordHealth, { workspaceId: workspace, component: "database", healthy: false, checkedAt: 30, detail: "token=never-store" })).toMatchObject({ mode: "degraded", ready: false });
    const state = await actor.query(api.ops.readiness, { workspaceId: workspace });
    expect(state).toMatchObject({ mode: "degraded", ready: false, reasons: ["DATABASE_UNAVAILABLE", "BACKUP_UNAVAILABLE", "PROVIDER_UNAVAILABLE"] });
    const events = await t.run((ctx) => ctx.db.query("operationalAuditEvents").collect());
    expect(events[0]).toMatchObject({ action: "ops.recordHealth", metadata: "detail=[REDACTED]" });
    expect(replayQualityGate([{ expected: "approved", actual: "approved" }, { expected: "denied", actual: "denied" }], { minimumPassRate: 1 })).toEqual({ passed: true, passRate: 1 });
    expect(replayQualityGate([{ expected: "approved", actual: "denied" }], { minimumPassRate: 1 })).toEqual({ passed: false, passRate: 0 });
  });

  it("fails closed release replay evidence without provider or model labels", () => {
    expect(() => replayQualityGate([], { minimumPassRate: 1 })).toThrow("QUALITY_GATE_INVALID");
    expect(replayQualityGate([{ expected: "accepted", actual: "accepted" }, { expected: "denied", actual: "conflict" }], { minimumPassRate: 1 })).toEqual({ passed: false, passRate: 0.5 });
  });

  it("exports only a tenant snapshot and refuses restore when the RPO/RTO verification fails", async () => {
    const backup = createBackupCoordinator({ retainSnapshots: 2, maxRpoMs: 60_000, maxRtoMs: 30_000 });
    const exported = await backup.export({ tenantId: "tenant-a", exportedAt: 100_000, records: [{ tenantId: "tenant-a", value: "safe" }] });
    expect(exported).toMatchObject({ tenantId: "tenant-a", checksum: expect.any(String) });
    await expect(backup.restore({ snapshot: exported, authorized: true, startedAt: 100_000, completedAt: 130_000, latestWriteAt: 50_000 })).resolves.toEqual({ restored: true, rpoMs: 50_000, rtoMs: 30_000 });
    await expect(backup.restore({ snapshot: exported, authorized: true, startedAt: 100_000, completedAt: 130_001, latestWriteAt: 1 })).rejects.toThrow("DR_TARGET_VIOLATION");
  });

  it("binds restore authorization, deletion propagation, and inactive tenants to the durable backup policy", async () => {
    const backup = createBackupCoordinator({ retainSnapshots: 2, maxRpoMs: 60_000, maxRtoMs: 30_000 });
    const exported = await backup.export({ tenantId: "tenant-a", exportedAt: 100_000, records: [{ tenantId: "tenant-a", value: "safe" }] });
    await expect(backup.restore({ snapshot: exported, tenantId: "tenant-b", authorized: true, startedAt: 100_000, completedAt: 100_001, latestWriteAt: 100_000 })).rejects.toThrow("RESTORE_TENANT_DENIED");
    await expect(backup.restore({ snapshot: exported, tenantId: "tenant-a", authorized: false, startedAt: 100_000, completedAt: 100_001, latestWriteAt: 100_000 })).rejects.toThrow("RESTORE_AUTH_REQUIRED");
    expect(backup.deleteTenant("tenant-a")).toEqual({ deletedSnapshots: 1 });
    expect(backup.retentionCount()).toBe(0);
  });

  it("computes durable backup checksums from tenant export bytes and denies omitted restore authorization", async () => {
    const backup = createBackupCoordinator({ retainSnapshots: 2, maxRpoMs: 60_000, maxRtoMs: 30_000 });
    const exported = await backup.export({ tenantId: "tenant-a", exportedAt: 100_000, records: [{ tenantId: "tenant-a", value: "safe" }] });
    await expect(backup.restore({ snapshot: exported, tenantId: "tenant-a", startedAt: 100_000, completedAt: 100_001, latestWriteAt: 100_000 })).rejects.toThrow("RESTORE_AUTH_REQUIRED");
    expect(exported.checksum).not.toBe("client-supplied-checksum");
  });

  it("fails closed for inactive or cross-tenant durable backup and restore attempts", async () => {
    const t = convexTest(schema, modules);
    const active = await t.run((ctx) => ctx.db.insert("workspaces", { slug: "backup-active", status: "active", version: 0 }));
    const inactive = await t.run((ctx) => ctx.db.insert("workspaces", { slug: "backup-inactive", status: "suspended", version: 0 }));
    const other = await t.run((ctx) => ctx.db.insert("workspaces", { slug: "backup-other", status: "active", version: 0 }));
    await t.run(async (ctx) => {
      await ctx.db.insert("memberships", { workspaceId: active, subject: "admin", role: "admin", status: "active" });
      await ctx.db.insert("memberships", { workspaceId: inactive, subject: "admin", role: "admin", status: "active" });
      await ctx.db.insert("memberships", { workspaceId: other, subject: "admin", role: "admin", status: "active" });
    });
    const actor = t.withIdentity({ subject: "admin" });
    expect(await actor.mutation(api.ops.recordBackupExport, { workspaceId: inactive, backupKey: "inactive", exportedAt: 10, latestWriteAt: 10, maxRpoMs: 1, retentionUntil: 20 })).toMatchObject({ outcome: "denied" });
    const backup = await actor.mutation(api.ops.recordBackupExport, { workspaceId: active, backupKey: "safe", exportedAt: 10, latestWriteAt: 10, maxRpoMs: 1, retentionUntil: 20 });
    expect(backup).toMatchObject({ outcome: "accepted", checksum: expect.any(String) });
    expect(await actor.mutation(api.ops.authorizeRestore, { workspaceId: other, backupKey: "safe", checksum: backup.checksum!, startedAt: 10, completedAt: 11, maxRtoMs: 2 })).toMatchObject({ outcome: "denied", code: "RESTORE_VERIFICATION_FAILED" });
    expect(await actor.mutation(api.ops.authorizeRestore, { workspaceId: active, backupKey: "safe", checksum: "wrong", startedAt: 10, completedAt: 11, maxRtoMs: 2 })).toMatchObject({ outcome: "denied", code: "RESTORE_VERIFICATION_FAILED" });
    expect(await actor.mutation(api.ops.propagateTenantDeletion, { workspaceId: active, deletedAt: 12 })).toMatchObject({ deletedBackups: 1 });
    expect(await actor.mutation(api.ops.authorizeRestore, { workspaceId: active, backupKey: "safe", checksum: backup.checksum!, startedAt: 10, completedAt: 11, maxRtoMs: 2 })).toMatchObject({ outcome: "denied", code: "RESTORE_VERIFICATION_FAILED" });
    const expired = await actor.mutation(api.ops.recordBackupExport, { workspaceId: active, backupKey: "expired", exportedAt: 20, latestWriteAt: 20, maxRpoMs: 1, retentionUntil: 21, retainSnapshots: 1 });
    expect(await actor.mutation(api.ops.authorizeRestore, { workspaceId: active, backupKey: "expired", checksum: expired.checksum!, startedAt: 22, completedAt: 23, maxRtoMs: 2 })).toMatchObject({ outcome: "denied", code: "RESTORE_VERIFICATION_FAILED" });
    const evicted = await actor.mutation(api.ops.recordBackupExport, { workspaceId: active, backupKey: "evicted", exportedAt: 30, latestWriteAt: 30, maxRpoMs: 1, retentionUntil: 40, retainSnapshots: 1 });
    await actor.mutation(api.ops.recordBackupExport, { workspaceId: active, backupKey: "newer", exportedAt: 31, latestWriteAt: 31, maxRpoMs: 1, retentionUntil: 41, retainSnapshots: 1 });
    expect(await actor.mutation(api.ops.authorizeRestore, { workspaceId: active, backupKey: "evicted", checksum: evicted.checksum!, startedAt: 31, completedAt: 32, maxRtoMs: 2 })).toMatchObject({ outcome: "denied", code: "RESTORE_VERIFICATION_FAILED" });
  });
  it("requires all readiness components and makes in-memory and durable readiness agree", async () => {
    const controller = createOpsController({ availabilityTarget: 0.99, errorBudgetEvents: 2 });
    expect(controller.readiness({ database: true, backup: true } as Record<"database" | "backup" | "provider", boolean>)).toEqual({ ready: false, mode: "degraded", reasons: ["PROVIDER_UNAVAILABLE"] });
    expect(controller.readiness({ database: false, backup: true, provider: true })).toEqual({ ready: false, mode: "degraded", reasons: ["DATABASE_UNAVAILABLE"] });

    const t = convexTest(schema, modules);
    const workspace = await t.run((ctx) => ctx.db.insert("workspaces", { slug: "readiness", status: "active", version: 0 }));
    await t.run((ctx) => ctx.db.insert("memberships", { workspaceId: workspace, subject: "admin", role: "admin", status: "active" }));
    const actor = t.withIdentity({ subject: "admin" });
    await actor.mutation(api.ops.recordHealth, { workspaceId: workspace, component: "database", healthy: true, checkedAt: 1, detail: "ok" });
    await actor.mutation(api.ops.recordHealth, { workspaceId: workspace, component: "backup", healthy: true, checkedAt: 1, detail: "ok" });
    expect(await actor.query(api.ops.readiness, { workspaceId: workspace })).toEqual({ ready: false, mode: "degraded", reasons: ["PROVIDER_UNAVAILABLE"] });
    await actor.mutation(api.ops.recordHealth, { workspaceId: workspace, component: "provider", healthy: false, checkedAt: 2, detail: "down" });
    expect(await actor.query(api.ops.readiness, { workspaceId: workspace })).toEqual({ ready: true, mode: "degraded", reasons: ["PROVIDER_UNAVAILABLE"] });
  });

  it("scopes retention per tenant and rejects evicted, expired, deleted, and cross-tenant restores", async () => {
    const backup = createBackupCoordinator({ retainSnapshots: 2, maxRpoMs: 60_000, maxRtoMs: 30_000 });
    const a1 = await backup.export({ tenantId: "tenant-a", exportedAt: 100, records: [{ tenantId: "tenant-a", value: "one" }] });
    await backup.export({ tenantId: "tenant-a", exportedAt: 101, records: [{ tenantId: "tenant-a", value: "two" }] });
    await backup.export({ tenantId: "tenant-a", exportedAt: 102, records: [{ tenantId: "tenant-a", value: "three" }] });
    await backup.export({ tenantId: "tenant-b", exportedAt: 103, records: [{ tenantId: "tenant-b", value: "four" }] });
    expect(backup.retentionCount("tenant-a")).toBe(2);
    expect(backup.retentionCount("tenant-b")).toBe(1);
    await expect(backup.restore({ snapshot: a1, tenantId: "tenant-a", authorized: true, startedAt: 100, completedAt: 101, latestWriteAt: 100 })).rejects.toThrow("RESTORE_SNAPSHOT_UNAVAILABLE");
    const active = await backup.export({ tenantId: "tenant-a", exportedAt: 200, records: [{ tenantId: "tenant-a", value: "active" }] });
    await expect(backup.restore({ snapshot: active, tenantId: "tenant-b", authorized: true, startedAt: 200, completedAt: 201, latestWriteAt: 200 })).rejects.toThrow("RESTORE_TENANT_DENIED");
    expect(backup.deleteTenant("tenant-a")).toEqual({ deletedSnapshots: 2 });
    await expect(backup.restore({ snapshot: active, tenantId: "tenant-a", authorized: true, startedAt: 200, completedAt: 201, latestWriteAt: 200 })).rejects.toThrow("RESTORE_SNAPSHOT_UNAVAILABLE");
  });
});
