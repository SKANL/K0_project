export type DiagnosticPolicy = Readonly<{ enabled: boolean }>;
export type DiagnosticScalar = string | number | boolean | null;
export interface DiagnosticAttributes { readonly [key: string]: DiagnosticValue; }
export type DiagnosticValue = DiagnosticScalar | readonly DiagnosticValue[] | DiagnosticAttributes;
export type DiagnosticEvent = Readonly<{ name: string; timestamp: number; correlationId?: string; attributes?: DiagnosticAttributes }>;
export type DependencyHealth = Readonly<{ name: string; healthy: boolean; code?: string }>;
export type HealthSignals = Readonly<{ liveness: boolean; readiness: boolean; dependencies: readonly DependencyHealth[] }>;
export type DiagnosticReport = Readonly<{ version: "diagnostic-report/v1"; policy: "opt-in"; health: HealthSignals; events: readonly DiagnosticEvent[] }>;
export type CorrelationIdFactory = () => string;

const redacted = "[REDACTED]";
const sensitiveKey = /(?:authorization|credential|secret|token|password|passphrase|api[_-]?key|email|e-mail|url|uri|query|cookie|session|private.?key)/i;
const sensitiveText = /(?:bearer\s+[^\s,;]+|\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]+|\b(?:api[_-]?key|password|passphrase|secret|token|credential)\s*[=:]\s*[^\s,;]+|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:https?|wss?):\/\/[^\s,;]+)/gi;
const safeCorrelationId = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;

/** Redacts sensitive keys and values recursively; it never performs I/O or telemetry. */
export function redactDiagnosticValue(value: DiagnosticValue, key?: string): DiagnosticValue {
  if (key && sensitiveKey.test(key)) return redacted;
  if (typeof value === "string") return value.replace(sensitiveText, redacted);
  if (Array.isArray(value)) return Object.freeze(value.map((item) => redactDiagnosticValue(item)));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.keys(value).sort().map((entry) => [entry, redactDiagnosticValue((value as DiagnosticAttributes)[entry]!, entry)])));
  return value;
}

function freezeHealth(input: HealthSignals): HealthSignals {
  const dependencies = input.dependencies.map((dependency) => Object.freeze({ name: redactDiagnosticValue(dependency.name) as string, healthy: dependency.healthy === true, ...(dependency.code ? { code: redactDiagnosticValue(dependency.code) as string } : {}) })).sort((left, right) => left.name.localeCompare(right.name));
  return Object.freeze({ liveness: input.liveness === true, readiness: input.readiness === true && dependencies.every((dependency) => dependency.healthy), dependencies: Object.freeze(dependencies) });
}

export function evaluateHealth(input: Readonly<{ liveness: boolean; dependencies: readonly DependencyHealth[] }>): HealthSignals {
  if (!input || !Array.isArray(input.dependencies) || input.dependencies.some((dependency) => !dependency || typeof dependency.name !== "string" || !dependency.name)) throw new Error("HEALTH_INPUT_INVALID");
  return freezeHealth({ liveness: input.liveness === true, readiness: input.liveness === true, dependencies: input.dependencies });
}

function canonical(value: unknown): string {
  if (value === undefined) throw new Error("DIAGNOSTIC_VALUE_INVALID");
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

/** Formats a deterministic, redacted support report without network or provider behavior. */
export function exportDiagnosticReport(report: DiagnosticReport): string {
  return canonical(Object.freeze({ version: report.version, policy: report.policy, health: freezeHealth(report.health), events: Object.freeze(report.events.map((event) => sanitizeEvent(event)).sort(compareEvents)) }));
}

function compareEvents(left: DiagnosticEvent, right: DiagnosticEvent): number {
  return left.timestamp - right.timestamp || left.name.localeCompare(right.name) || (left.correlationId ?? "").localeCompare(right.correlationId ?? "");
}

function sanitizeEvent(input: DiagnosticEvent): DiagnosticEvent {
  if (!input || !input.name || !Number.isFinite(input.timestamp)) throw new Error("DIAGNOSTIC_EVENT_INVALID");
  const attributes = input.attributes ? redactDiagnosticValue(input.attributes) as DiagnosticAttributes : undefined;
  return Object.freeze({ name: redactDiagnosticValue(input.name) as string, timestamp: input.timestamp, ...(input.correlationId && safeCorrelationId.test(input.correlationId) ? { correlationId: input.correlationId } : {}), ...(attributes ? { attributes } : {}) });
}

/** In-memory, opt-in diagnostics. This collector deliberately exposes no transport or network port. */
export function createDiagnostics(options: Readonly<{ policy: DiagnosticPolicy; health: HealthSignals; correlationIdFactory?: CorrelationIdFactory }>) {
  if (!options || options.policy?.enabled !== true && options.policy?.enabled !== false) throw new Error("DIAGNOSTIC_POLICY_REQUIRED");
  let counter = 0;
  const nextId = () => {
    const candidate = options.correlationIdFactory?.() ?? `diag-${++counter}`.padEnd(8, "0");
    if (!safeCorrelationId.test(candidate)) throw new Error("CORRELATION_ID_INVALID");
    return candidate;
  };
  let health = freezeHealth(options.health);
  const events: DiagnosticEvent[] = [];
  return Object.freeze({
    policy: Object.freeze({ enabled: options.policy.enabled }),
    correlate(requestId?: string) { return safeCorrelationId.test(requestId ?? "") ? requestId! : nextId(); },
    record(event: Omit<DiagnosticEvent, "correlationId"> & Readonly<{ correlationId?: string; requestId?: string }>) {
      if (!options.policy.enabled) return Object.freeze({ status: "disabled" as const });
      const correlationId = safeCorrelationId.test(event.correlationId ?? "") ? event.correlationId! : safeCorrelationId.test(event.requestId ?? "") ? event.requestId! : nextId();
      events.push(sanitizeEvent({ ...event, correlationId }));
      return Object.freeze({ status: "recorded" as const, correlationId });
    },
    setHealth(next: HealthSignals) { health = freezeHealth(next); },
    report(): DiagnosticReport { return Object.freeze({ version: "diagnostic-report/v1" as const, policy: "opt-in" as const, health, events: Object.freeze(events.map((event) => sanitizeEvent(event)).sort(compareEvents)) }); },
    export(): string { return exportDiagnosticReport(this.report()); }
  });
}
