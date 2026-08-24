import { authorizeTenantAccess, type Membership } from "../packages/contracts/src/foundation.js";

export function requireWorkspaceAccess(membership: Membership | undefined, workspaceId: string, mode: "read" | "write") {
  const decision = authorizeTenantAccess(membership, workspaceId, mode);
  if (!decision.allowed) throw new Error(decision.code);
  return decision;
}
