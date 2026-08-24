export type PersistedLineageEdge = Readonly<{ workspaceId: string; from: string; to: string; provenance: string; lifecycle: "active" | "superseded" }>;

/** Convex mutations must call this guard before persisting lineage edges. */
export function validatePersistedLineageEdge(workspaceId: string, edge: PersistedLineageEdge): { ok: true } | { ok: false; code: "CROSS_TENANT_EDGE" | "PROVENANCE_REQUIRED" } {
  if (edge.workspaceId !== workspaceId) return { ok: false, code: "CROSS_TENANT_EDGE" };
  return edge.provenance ? { ok: true } : { ok: false, code: "PROVENANCE_REQUIRED" };
}
