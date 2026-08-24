import { describe, expect, it } from "vitest";
import { createSecureUpdateController, type Release, type SignatureVerifierPort } from "../../packages/assurance/src/index.js";

const key = { kty: "OKP", crv: "Ed25519", x: "release-public-key" } as const;
const verifier: SignatureVerifierPort = { verify: async () => true };
const release = (id: string): Release => ({
  manifest: { version: "release-manifest/v1", id, provenance: "sha256:abc", capabilities: ["browser", "vault"], activation: { approvedBy: "github-actions", timestamp: 1 } },
  signature: { version: "release-signature/v1", algorithm: "Ed25519", keyId: "release-2026", value: "AQ==" }
});

describe("secure release updater", () => {
  it("fails closed on tampered, unsigned, or downgrade update metadata", async () => {
    const updater = createSecureUpdateController({ current: release("1.0.0"), currentVersion: "1.0.0", trustedKeys: { "release-2026": key }, signatureVerifier: verifier, runtimeCapabilities: ["browser", "vault"], worker: { drain: async () => undefined, resume: async () => undefined }, health: { check: async () => ({ healthy: true }) } });
    await expect(updater.install({ version: "release-update/v1", channel: "stable", release: release("1.0.0"), versionName: "1.0.0", publishedAt: 1, checksum: "sha256:abc", provenance: "sha256:abc", stable: { oidc: true, signedProvenance: true } })).rejects.toThrow("UPDATE_DOWNGRADE_DENIED");
    await expect(updater.install({ version: "release-update/v1", channel: "stable", release: release("1.1.0"), versionName: "1.1.0", publishedAt: 1, checksum: "sha256:abc", provenance: "sha256:modified", stable: { oidc: true, signedProvenance: true } })).rejects.toThrow("UPDATE_TAMPERED");
    await expect(updater.install({ version: "release-update/v1", channel: "stable", release: release("1.1.0"), versionName: "1.1.0", publishedAt: 1, checksum: "sha256:abc", provenance: "sha256:abc", stable: { oidc: false, signedProvenance: true } } as any)).rejects.toThrow("UPDATE_STABLE_PROVENANCE_REQUIRED");
  });

  it("drains workers, rolls back failed health checks, resumes, and emits redacted telemetry", async () => {
    const calls: string[] = [];
    const telemetry: unknown[] = [];
    const updater = createSecureUpdateController({ current: release("1.0.0"), currentVersion: "1.0.0", trustedKeys: { "release-2026": key }, signatureVerifier: verifier, runtimeCapabilities: ["browser", "vault"], worker: { drain: async () => { calls.push("drain"); }, resume: async () => { calls.push("resume"); } }, health: { check: async () => ({ healthy: false, code: "STARTUP_UNHEALTHY" }) }, telemetry: { record: (event) => telemetry.push(event) } });
    await expect(updater.install({ version: "release-update/v1", channel: "beta", release: release("1.1.0"), versionName: "1.1.0", publishedAt: 2, checksum: "sha256:abc", provenance: "sha256:abc" })).resolves.toMatchObject({ outcome: "rolled_back", activeVersion: "1.0.0", reason: "STARTUP_UNHEALTHY" });
    expect(calls).toEqual(["drain", "resume"]);
    expect(telemetry).toContainEqual(expect.objectContaining({ event: "update_rolled_back", releaseId: "1.1.0", reason: "STARTUP_UNHEALTHY" }));
    expect(JSON.stringify(telemetry)).not.toContain("secret");
  });
});

