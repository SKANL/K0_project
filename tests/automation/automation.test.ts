import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../convex/schema.js";
import { internal } from "../../convex/_generated/api.js";
import { resolveLocalSchedule, retryAt } from "../../convex/automation.js";

const modules = import.meta.glob("../../convex/**/*.ts");
const CLOCK = 1_741_506_400_000;

async function automationRuntime() {
  const t = convexTest(schema, modules);
  const workspaceId = await t.run((ctx) => ctx.db.insert("workspaces", { slug: "automation", status: "active", version: 0 }));
  return { t, workspaceId };
}

describe("durable automation and liveness", () => {
  it("resolves DST gaps and repeated local minutes deterministically while applying bounded retry backoff", () => {
    expect(resolveLocalSchedule({ local: "2025-03-09T02:30", timezone: "America/New_York", dst: "skip" })).toEqual({ kind: "skipped", runAt: null });
    expect(resolveLocalSchedule({ local: "2025-11-02T01:30", timezone: "America/New_York", dst: "first" })).toEqual({ kind: "scheduled", runAt: 1_762_061_400_000 });
    expect(resolveLocalSchedule({ local: "2025-11-02T01:30", timezone: "America/New_York", dst: "second" })).toEqual({ kind: "scheduled", runAt: 1_762_065_000_000 });
    expect(retryAt({ now: CLOCK, attempt: 2, baseDelayMs: 1_000, maxDelayMs: 3_000 })).toBe(CLOCK + 2_000);
    expect(retryAt({ now: CLOCK, attempt: 10, baseDelayMs: 1_000, maxDelayMs: 3_000 })).toBe(CLOCK + 3_000);
  });

  it("claims due work once, refuses cancelled work, fences expired heartbeats, and quarantines poison work", async () => {
    const { t, workspaceId } = await automationRuntime();
    const scheduleId = await t.mutation(internal.automation.createSchedule, { workspaceId, scheduleKey: "daily", timezone: "UTC", nextRunAt: CLOCK, version: 0, enabled: true, maxAttempts: 2, deadlineAt: CLOCK + 60_000, quotaLimit: 2 });
    const firstTick = await t.mutation(internal.automation.processBeat, { workspaceId, tickKey: "beat-1", now: CLOCK });
    const duplicateTick = await t.mutation(internal.automation.processBeat, { workspaceId, tickKey: "beat-1", now: CLOCK });
    expect(firstTick).toMatchObject({ duplicate: false, planned: 1 });
    expect(duplicateTick).toMatchObject({ duplicate: true, planned: 0 });
    const claim = await t.mutation(internal.automation.claimDueRun, { workspaceId, owner: "worker-a", now: CLOCK, leaseMs: 500 });
    expect(claim).toMatchObject({ claimed: true, fence: 1 });
    await t.mutation(internal.automation.cancelRun, { runId: claim.runId!, expectedVersion: 1, reason: "user cancelled" });
    expect(await t.mutation(internal.automation.claimDueRun, { workspaceId, owner: "worker-b", now: CLOCK + 1_000, leaseMs: 500 })).toEqual({ claimed: false, code: "NO_DUE_WORK" });
    const lease = await t.mutation(internal.liveness.heartbeat, { workspaceId, workerKey: "worker-a", owner: "worker-a", now: CLOCK, leaseMs: 100 });
    const recovered = await t.mutation(internal.liveness.recoverExpired, { workspaceId, owner: "worker-b", now: CLOCK + 101, poisonThreshold: 2 });
    expect(recovered).toMatchObject({ recovered: 1, quarantined: 0 });
    expect(await t.mutation(internal.liveness.assertFence, { workspaceId, workerKey: "worker-a", owner: "worker-a", fence: lease.fence, now: CLOCK + 101 })).toEqual({ ok: false, code: "FENCE_REJECTED" });
    await t.mutation(internal.automation.createSchedule, { workspaceId, scheduleKey: "poison", timezone: "UTC", nextRunAt: CLOCK, version: 0, enabled: true, maxAttempts: 2, deadlineAt: CLOCK + 60_000, quotaLimit: 2 });
    await t.mutation(internal.automation.processBeat, { workspaceId, tickKey: "beat-2", now: CLOCK });
    const poison = await t.mutation(internal.automation.claimDueRun, { workspaceId, owner: "worker-b", now: CLOCK, leaseMs: 500 });
    expect(poison).toMatchObject({ claimed: true, fence: 1 });
    expect(await t.mutation(internal.automation.recordFailure, { runId: poison.runId!, expectedVersion: 1, now: CLOCK + 101, code: "PROVIDER_TIMEOUT" })).toMatchObject({ state: "queued", code: "RETRY_SCHEDULED" });
    expect(await t.mutation(internal.automation.recordFailure, { runId: poison.runId!, expectedVersion: 2, now: CLOCK + 102, code: "PROVIDER_TIMEOUT" })).toMatchObject({ state: "manual_review", code: "POISON_QUARANTINED" });
    expect(await t.run((ctx) => ctx.db.query("automationAlerts").collect())).toMatchObject([{ code: "POISON_QUARANTINED", source: String(poison.runId) }]);
  });

  it("denies schedule creation for a suspended workspace before durable work is accepted", async () => {
    const { t } = await automationRuntime();
    const suspendedId = await t.run((ctx) => ctx.db.insert("workspaces", { slug: "suspended", status: "suspended", version: 0 }));
    await expect(t.mutation(internal.automation.createSchedule, { workspaceId: suspendedId, scheduleKey: "blocked", timezone: "UTC", nextRunAt: CLOCK, version: 0, enabled: true, maxAttempts: 1, deadlineAt: CLOCK + 1_000, quotaLimit: 1 })).rejects.toThrow("AUTOMATION_POLICY_DENIED");
  });

  it("rechecks policy at claim time and quarantines work whose deadline expired", async () => {
    const { t, workspaceId } = await automationRuntime();
    await t.mutation(internal.automation.createSchedule, { workspaceId, scheduleKey: "policy", timezone: "UTC", nextRunAt: CLOCK, version: 0, enabled: true, maxAttempts: 2, deadlineAt: CLOCK + 100, quotaLimit: 2 });
    await t.mutation(internal.automation.processBeat, { workspaceId, tickKey: "policy-beat", now: CLOCK });
    await t.run((ctx) => ctx.db.patch(workspaceId, { status: "suspended" }));
    expect(await t.mutation(internal.automation.claimDueRun, { workspaceId, owner: "worker-a", now: CLOCK, leaseMs: 100 })).toEqual({ claimed: false, code: "AUTOMATION_POLICY_DENIED" });
    await t.run((ctx) => ctx.db.patch(workspaceId, { status: "active" }));
    expect(await t.mutation(internal.automation.claimDueRun, { workspaceId, owner: "worker-a", now: CLOCK + 101, leaseMs: 100 })).toEqual({ claimed: false, code: "DEADLINE_EXPIRED" });
    const runs = await t.run((ctx) => ctx.db.query("automationRuns").collect());
    expect(runs).toMatchObject([{ state: "manual_review", diagnostics: "DEADLINE_EXPIRED" }]);
  });

  it("quarantines repeatedly expired heartbeat leases once and emits diagnostics", async () => {
    const { t, workspaceId } = await automationRuntime();
    await t.mutation(internal.liveness.heartbeat, { workspaceId, workerKey: "poison-worker", owner: "worker-a", now: CLOCK, leaseMs: 10 });
    expect(await t.mutation(internal.liveness.recoverExpired, { workspaceId, owner: "worker-b", now: CLOCK + 11, poisonThreshold: 2 })).toEqual({ recovered: 1, quarantined: 0 });
    expect(await t.mutation(internal.liveness.recoverExpired, { workspaceId, owner: "worker-c", now: CLOCK + 1_012, poisonThreshold: 2 })).toEqual({ recovered: 0, quarantined: 1 });
    expect(await t.mutation(internal.liveness.recoverExpired, { workspaceId, owner: "worker-d", now: CLOCK + 2_000, poisonThreshold: 2 })).toEqual({ recovered: 0, quarantined: 0 });
    expect(await t.run((ctx) => ctx.db.query("automationAlerts").collect())).toMatchObject([{ code: "LEASE_POISON_QUARANTINED", source: "poison-worker" }]);
    await expect(t.mutation(internal.liveness.heartbeat, { workspaceId, workerKey: "poison-worker", owner: "worker-b", now: CLOCK + 2_001, leaseMs: 10 })).rejects.toThrow("LEASE_POISON_QUARANTINED");
  });
});
