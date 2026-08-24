import { describe, expect, it } from "vitest";
import { foundationMigration, seededTenantFixture } from "../../convex/migrations/foundation.js";

describe("foundation migration and fixtures", () => {
  it("uses an additive migration plan that can be drained without deleting audit records", () => {
    expect(foundationMigration).toEqual({ mode: "expand", tables: ["workspaces", "memberships", "commands", "auditEvents", "outbox"], rollback: "disable-writes-and-drain-outbox" });
  });

  it("seeds isolated active and revoked tenants for authorization tests", () => {
    expect(seededTenantFixture.workspaces).toHaveLength(2);
    expect(seededTenantFixture.memberships).toEqual(expect.arrayContaining([
      expect.objectContaining({ workspaceId: "workspace-a", status: "active" }),
      expect.objectContaining({ workspaceId: "workspace-b", status: "revoked" })
    ]));
  });
});
