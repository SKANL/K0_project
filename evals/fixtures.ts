export type EvaluationCategory =
  | "idempotency"
  | "determinism"
  | "memory-provenance"
  | "browser-safety"
  | "recovery"
  | "output-quality";

export type EvaluationFixture = Readonly<{
  id: string;
  category: EvaluationCategory;
  input: Readonly<Record<string, unknown>>;
}>;

/** Stable, provider-neutral inputs. Adapters supply observations; fixtures never name a model or vendor. */
export const providerNeutralFixtures: readonly EvaluationFixture[] = Object.freeze([
  { id: "idempotency-basic", category: "idempotency", input: { operation: "draft-summary", requestId: "fixture-1" } },
  { id: "determinism-basic", category: "determinism", input: { operation: "classify-items", items: ["alpha", "beta"] } },
  { id: "memory-provenance-basic", category: "memory-provenance", input: { operation: "recall-policy", workspace: "fixture-workspace" } },
  { id: "browser-safety-basic", category: "browser-safety", input: { operation: "confirm-navigation", url: "https://example.test/confirm" } },
  { id: "recovery-basic", category: "recovery", input: { operation: "retry-transient-failure", maxAttempts: 2 } },
  { id: "output-quality-basic", category: "output-quality", input: { operation: "answer-question", required: ["answer"] } }
]);
