import { createHash } from "node:crypto";
import type { EvaluationCategory, EvaluationFixture } from "./fixtures.js";

export type MemoryProvenance = Readonly<{ id: string; source: string; sourceType: string; recordedAt: number }>;
export type BrowserAction = Readonly<{ kind: string; url?: string; target?: string }>;
export type EvaluationObservation = Readonly<{
  result: unknown;
  memory?: readonly MemoryProvenance[];
  browser?: Readonly<{ actions: readonly BrowserAction[]; confirmed: boolean }>;
  recovery?: Readonly<{ attempted: boolean; recovered: boolean; action: string }>;
  quality?: Readonly<{ score: number; required: readonly string[] }>;
}>;

export type EvaluationAdapter = (fixture: EvaluationFixture, attempt: number) => Promise<EvaluationObservation>;
export type EvaluationFailureCode =
  | "ADAPTER_ERROR"
  | "IDEMPOTENCY_MISMATCH"
  | "DETERMINISM_MISMATCH"
  | "MEMORY_PROVENANCE_INVALID"
  | "BROWSER_SAFETY_VIOLATION"
  | "RECOVERY_INCOMPLETE"
  | "OUTPUT_QUALITY_SECRET_LEAK"
  | "OUTPUT_QUALITY_BELOW_THRESHOLD";
export type EvaluationFailure = Readonly<{ fixtureId: string; category: EvaluationCategory; code: EvaluationFailureCode }>;
export type EvaluationResult = Readonly<{
  fixtureId: string;
  category: EvaluationCategory;
  passed: boolean;
  outputDigest: string;
  provenance: Readonly<{ fixtureId: string; attempts: number }>;
}>;
export type EvaluationReport = Readonly<{
  passed: boolean;
  failures: readonly EvaluationFailure[];
  results: readonly EvaluationResult[];
}>;

const secretPattern = /(?:api[-_]?key|authorization|bearer\s+|password|secret|token\s*[:=]|sk_(?:live|test)_)/i;
const allowedBrowserActions = new Set(["navigate", "click", "type", "select"]);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, canonicalize(nested)]));
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function hasValidMemoryProvenance(memory: readonly MemoryProvenance[] | undefined): boolean {
  return Array.isArray(memory) && memory.length > 0 && memory.every((item) =>
    typeof item.id === "string" && item.id.length > 0
    && typeof item.source === "string" && item.source.length > 0
    && typeof item.sourceType === "string" && item.sourceType.length > 0
    && Number.isFinite(item.recordedAt) && item.recordedAt > 0
  );
}

function hasSafeBrowserTrace(browser: EvaluationObservation["browser"]): boolean {
  if (!browser || browser.confirmed !== true || !Array.isArray(browser.actions)) return false;
  return browser.actions.every((action) => {
    if (!allowedBrowserActions.has(action.kind)) return false;
    if (action.kind === "navigate" && (!action.url || !/^https?:\/\//i.test(action.url))) return false;
    return !secretPattern.test(JSON.stringify(action));
  });
}

function validateCategory(fixture: EvaluationFixture, observation: EvaluationObservation): EvaluationFailureCode | undefined {
  switch (fixture.category) {
    case "memory-provenance": return hasValidMemoryProvenance(observation.memory) ? undefined : "MEMORY_PROVENANCE_INVALID";
    case "browser-safety": return hasSafeBrowserTrace(observation.browser) ? undefined : "BROWSER_SAFETY_VIOLATION";
    case "recovery": return observation.recovery?.attempted === true && observation.recovery.recovered === true && observation.recovery.action.length > 0 ? undefined : "RECOVERY_INCOMPLETE";
    case "output-quality": {
      const serialized = JSON.stringify(observation.result);
      if (secretPattern.test(serialized)) return "OUTPUT_QUALITY_SECRET_LEAK";
      const quality = observation.quality;
      const result = observation.result && typeof observation.result === "object" ? observation.result as Record<string, unknown> : {};
      return quality && quality.score >= 0.8 && quality.required.every((key) => result[key] !== undefined && result[key] !== "")
        ? undefined : "OUTPUT_QUALITY_BELOW_THRESHOLD";
    }
    default: return undefined;
  }
}

export async function runEvaluationHarness(input: Readonly<{ fixtures: readonly EvaluationFixture[]; adapter: EvaluationAdapter }>): Promise<EvaluationReport> {
  const failures: EvaluationFailure[] = [];
  const results: EvaluationResult[] = [];
  for (const fixture of input.fixtures) {
    const observations: EvaluationObservation[] = [];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        observations.push(await input.adapter(fixture, attempt));
      } catch {
        failures.push({ fixtureId: fixture.id, category: fixture.category, code: "ADAPTER_ERROR" });
      }
    }
    if (observations.length !== 2) continue;
    const firstDigest = digest(observations[0].result);
    const secondDigest = digest(observations[1].result);
    if (fixture.category === "idempotency" && firstDigest !== secondDigest) failures.push({ fixtureId: fixture.id, category: fixture.category, code: "IDEMPOTENCY_MISMATCH" });
    if (fixture.category === "determinism" && firstDigest !== secondDigest) failures.push({ fixtureId: fixture.id, category: fixture.category, code: "DETERMINISM_MISMATCH" });
    const categoryFailure = validateCategory(fixture, observations[0]);
    if (categoryFailure) failures.push({ fixtureId: fixture.id, category: fixture.category, code: categoryFailure });
    results.push({ fixtureId: fixture.id, category: fixture.category, passed: !failures.some((failure) => failure.fixtureId === fixture.id), outputDigest: firstDigest, provenance: { fixtureId: fixture.id, attempts: 2 } });
  }
  return { passed: failures.length === 0, failures, results };
}
