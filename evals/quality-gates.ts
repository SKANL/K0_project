import { replayQualityGate } from "../packages/ops/src/index.js";

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

function fail(code: "QUALITY_GATE_EVIDENCE_REQUIRED" | "QUALITY_GATE_INVALID") {
  process.stdout.write(`${JSON.stringify({ passed: false, code })}\n`);
  process.exitCode = 1;
}

const evidencePath = process.argv[2];
if (!evidencePath) {
  fail("QUALITY_GATE_EVIDENCE_REQUIRED");
} else {
  try {
  const records = JSON.parse(await (await import("node:fs/promises")).readFile(evidencePath, "utf8"));
  const result = evaluateReplay(records);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.passed) process.exitCode = 1;
  } catch {
    fail("QUALITY_GATE_INVALID");
  }
}
