import { describe, expect, it } from "vitest";
import { createOptInReleaseDiagnostics } from "../../packages/assurance/src/index.js";

describe("release diagnostics", () => {
  it("is opt-in and emits only redacted operational metadata", () => {
    const events: unknown[] = [];
    const disabled = createOptInReleaseDiagnostics({ enabled: false, sink: { write: (event) => events.push(event) } });
    expect(disabled.record({ name: "startup", releaseId: "1.0.0", code: "READY" })).toEqual({ status: "disabled" });
    const enabled = createOptInReleaseDiagnostics({ enabled: true, sink: { write: (event) => events.push(event) } });
    expect(enabled.record({ name: "update", releaseId: "1.0.1", code: "APPLIED" })).toEqual({ status: "recorded" });
    expect(events).toEqual([{ name: "update", releaseId: "1.0.1", code: "APPLIED" }]);
    expect(() => enabled.record({ name: "update", code: "token=secret" })).toThrow("DIAGNOSTIC_REDACTION_REQUIRED");
  });
});
