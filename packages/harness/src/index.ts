export type ToolErrorCode = "TOOL_INPUT_INVALID" | "TOOL_OUTPUT_INVALID" | "POLICY_DENIED" | "PRECONDITION_FAILED" | "POSTCONDITION_FAILED" | "TOOL_UNCERTAIN";
export type Validation<T> = { ok: true; value: T } | { ok: false; code: ToolErrorCode };
export type Check = { ok: true } | { ok: false; code: ToolErrorCode };

export type ToolContract<Input, Output> = {
  name: string;
  capability: string;
  validateInput(value: unknown): Validation<Input>;
  validateOutput(value: unknown): Validation<Output>;
  policy(input: Input): { allowed: boolean };
  precondition(input: Input): Check;
  postcondition(input: Input, output: Output): Check;
};

export async function executeTool<Input, Output>(input: { contract: ToolContract<Input, Output>; args: unknown; invoke(args: Input): Promise<unknown> }): Promise<{ ok: true; value: Output } | { ok: false; error: { code: ToolErrorCode } }> {
  const validated = input.contract.validateInput(input.args);
  if (!validated.ok) return { ok: false, error: { code: validated.code } };
  if (!input.contract.policy(validated.value).allowed) return { ok: false, error: { code: "POLICY_DENIED" } };
  const before = input.contract.precondition(validated.value);
  if (!before.ok) return { ok: false, error: { code: before.code } };
  try {
    const output = input.contract.validateOutput(await input.invoke(validated.value));
    if (!output.ok) return { ok: false, error: { code: output.code } };
    const after = input.contract.postcondition(validated.value, output.value);
    return after.ok ? { ok: true, value: output.value } : { ok: false, error: { code: after.code } };
  } catch {
    return { ok: false, error: { code: "TOOL_UNCERTAIN" } };
  }
}

export type RunState = "queued" | "running" | "completed" | "failed" | "manual_review";
export type VersionedRun = Readonly<{ state: RunState; version: number }>;
export type RunTransition = Readonly<{ commandId: string; expectedVersion: number; target: RunState; actor: string; reason: string; timestamp: number; evidence: string }>;
const legalTransitions: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ["running", "failed", "manual_review"], running: ["completed", "failed", "manual_review"], completed: [], failed: ["manual_review"], manual_review: ["queued", "failed"],
};
export function transitionRun(run: VersionedRun, transition: RunTransition): { ok: true; duplicate: boolean; state: VersionedRun } | { ok: false; error: { code: "OCC_CONFLICT"; expectedVersion: number; actualVersion: number } | { code: "ILLEGAL_TRANSITION" } } {
  if (transition.expectedVersion !== run.version) return { ok: false, error: { code: "OCC_CONFLICT", expectedVersion: transition.expectedVersion, actualVersion: run.version } };
  if (transition.target === run.state) return { ok: true, duplicate: true, state: run };
  if (!legalTransitions[run.state].includes(transition.target)) return { ok: false, error: { code: "ILLEGAL_TRANSITION" } };
  return { ok: true, duplicate: false, state: Object.freeze({ state: transition.target, version: run.version + 1 }) };
}

export type ContextSource = Readonly<{ id: string; workspaceId: string; priority: number; tokens: number; content: string; provenance: string }>;
export type ContextSnapshot = Readonly<{ workspaceId: string; budget: number; usedTokens: number; sourceIds: readonly string[]; omittedSourceIds: readonly string[]; provenance: readonly string[] }>;
export function assembleContextSnapshot(input: { workspaceId: string; budget: number; sources: readonly ContextSource[] }): ContextSnapshot {
  const selected: ContextSource[] = []; let usedTokens = 0;
  const ordered = [...input.sources].filter((source) => source.workspaceId === input.workspaceId && source.provenance.length > 0).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  for (const source of ordered) if (usedTokens + source.tokens <= input.budget) { selected.push(source); usedTokens += source.tokens; }
  const sourceIds = selected.map(({ id }) => id); const omittedSourceIds = ordered.filter(({ id }) => !sourceIds.includes(id)).map(({ id }) => id);
  return Object.freeze({ workspaceId: input.workspaceId, budget: input.budget, usedTokens, sourceIds: Object.freeze(sourceIds), omittedSourceIds: Object.freeze(omittedSourceIds), provenance: Object.freeze(selected.map(({ provenance }) => provenance)) });
}

export type LineageEdge = Readonly<{ from: string; to: string; workspaceId: string; provenance: string; score?: number }>;
export function createLineageGraph(workspaceId: string, maxEdges: number) {
  const edges: LineageEdge[] = [];
  return Object.freeze({
    addEdge(edge: LineageEdge): { ok: true } | { ok: false; code: "CROSS_TENANT_EDGE" | "PROVENANCE_REQUIRED" | "GRAPH_BOUND_EXCEEDED" } {
      if (edge.workspaceId !== workspaceId) return { ok: false, code: "CROSS_TENANT_EDGE" };
      if (!edge.provenance) return { ok: false, code: "PROVENANCE_REQUIRED" };
      if (edges.length >= maxEdges) return { ok: false, code: "GRAPH_BOUND_EXCEEDED" };
      edges.push(Object.freeze({ ...edge })); return { ok: true };
    },
    rank(): readonly LineageEdge[] { return Object.freeze([...edges].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))); },
  });
}

export type Effect = Readonly<{ idempotencyKey: string; sequence: number; runId: string; fence: number; outcome: "verified" | "denied" | "failed" | "unknown" }>;
export type EffectLedger = Readonly<{ effects: readonly Effect[]; fences: Readonly<Record<string, number>>; nextSequences: Readonly<Record<string, number>> }>;
export function consumeEffect(ledger: EffectLedger, effect: Effect): { accepted: boolean; duplicate?: boolean; error?: { code: "FENCE_REJECTED" | "SEQUENCE_REJECTED" }; effects: readonly Effect[]; fences: Readonly<Record<string, number>>; nextSequences: Readonly<Record<string, number>> } {
  if ((ledger.fences[effect.runId] ?? 0) !== effect.fence) return { accepted: false, error: { code: "FENCE_REJECTED" }, effects: ledger.effects, fences: ledger.fences, nextSequences: ledger.nextSequences };
  if (ledger.effects.some(({ idempotencyKey }) => idempotencyKey === effect.idempotencyKey)) return { accepted: false, duplicate: true, effects: ledger.effects, fences: ledger.fences, nextSequences: ledger.nextSequences };
  if ((ledger.nextSequences[effect.runId] ?? 1) !== effect.sequence) return { accepted: false, error: { code: "SEQUENCE_REJECTED" }, effects: ledger.effects, fences: ledger.fences, nextSequences: ledger.nextSequences };
  return { accepted: true, effects: Object.freeze([...ledger.effects, Object.freeze({ ...effect })]), fences: ledger.fences, nextSequences: Object.freeze({ ...ledger.nextSequences, [effect.runId]: effect.sequence + 1 }) };
}

export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")} ]`.replace(", ]", "]");
  if (value && typeof value === "object") { const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`; }
  return JSON.stringify(value);
}
export function replayTrace(trace: unknown, model: (trace: unknown) => { proposal: string; state: unknown; effects: readonly Effect[] }): { canonicalState: string; classification: "equivalent" | "different" } {
  const effects = [...model(trace).effects].sort((a, b) => a.runId.localeCompare(b.runId) || a.sequence - b.sequence || a.idempotencyKey.localeCompare(b.idempotencyKey));
  return { canonicalState: canonicalize({ effects }), classification: effects.every(({ outcome }) => outcome === "verified") ? "equivalent" : "different" };
}

export type RddReceipt = Readonly<{ reviewedBytes: string; transitions: readonly string[]; evidence: readonly string[]; lineage: string }>;
export function createRddReceipt(input: RddReceipt): RddReceipt { return Object.freeze({ reviewedBytes: input.reviewedBytes, transitions: Object.freeze([...input.transitions].sort()), evidence: Object.freeze([...input.evidence].sort()), lineage: input.lineage }); }
export function requireExactReceipt(receipt: RddReceipt | undefined, candidateBytes: string): { ok: true } | { ok: false; code: "RDD_RECEIPT_REQUIRED" | "RDD_BYTES_MISMATCH" } {
  if (!receipt || !receipt.lineage || !receipt.transitions.length || !receipt.evidence.length) return { ok: false, code: "RDD_RECEIPT_REQUIRED" };
  return receipt.reviewedBytes === candidateBytes ? { ok: true } : { ok: false, code: "RDD_BYTES_MISMATCH" };
}
