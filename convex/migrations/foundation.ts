export const foundationMigration = {
  mode: "expand",
  tables: ["workspaces", "memberships", "commands", "auditEvents", "outbox"],
  rollback: "disable-writes-and-drain-outbox"
} as const;

export const seededTenantFixture = {
  workspaces: [{ id: "workspace-a", status: "active" }, { id: "workspace-b", status: "active" }],
  memberships: [
    { workspaceId: "workspace-a", subject: "editor-a", role: "editor", status: "active" },
    { workspaceId: "workspace-b", subject: "revoked-b", role: "editor", status: "revoked" }
  ]
} as const;
