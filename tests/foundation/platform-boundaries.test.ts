import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAuditEvent, decideCommand } from "../../convex/commands.js";
import { validateIpcRequest } from "../../packages/contracts/src/foundation.js";

describe("foundation platform boundaries", () => {
  it("records a denied command without creating an effect and accepts only the expected state version", () => {
    const denied = decideCommand({ actor: { workspaceId: "w1", role: "viewer", status: "active" }, command: { id: "c1", workspaceId: "w1", expectedVersion: 3, currentVersion: 3, capability: "workspace.write" } });
    const accepted = decideCommand({ actor: { workspaceId: "w1", role: "editor", status: "active" }, command: { id: "c2", workspaceId: "w1", expectedVersion: 3, currentVersion: 3, capability: "workspace.write" } });
    const stale = decideCommand({ actor: { workspaceId: "w1", role: "editor", status: "active" }, command: { id: "c3", workspaceId: "w1", expectedVersion: 2, currentVersion: 3, capability: "workspace.write" } });
    expect(denied).toMatchObject({ outcome: "denied", effectAllowed: false, audit: { decision: "denied" } });
    expect(accepted).toMatchObject({ outcome: "accepted", effectAllowed: true, nextVersion: 4 });
    expect(stale).toMatchObject({ outcome: "conflict", effectAllowed: false, code: "OCC_CONFLICT" });
  });

  it("generates a tenant-scoped immutable audit event with redacted secrets", () => {
    expect(buildAuditEvent({ commandId: "c1", workspaceId: "w1", actorId: "user-1", decision: "denied", metadata: { authorization: "Bearer secret", visible: "safe" } })).toMatchObject({ workspaceId: "w1", immutable: true, metadata: { authorization: "[REDACTED]", visible: "safe" } });
  });

  it("keeps the renderer capability allowlist limited to the main window and application data", async () => {
    const raw = await readFile(resolve("apps/product/src-tauri/capabilities/main.json"), "utf8");
    const capability = JSON.parse(raw) as { windows: string[]; permissions: unknown[] };
    expect(capability.windows).toEqual(["main"]);
    expect(capability.permissions).toEqual(expect.arrayContaining(["core:default"]));
    expect(raw).not.toContain("shell:allow-execute");
    expect(raw).not.toContain("$HOME/**/*");
  });

  it("returns typed IPC errors for an unlisted command or an out-of-scope path", () => {
    expect(validateIpcRequest({ command: "vault.read", window: "main", path: "$APPDATA/K0/secret" })).toEqual({ ok: true });
    expect(validateIpcRequest({ command: "shell.execute", window: "main", path: "$APPDATA/secret" })).toEqual({ ok: false, error: { code: "IPC_COMMAND_DENIED" } });
    expect(validateIpcRequest({ command: "vault.read", window: "settings", path: "$HOME/secret" })).toEqual({ ok: false, error: { code: "IPC_SCOPE_DENIED" } });
  });
});
