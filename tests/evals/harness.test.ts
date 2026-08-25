import { describe, expect, it } from "vitest";
import { runEvaluationHarness, type EvaluationAdapter, type EvaluationObservation } from "../../evals/harness.js";
import { providerNeutralFixtures } from "../../evals/fixtures.js";

const observation: EvaluationObservation = {
  result: { answer: "ready", items: ["alpha", "beta"] },
  memory: [{ id: "memory-1", source: "fixture://policy", sourceType: "fixture", recordedAt: 1 }],
  browser: { actions: [{ kind: "navigate", url: "https://example.test/confirm" }, { kind: "click", target: "confirm" }], confirmed: true },
  recovery: { attempted: true, recovered: true, action: "retry" },
  quality: { score: 0.95, required: ["answer"] }
};

const adapter: EvaluationAdapter = async () => observation;

describe("provider-neutral evaluation harness", () => {
  it("ships a stable fixture catalog covering every required quality dimension", () => {
    expect(providerNeutralFixtures.map((fixture) => fixture.category)).toEqual([
      "idempotency",
      "determinism",
      "memory-provenance",
      "browser-safety",
      "recovery",
      "output-quality"
    ]);
  });

  it("passes a compliant adapter and emits a stable, auditable report", async () => {
    const first = await runEvaluationHarness({ fixtures: providerNeutralFixtures, adapter });
    const second = await runEvaluationHarness({ fixtures: providerNeutralFixtures, adapter });

    expect(first).toEqual(second);
    expect(first.passed).toBe(true);
    expect(first.failures).toEqual([]);
    expect(first.results).toHaveLength(6);
    expect(first.results.every((result) => result.provenance.fixtureId && result.provenance.attempts === 2)).toBe(true);
  });

  it("rejects non-idempotent and non-deterministic outputs", async () => {
    let call = 0;
    const result = await runEvaluationHarness({
      fixtures: providerNeutralFixtures.slice(0, 2),
      adapter: async () => ({ ...observation, result: { answer: `run-${call++}` } })
    });

    expect(result.passed).toBe(false);
    expect(result.failures.map((failure) => failure.code)).toEqual(["IDEMPOTENCY_MISMATCH", "DETERMINISM_MISMATCH"]);
  });

  it("fails closed for missing memory provenance, unsafe browser actions, failed recovery, and weak output", async () => {
    const unsafe: EvaluationObservation = {
      result: { answer: "" },
      memory: [{ id: "memory-1", source: "", sourceType: "", recordedAt: 0 }],
      browser: { actions: [{ kind: "executeScript", url: "javascript:alert(1)" }], confirmed: false },
      recovery: { attempted: true, recovered: false, action: "" },
      quality: { score: 0.1, required: ["answer"] }
    };
    const result = await runEvaluationHarness({ fixtures: providerNeutralFixtures.slice(2), adapter: async () => unsafe });

    expect(result.passed).toBe(false);
    expect(result.failures.map((failure) => failure.code)).toEqual([
      "MEMORY_PROVENANCE_INVALID",
      "BROWSER_SAFETY_VIOLATION",
      "RECOVERY_INCOMPLETE",
      "OUTPUT_QUALITY_BELOW_THRESHOLD"
    ]);
  });

  it("redacts secrets from report details and rejects malformed adapter output", async () => {
    const result = await runEvaluationHarness({
      fixtures: providerNeutralFixtures.slice(5),
      adapter: async () => ({ ...observation, result: { answer: "token=sk_live_fixture-secret" } })
    });

    expect(result.passed).toBe(false);
    expect(JSON.stringify(result)).not.toContain("sk_live_fixture-secret");
    expect(result.failures[0]?.code).toBe("OUTPUT_QUALITY_SECRET_LEAK");
  });
});
