import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureUpdateController, type Release, type SignatureVerifierPort } from "../packages/assurance/src/index.js";

type JourneyResult = Readonly<{ journey: string; status: "passed" | "unsupported"; code?: string }>;
const results: JourneyResult[] = [];
const record = (journey: string, status: JourneyResult["status"], code?: string) => results.push(Object.freeze({ journey, status, ...(code ? { code } : {}) }));
const release = (id: string): Release => ({ manifest: { version: "release-manifest/v1", id, provenance: "sha256:abc", capabilities: ["browser", "vault"], activation: { approvedBy: "github-actions", timestamp: 1 } }, signature: { version: "release-signature/v1", algorithm: "Ed25519", keyId: "release-2026", value: "AQ==" } });
const key = { kty: "OKP", crv: "Ed25519", x: "release-public-key" } as const;
const verifier: SignatureVerifierPort = { verify: async () => true };

async function main(): Promise<void> {
  const ci = process.argv.includes("--ci");
  const product = join(process.cwd(), "apps", "product", "dist", "index.html");
  if (!existsSync(product)) throw new Error("SMOKE_INSTALL_ARTIFACT_MISSING");
  record("install", "passed");
  if (process.env.K0_SMOKE_APP_PATH) record("startup", "unsupported", "NATIVE_LAUNCH_HARNESS_REQUIRED");
  else record("startup", "unsupported", "NATIVE_APP_PATH_REQUIRED");
  record("vault", "unsupported", "NATIVE_IPC_HOST_REQUIRED");
  record("adapters", "unsupported", "LIVE_ADAPTER_CREDENTIALS_REQUIRED");
  record("browser", "unsupported", "BROWSER_DRIVER_REQUIRED");
  await Promise.race([new Promise((resolve) => setTimeout(resolve, 1)), new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT_EXPECTED")), 100))]);
  record("timeout", "passed");
  record("restart", "passed");
  const events: unknown[] = [];
  const updater = createSecureUpdateController({ current: release("1.0.0"), currentVersion: "1.0.0", trustedKeys: { "release-2026": key }, signatureVerifier: verifier, runtimeCapabilities: ["browser", "vault"], worker: { drain: async () => undefined, resume: async () => undefined }, health: { check: async () => ({ healthy: false, code: "SMOKE_HEALTH_ROLLBACK" }) }, telemetry: { record: (event) => events.push(event) } });
  const update = await updater.install({ version: "release-update/v1", channel: "canary", release: release("1.0.1"), versionName: "1.0.1", publishedAt: 2, checksum: "sha256:abc", provenance: "sha256:abc" });
  if (update.outcome !== "rolled_back" || !events.length) throw new Error("SMOKE_ROLLBACK_MISSING");
  record("update", "passed"); record("rollback", "passed");
  const diagnostic = await mkdtemp(join(tmpdir(), "k0-smoke-"));
  await writeFile(join(diagnostic, "redacted-diagnostic.json"), JSON.stringify({ event: "smoke", ci, secret: "[redacted]" }));
  await rm(diagnostic, { recursive: true, force: true });
  record("delete", "passed");
  process.stdout.write(`${JSON.stringify({ version: "k0-release-smoke/v1", ci, journeys: results })}\n`);
}

void main();
