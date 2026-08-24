import { describe, expect, it } from "vitest";
import {
  authorizeTenantAccess,
  classifyDocumentationLikePath,
  createCanonicalEnvelope,
  validateGitRootSelector,
  validateGitState,
  validatePrArgv,
  validatePushState
} from "../../packages/contracts/src/foundation.js";

describe("foundation contracts", () => {
  it("fails closed for missing, stale, and cross-workspace access while allowing an active membership", () => {
    expect(authorizeTenantAccess(undefined, "workspace-a", "write")).toMatchObject({ allowed: false, code: "AUTH_REQUIRED" });
    expect(authorizeTenantAccess({ workspaceId: "workspace-a", status: "stale", role: "admin" }, "workspace-a", "write")).toMatchObject({ allowed: false, code: "STALE_MEMBERSHIP" });
    expect(authorizeTenantAccess({ workspaceId: "workspace-a", status: "active", role: "viewer" }, "workspace-a", "write")).toMatchObject({ allowed: false, code: "POLICY_DENIED" });
    expect(authorizeTenantAccess({ workspaceId: "workspace-a", status: "active", role: "editor" }, "workspace-a", "write")).toEqual({ allowed: true });
  });

  it("classifies known documentation-like names by content policy and denies ambiguous executable extensions", () => {
    expect(classifyDocumentationLikePath("requirements.txt", "# documented dependencies")).toEqual({ kind: "documentation-like", allowed: true });
    expect(classifyDocumentationLikePath("README.sh", "#!/bin/sh\necho unsafe")).toEqual({ kind: "executable", allowed: false });
  });

  it("accepts only a selector resolving inside the approved repository root", () => {
    expect(validateGitRootSelector("C:/work/k0", "C:/work/k0/packages/contracts", "C:/work/k0")).toEqual({ allowed: true, root: "C:/work/k0" });
    expect(validateGitRootSelector("C:/work/k0", "../other", "C:/work/other")).toMatchObject({ allowed: false, code: "GIT_ROOT_MISMATCH" });
  });

  it("rejects empty, commit-a, and mismatched staged trees", () => {
    expect(validateGitState({ stagedTree: "", intendedTree: "abc", usesCommitAll: false })).toMatchObject({ allowed: false, code: "EMPTY_INDEX" });
    expect(validateGitState({ stagedTree: "abc", intendedTree: "abc", usesCommitAll: true })).toMatchObject({ allowed: false, code: "COMMIT_ALL_DENIED" });
    expect(validateGitState({ stagedTree: "abc", intendedTree: "def", usesCommitAll: false })).toMatchObject({ allowed: false, code: "STAGED_TREE_MISMATCH" });
    expect(validateGitState({ stagedTree: "abc", intendedTree: "abc", usesCommitAll: false })).toEqual({ allowed: true });
  });

  it("requires an explicit immutable push destination and denies a first push without one", () => {
    expect(validatePushState({ trackingRef: undefined, explicitRefspec: undefined })).toMatchObject({ allowed: false, code: "PUSH_DESTINATION_REQUIRED" });
    expect(validatePushState({ trackingRef: "origin/main", explicitRefspec: "HEAD:refs/heads/main" })).toEqual({ allowed: true, destination: "origin/main" });
  });

  it("allows structured PR argv with an explicit head and rejects shell composition", () => {
    expect(validatePrArgv(["gh", "pr", "create", "--head", "feature/pr1"])).toEqual({ allowed: true });
    expect(validatePrArgv(["sh", "-c", "gh pr create --head feature/pr1 && echo leaked"])).toMatchObject({ allowed: false, code: "SHELL_COMPOSITION_DENIED" });
  });

  it("canonicalizes equivalent envelope key ordering and preserves immutable audit metadata", () => {
    const first = createCanonicalEnvelope({ commandId: "cmd-1", workspaceId: "workspace-a", expectedVersion: 2, reason: "policy-check" });
    const second = createCanonicalEnvelope({ reason: "policy-check", expectedVersion: 2, workspaceId: "workspace-a", commandId: "cmd-1" });
    expect(first.canonical).toBe(second.canonical);
    expect(first.audit).toMatchObject({ commandId: "cmd-1", workspaceId: "workspace-a", expectedVersion: 2 });
  });
});
