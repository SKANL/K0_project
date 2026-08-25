import { describe, expect, it } from "vitest";
import { createDiagnostics, evaluateHealth, exportDiagnosticReport, redactDiagnosticValue } from "../../packages/observability/src/index.js";

describe("privacy-preserving observability", () => {
  const health = evaluateHealth({ liveness: true, dependencies: [{ name: "database", healthy: true }, { name: "provider", healthy: false, code: "UPSTREAM_TIMEOUT" }] });

  it("is explicitly opt-in and defaults callers to no recorded diagnostics", () => {
    const diagnostics = createDiagnostics({ policy: { enabled: false }, health });
    expect(diagnostics.record({ name: "request", timestamp: 1, attributes: { token: "never-store" } })).toEqual({ status: "disabled" });
    expect(diagnostics.report().events).toEqual([]);
  });

  it("redacts credentials, tokens, email addresses, URLs, query strings, and sensitive object keys", () => {
    const value = redactDiagnosticValue({ authorization: "Bearer secret-value", actor: "person@example.com", target: "https://service.example/path?token=secret", nested: { apiKey: "value", detail: "token=hidden" } });
    expect(value).toEqual({ actor: "[REDACTED]", authorization: "[REDACTED]", nested: { apiKey: "[REDACTED]", detail: "[REDACTED]" }, target: "[REDACTED]" });
  });

  it("propagates safe correlation IDs and generates safe replacements for unsafe input", () => {
    const diagnostics = createDiagnostics({ policy: { enabled: true }, health, correlationIdFactory: () => "diag-safe-0001" });
    expect(diagnostics.correlate("request-1234")).toBe("request-1234");
    expect(diagnostics.correlate("Bearer leaked-token")).toBe("diag-safe-0001");
    expect(diagnostics.record({ name: "request", timestamp: 2, requestId: "unsafe token=secret" })).toEqual({ status: "recorded", correlationId: "diag-safe-0001" });
  });

  it("reports liveness, readiness, and provider-neutral dependency state", () => {
    expect(health).toEqual({ liveness: true, readiness: false, dependencies: [{ name: "database", healthy: true }, { name: "provider", healthy: false, code: "UPSTREAM_TIMEOUT" }] });
  });

  it("rejects dependency names that are not strings at runtime", () => {
    expect(() => evaluateHealth({ liveness: true, dependencies: [{ name: 42, healthy: true }] } as unknown as Parameters<typeof evaluateHealth>[0])).toThrow("HEALTH_INPUT_INVALID");
  });

  it("exports deterministic redacted support reports without network transports or credentials", () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => { fetchCalls += 1; throw new Error("NETWORK_FORBIDDEN"); }) as typeof fetch;
    const diagnostics = createDiagnostics({ policy: { enabled: true }, health, correlationIdFactory: () => "diag-safe-0002" });
    diagnostics.record({ name: "request", timestamp: 20, attributes: { email: "person@example.com", url: "https://support.example/?api_key=nope", status: "failed" } });
    diagnostics.record({ name: "startup", timestamp: 10, attributes: { detail: "Bearer secret-value" } });
    const first = diagnostics.export();
    const second = exportDiagnosticReport(diagnostics.report());
    expect(first).toBe(second);
    expect(first).not.toMatch(/secret-value|person@example\.com|support\.example|api_key/i);
    expect(first).toContain("[REDACTED]");
    expect(first).toContain("diagnostic-report/v1");
    expect(fetchCalls).toBe(0);
    globalThis.fetch = originalFetch;
  });
});
