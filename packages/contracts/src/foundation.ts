export type Membership = { workspaceId: string; status: "active" | "stale" | "revoked"; role: "viewer" | "editor" | "admin" };
export type Decision = { allowed: true } | { allowed: false; code: string };

const writableRoles = new Set<Membership["role"]>(["editor", "admin"]);
const executableExtensions = new Set([".sh", ".ps1", ".cmd", ".bat", ".exe"]);

export function authorizeTenantAccess(membership: Membership | undefined, workspaceId: string, mode: "read" | "write"): Decision {
  if (!membership) return { allowed: false, code: "AUTH_REQUIRED" };
  if (membership.status !== "active") return { allowed: false, code: membership.status === "stale" ? "STALE_MEMBERSHIP" : "MEMBERSHIP_REVOKED" };
  if (membership.workspaceId !== workspaceId) return { allowed: false, code: "TENANT_MISMATCH" };
  if (mode === "write" && !writableRoles.has(membership.role)) return { allowed: false, code: "POLICY_DENIED" };
  return { allowed: true };
}

export function classifyDocumentationLikePath(path: string, content: string): { kind: "documentation-like" | "executable" | "ambiguous"; allowed: boolean } {
  const normalized = path.toLowerCase();
  const extension = normalized.slice(normalized.lastIndexOf("."));
  if (content.startsWith("#!") || executableExtensions.has(extension)) return { kind: "executable", allowed: false };
  if (["requirements.txt", "cmakelists.txt"].includes(normalized) || /(^|\/)(readme|changelog|license)(\.|$)/.test(normalized) || extension === ".md") return { kind: "documentation-like", allowed: true };
  return { kind: "ambiguous", allowed: false };
}

function normalizePath(value: string): string { return value.replace(/\\/g, "/").replace(/\/$/, ""); }

export function validateGitRootSelector(approvedRoot: string, selector: string, resolvedRoot: string): { allowed: true; root: string } | { allowed: false; code: "GIT_ROOT_MISMATCH" } {
  const expected = normalizePath(approvedRoot);
  return normalizePath(resolvedRoot) === expected && !selector.includes("..") ? { allowed: true, root: expected } : { allowed: false, code: "GIT_ROOT_MISMATCH" };
}

export function validateGitState(state: { stagedTree: string; intendedTree: string; usesCommitAll: boolean }): Decision {
  if (!state.stagedTree) return { allowed: false, code: "EMPTY_INDEX" };
  if (state.usesCommitAll) return { allowed: false, code: "COMMIT_ALL_DENIED" };
  return state.stagedTree === state.intendedTree ? { allowed: true } : { allowed: false, code: "STAGED_TREE_MISMATCH" };
}

export function validatePushState(state: { trackingRef?: string; explicitRefspec?: string }): { allowed: true; destination: string } | { allowed: false; code: "PUSH_DESTINATION_REQUIRED" } {
  if (!state.trackingRef || !state.explicitRefspec) return { allowed: false, code: "PUSH_DESTINATION_REQUIRED" };
  return { allowed: true, destination: state.trackingRef };
}

export function validatePrArgv(argv: string[]): Decision {
  if (["sh", "bash", "cmd", "powershell", "pwsh"].includes(argv[0] ?? "") || argv.some((arg) => /[;&|]/.test(arg))) return { allowed: false, code: "SHELL_COMPOSITION_DENIED" };
  return argv[0] === "gh" && argv[1] === "pr" && argv[2] === "create" && argv.includes("--head") && Boolean(argv[argv.indexOf("--head") + 1]) ? { allowed: true } : { allowed: false, code: "EXPLICIT_PR_HEAD_REQUIRED" };
}

export function createCanonicalEnvelope(input: { commandId: string; workspaceId: string; expectedVersion: number; reason: string }) {
  const audit = { commandId: input.commandId, expectedVersion: input.expectedVersion, reason: input.reason, workspaceId: input.workspaceId };
  return { canonical: JSON.stringify(audit), audit };
}

export function validateIpcRequest(request: { command: string; window: string; path: string }): { ok: true } | { ok: false; error: { code: "IPC_COMMAND_DENIED" | "IPC_SCOPE_DENIED" } } {
  if (request.command !== "vault.read") return { ok: false, error: { code: "IPC_COMMAND_DENIED" } };
  const canonicalPath = request.path.replace(/\\/g, "/").split("/").reduce<string[]>((parts, part) => {
    if (!part || part === ".") return parts;
    if (part === "..") return parts.slice(0, -1);
    return [...parts, part];
  }, []).join("/");
  if (request.window !== "main" || (canonicalPath !== "$APPDATA/K0" && !canonicalPath.startsWith("$APPDATA/K0/"))) return { ok: false, error: { code: "IPC_SCOPE_DENIED" } };
  return { ok: true };
}

export function validateDeliveryBinding(binding: { approvedRoot: string; resolvedRoot: string; trackingRef: string; explicitRefspec: string; head: string; expectedHead: string }): Decision {
  const root = validateGitRootSelector(binding.approvedRoot, binding.approvedRoot, binding.resolvedRoot);
  const ref = /^HEAD:refs\/heads\/([^\s]+)$/.exec(binding.explicitRefspec)?.[1];
  const trackedBranch = /^origin\/([^\s]+)$/.exec(binding.trackingRef)?.[1];
  return root.allowed && ref === trackedBranch && binding.head === binding.expectedHead
    ? { allowed: true }
    : { allowed: false, code: "DELIVERY_BINDING_MISMATCH" };
}
