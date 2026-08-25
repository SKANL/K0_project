/** Deterministic reference ports. Production hosts implement these ports; this module makes no network calls. */
export type AutomationProvider = "composio" | "convex" | "sendblue";
export type AutomationState = "scheduled" | "running" | "completed" | "cancelled" | "failed";
export type ScheduledAutomation = Readonly<{
  id: string;
  provider: AutomationProvider;
  dueAt: number;
  idempotencyKey: string;
  state: AutomationState;
  providerExecutionId?: string;
  cancellationReason?: string;
}>;
export type AutomationAuditReceipt = Readonly<{
  action: "scheduled" | "completed" | "cancelled" | "failed";
  id: string;
  idempotencyKey: string;
  at: number;
  provider?: AutomationProvider;
}>;
export type AutomationProviderPort = Readonly<{
  provider: AutomationProvider;
  execute(input: Readonly<{ id: string; idempotencyKey: string }>): Promise<Readonly<{ providerExecutionId: string }>>;
}>;
export type AutomationScheduleInput = Readonly<{ id: string; provider: AutomationProvider; dueAt: number; idempotencyKey: string }>;

export function createInMemoryAutomationAdapter(provider: AutomationProvider): AutomationProviderPort & Readonly<{ calls(): readonly Readonly<{ id: string; idempotencyKey: string }>[] }> {
  const calls: Readonly<{ id: string; idempotencyKey: string }>[] = [];
  return Object.freeze({
    provider,
    execute: async (input) => {
      calls.push(Object.freeze({ ...input }));
      return Object.freeze({ providerExecutionId: `${provider}:${input.idempotencyKey}` });
    },
    calls: () => Object.freeze([...calls]),
  });
}

export function createInMemoryBeatScheduler(options: Readonly<{ adapters: readonly AutomationProviderPort[] }>) {
  const adapters = new Map(options.adapters.map((adapter) => [adapter.provider, adapter]));
  const jobs = new Map<string, ScheduledAutomation>();
  const idempotency = new Map<string, string>();
  const receipts: AutomationAuditReceipt[] = [];
  let queuedBeat = Promise.resolve();
  const receipt = (action: AutomationAuditReceipt["action"], job: ScheduledAutomation, at: number) => receipts.push(Object.freeze({ action, id: job.id, idempotencyKey: job.idempotencyKey, at, provider: job.provider }));
  const view = (job: ScheduledAutomation, replay: boolean) => Object.freeze({ ...job, replay });
  const runBeat = async (input: Readonly<{ now: number; limit?: number }>) => {
    const due = [...jobs.values()]
      .filter((job) => job.state === "scheduled" && job.dueAt <= input.now)
      .sort((left, right) => left.dueAt - right.dueAt || left.id.localeCompare(right.id))
      .slice(0, input.limit ?? Number.MAX_SAFE_INTEGER);
    const results: ScheduledAutomation[] = [];
    for (const job of due) {
      const running = Object.freeze({ ...job, state: "running" as const }); jobs.set(job.id, running);
      try {
        const execution = await adapters.get(job.provider)!.execute({ id: job.id, idempotencyKey: job.idempotencyKey });
        const current = jobs.get(job.id);
        if (current?.state === "cancelled") { results.push(current); continue; }
        const completed = Object.freeze({ ...running, state: "completed" as const, providerExecutionId: execution.providerExecutionId });
        jobs.set(job.id, completed); receipt("completed", completed, input.now); results.push(completed);
      } catch {
        const current = jobs.get(job.id);
        if (current?.state === "cancelled") { results.push(current); continue; }
        const failed = Object.freeze({ ...running, state: "failed" as const });
        jobs.set(job.id, failed); receipt("failed", failed, input.now); results.push(failed);
      }
    }
    return Object.freeze(results);
  };

  return Object.freeze({
    schedule(input: AutomationScheduleInput) {
      const existingId = idempotency.get(input.idempotencyKey);
      if (existingId) return view(jobs.get(existingId)!, true);
      if (!adapters.has(input.provider)) throw new Error("AUTOMATION_PROVIDER_UNAVAILABLE");
      const job = Object.freeze({ ...input, state: "scheduled" as const });
      jobs.set(job.id, job); idempotency.set(job.idempotencyKey, job.id); receipt("scheduled", job, job.dueAt);
      return view(job, false);
    },
    cancel(input: Readonly<{ id: string; reason: string; at: number }>) {
      const current = jobs.get(input.id);
      if (!current) throw new Error("AUTOMATION_JOB_NOT_FOUND");
      if (current.state === "cancelled") return view(current, true);
      if (current.state === "completed" || current.state === "failed") return view(current, true);
      const cancelled = Object.freeze({ ...current, state: "cancelled" as const, cancellationReason: input.reason });
      jobs.set(cancelled.id, cancelled); receipt("cancelled", cancelled, input.at);
      return view(cancelled, false);
    },
    beat(input: Readonly<{ now: number; limit?: number }>) {
      const execution = queuedBeat.then(() => runBeat(input));
      queuedBeat = execution.then(() => undefined, () => undefined);
      return execution;
    },
    get(id: string) { return jobs.get(id); },
    audit() { return Object.freeze([...receipts]); },
  });
}

export type AppleCapability = "notes" | "shortcuts" | "iMessage";
export type AppleCapabilityRequest = Readonly<{ capability: AppleCapability; platform: "ios" | "macos" | "other"; permission: "granted" | "denied" | "unknown"; consent: "granted" | "denied" }>;
export type AppleCapabilityPort = Readonly<{ resolve(input: AppleCapabilityRequest): Readonly<{ available: boolean; fallback?: "ask_permission" | "unsupported_platform" | "manual_share" | "manual_export" }> }>;

export function createAppleCapabilityPort(): AppleCapabilityPort {
  return Object.freeze({ resolve: (input) => {
    if (input.capability === "iMessage") return Object.freeze({ available: false, fallback: "manual_share" as const });
    if (input.consent === "denied") return Object.freeze({ available: false, fallback: "manual_export" as const });
    if (input.permission !== "granted") return Object.freeze({ available: false, fallback: "ask_permission" as const });
    const supported = input.capability === "notes" ? input.platform === "macos" : input.platform !== "other";
    return supported ? Object.freeze({ available: true }) : Object.freeze({ available: false, fallback: "unsupported_platform" as const });
  } });
}
