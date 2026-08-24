/// <reference types="vite/client" />
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../../convex/_generated/api.js";
import schema from "../../convex/schema.js";
import { validateIpcRequest } from "../../packages/contracts/src/foundation.js";

const modules = import.meta.glob("../../convex/**/*.ts");
const fixturePath = resolve("tests/fixtures/foundation-threats.json");

type ThreatFixtures = {
  tenantEscape: { actorWorkspace: string; requestedWorkspace: string; expected: string };
  staleMembership: { status: "stale"; expected: string };
  duplicateCommand: { idempotencyKey: string; expected: string };
  ipc: { window: string; path: string; expected: string };
};

const fixtures = JSON.parse(await readFile(fixturePath, "utf8")) as ThreatFixtures;

async function seededRuntime(subject = "editor-a", membershipStatus: "active" | "stale" | "revoked" = "active") {
  const t = convexTest(schema, modules);
  const workspaceA = await t.run((ctx) => ctx.db.insert("workspaces", { slug: "workspace-a", status: "active", version: 0 }));
  const workspaceB = await t.run((ctx) => ctx.db.insert("workspaces", { slug: "workspace-b", status: "active", version: 0 }));
  await t.run((ctx) => ctx.db.insert("memberships", { workspaceId: workspaceA, subject, role: "editor", status: membershipStatus }));
  return { t, workspaceA, workspaceB };
}

describe("Convex foundation runtime", () => {
  it.each([[fixtures.tenantEscape]])(
    "runs tenantEscape through the exported handler and fails closed for %o",
    async (fixture) => {
      const { t, workspaceA, workspaceB } = await seededRuntime();
      const workspaces = { "workspace-a": workspaceA, "workspace-b": workspaceB };
      const result = await t.withIdentity({ subject: "editor-a" }).mutation(api.commands.execute, {
        workspaceId: workspaces[fixture.requestedWorkspace as keyof typeof workspaces],
        idempotencyKey: "tenant-escape",
        expectedVersion: 0,
        capability: "workspace.write"
      });
      expect(workspaces[fixture.actorWorkspace as keyof typeof workspaces]).toBe(workspaceA);
      expect(result).toMatchObject({ outcome: "denied", code: fixture.expected, effectAllowed: false });
      expect(await t.run((ctx) => ctx.db.query("outbox").collect())).toHaveLength(0);
    }
  );

  it.each([[fixtures.staleMembership]])(
    "runs staleMembership through the exported handler and fails closed for %o",
    async (fixture) => {
      const { t, workspaceA } = await seededRuntime("stale-a", fixture.status);
      const result = await t.withIdentity({ subject: "stale-a" }).mutation(api.commands.execute, {
        workspaceId: workspaceA,
        idempotencyKey: "stale-membership",
        expectedVersion: 0,
        capability: "workspace.write"
      });
      expect(result).toMatchObject({ outcome: "denied", code: fixture.expected, effectAllowed: false });
    }
  );

  it.each([[fixtures.duplicateCommand]])(
    "atomically deduplicates commands, appends audit, and creates one outbox record for %o",
    async (fixture) => {
      const { t, workspaceA } = await seededRuntime();
      const actor = t.withIdentity({ subject: "editor-a" });
      const args = { workspaceId: workspaceA, idempotencyKey: fixture.idempotencyKey, expectedVersion: 0, capability: "workspace.write" };
      const [first, duplicate] = await Promise.all([
        actor.mutation(api.commands.execute, args),
        actor.mutation(api.commands.execute, args)
      ]);
      expect(first).toMatchObject({ outcome: fixture.expected, effectAllowed: true });
      expect(duplicate).toEqual(first);
      await expect(actor.mutation(api.commands.execute, { ...args, idempotencyKey: "stale-version", expectedVersion: 0 })).resolves.toMatchObject({ outcome: "conflict", code: "OCC_CONFLICT", effectAllowed: false });
      expect(await t.run((ctx) => ctx.db.query("commands").collect())).toHaveLength(2);
      expect(await t.run((ctx) => ctx.db.query("outbox").collect())).toHaveLength(1);
      expect(await t.run((ctx) => ctx.db.query("auditEvents").collect())).toHaveLength(2);
    }
  );

  it("deduplicates inbox intake and fences lease execution through exported handlers", async () => {
    const { t, workspaceA } = await seededRuntime();
    const inbox = { workspaceId: workspaceA, idempotencyKey: "inbox-1" };
    expect(await t.mutation(internal.inbox.record, inbox)).toEqual(await t.mutation(internal.inbox.record, inbox));
    await t.withIdentity({ subject: "editor-a" }).mutation(api.commands.execute, { workspaceId: workspaceA, idempotencyKey: "outbox-1", expectedVersion: 0, capability: "workspace.write" });
    const first = await t.mutation(internal.outbox.claim, { workspaceId: workspaceA, idempotencyKey: "outbox-1", workerId: "worker-a", now: 100, leaseMs: 50 });
    const second = await t.mutation(internal.outbox.claim, { workspaceId: workspaceA, idempotencyKey: "outbox-1", workerId: "worker-b", now: 151, leaseMs: 50 });
    expect(first.acquired).toBe(true);
    expect(second).toMatchObject({ acquired: true, fence: 2 });
    await expect(t.mutation(internal.outbox.verify, { workspaceId: workspaceA, idempotencyKey: "outbox-1", fence: 1 })).rejects.toThrow();
  });

  it.each([[fixtures.ipc]])(
    "runs ipc fixture through the typed IPC contract for %o",
    (fixture) => {
      expect(validateIpcRequest({ command: "vault.read", window: fixture.window, path: fixture.path })).toEqual({ ok: false, error: { code: fixture.expected } });
    }
  );
});
