import { replayQualityGate } from "../packages/ops/src/index.js";
import { verifyReleaseManifest, type Release, type TrustedReleaseKeys } from "../packages/assurance/src/index.js";

type ReplayRecord = { expected: string; actual: string };

function isReplayEvidence(records: unknown): records is readonly ReplayRecord[] {
  return Array.isArray(records) && records.length > 0 && records.every((record) =>
    typeof record === "object" && record !== null
    && typeof record.expected === "string" && record.expected.length > 0
    && typeof record.actual === "string" && record.actual.length > 0
  );
}

export function evaluateReplay(records: unknown) {
  if (!isReplayEvidence(records)) throw new RangeError("QUALITY_GATE_INVALID");
  return replayQualityGate(records, { minimumPassRate: 1 });
}

export function evaluateReleaseCheck(input: unknown) {
  if (!input || typeof input !== "object") throw new RangeError("RELEASE_CHECK_INVALID");
  const { release, trustedKeys } = input as { release?: Release; trustedKeys?: TrustedReleaseKeys };
  if (!release || !trustedKeys || !verifyReleaseManifest(release, trustedKeys)) throw new RangeError("RELEASE_VERIFICATION_FAILED");
  return { passed: true, releaseId: release.manifest.id };
}

function fail(code: "QUALITY_GATE_EVIDENCE_REQUIRED" | "QUALITY_GATE_INVALID") {
  process.stdout.write(`${JSON.stringify({ passed: false, code })}\n`);
  process.exitCode = 1;
}

const releaseCheck = process.argv[2] === "--release-check";
const evidencePath = process.argv[releaseCheck ? 3 : 2];
if (!evidencePath) {
  fail("QUALITY_GATE_EVIDENCE_REQUIRED");
} else {
  try {
  const evidence = JSON.parse(await (await import("node:fs/promises")).readFile(evidencePath, "utf8"));
  const result = releaseCheck ? evaluateReleaseCheck(evidence) : evaluateReplay(evidence);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.passed) process.exitCode = 1;
  } catch {
    fail("QUALITY_GATE_INVALID");
  }
}
