import { describe, expect, it } from "vitest";
import {
  createAppleCapabilityPort,
  createInMemoryAutomationAdapter,
  createInMemoryBeatScheduler,
} from "../../packages/integrations/src/index.js";

describe("provider-neutral automation references", () => {
  it("runs due work once per idempotency key and leaves an audit receipt", async () => {
    const composio = createInMemoryAutomationAdapter("composio");
    const scheduler = createInMemoryBeatScheduler({ adapters: [composio] });

    expect(scheduler.schedule({ id: "sync-1", provider: "composio", dueAt: 20, idempotencyKey: "sync-key" })).toMatchObject({ state: "scheduled", replay: false });
    expect(scheduler.schedule({ id: "another-id", provider: "composio", dueAt: 10, idempotencyKey: "sync-key" })).toMatchObject({ id: "sync-1", state: "scheduled", replay: true });
    expect(await scheduler.beat({ now: 19 })).toEqual([]);
    expect(await scheduler.beat({ now: 20 })).toMatchObject([{ id: "sync-1", state: "completed", providerExecutionId: "composio:sync-key" }]);
    expect(await scheduler.beat({ now: 21 })).toEqual([]);
    expect(composio.calls()).toHaveLength(1);
    expect(scheduler.audit()).toMatchObject([{ action: "scheduled" }, { action: "completed", idempotencyKey: "sync-key" }]);
  });

  it("cancels scheduled work idempotently so later beats cannot execute it", async () => {
    const sendblue = createInMemoryAutomationAdapter("sendblue");
    const scheduler = createInMemoryBeatScheduler({ adapters: [sendblue] });
    scheduler.schedule({ id: "message-1", provider: "sendblue", dueAt: 10, idempotencyKey: "message-key" });

    expect(scheduler.cancel({ id: "message-1", reason: "user-request", at: 5 })).toMatchObject({ state: "cancelled", replay: false });
    expect(scheduler.cancel({ id: "message-1", reason: "user-request", at: 6 })).toMatchObject({ state: "cancelled", replay: true });
    expect(await scheduler.beat({ now: 10 })).toEqual([]);
    expect(sendblue.calls()).toEqual([]);
  });

  it("serializes overlapping beats so a due job executes once", async () => {
    let release!: (value: Readonly<{ providerExecutionId: string }>) => void;
    const calls: string[] = [];
    const scheduler = createInMemoryBeatScheduler({ adapters: [{ provider: "convex", execute: async (input) => {
      calls.push(input.id);
      return new Promise((resolve) => { release = resolve; });
    } }] });
    scheduler.schedule({ id: "sync-2", provider: "convex", dueAt: 10, idempotencyKey: "sync-key-2" });

    const first = scheduler.beat({ now: 10 });
    const second = scheduler.beat({ now: 10 });
    await Promise.resolve();
    expect(calls).toEqual(["sync-2"]);
    release({ providerExecutionId: "convex:sync-key-2" });

    expect(await first).toMatchObject([{ state: "completed" }]);
    expect(await second).toEqual([]);
    expect(calls).toEqual(["sync-2"]);
  });

  it("keeps cancellation terminal when a provider completes or fails late", async () => {
    for (const outcome of ["complete", "fail"] as const) {
      let resolve!: (value: Readonly<{ providerExecutionId: string }>) => void;
      let reject!: (reason?: unknown) => void;
      const scheduler = createInMemoryBeatScheduler({ adapters: [{ provider: "composio", execute: async () => new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; }) }] });
      scheduler.schedule({ id: outcome, provider: "composio", dueAt: 10, idempotencyKey: outcome });

      const beat = scheduler.beat({ now: 10 });
      await Promise.resolve();
      scheduler.cancel({ id: outcome, reason: "user-request", at: 11 });
      if (outcome === "complete") resolve({ providerExecutionId: "composio:complete" }); else reject(new Error("late failure"));

      await expect(beat).resolves.toMatchObject([{ state: "cancelled", cancellationReason: "user-request" }]);
      expect(scheduler.get(outcome)).toMatchObject({ state: "cancelled" });
      expect(scheduler.audit().filter((entry) => entry.id === outcome).map((entry) => entry.action)).toEqual(["scheduled", "cancelled"]);
    }
  });

  it("keeps Apple capabilities explicit and never advertises iMessage automation", () => {
    const apple = createAppleCapabilityPort();

    expect(apple.resolve({ capability: "notes", platform: "macos", permission: "granted", consent: "granted" })).toEqual({ available: true });
    expect(apple.resolve({ capability: "shortcuts", platform: "ios", permission: "granted", consent: "granted" })).toEqual({ available: true });
    expect(apple.resolve({ capability: "iMessage", platform: "macos", permission: "granted", consent: "granted" })).toEqual({ available: false, fallback: "manual_share" });
    expect(apple.resolve({ capability: "notes", platform: "ios", permission: "granted", consent: "granted" })).toEqual({ available: false, fallback: "unsupported_platform" });
  });
});
