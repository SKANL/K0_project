import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("replay quality gate command", () => {
  const runQualityGate = (evidencePath?: string) => {
    const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npm";
    const args = process.platform === "win32"
      ? ["/d", "/s", "/c", `npm run eval:quality${evidencePath ? ` -- ${evidencePath}` : ""}`]
      : ["run", "eval:quality", ...(evidencePath ? ["--", evidencePath] : [])];
    try {
      return { status: 0, output: execFileSync(command, args, { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" }) };
    } catch (error) {
      const failure = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
      return { status: failure.status ?? 1, output: `${failure.stdout?.toString() ?? ""}${failure.stderr?.toString() ?? ""}` };
    }
  };

  it("fails closed when no replay evidence is supplied", () => {
    const result = runQualityGate();
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('"passed":false');
  });

  it("fails closed for malformed or invalid replay evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "quality-gate-"));
    const malformed = join(directory, "malformed.json");
    const invalid = join(directory, "invalid.json");
    writeFileSync(malformed, "{");
    writeFileSync(invalid, JSON.stringify([{ provider: "example" }]));

    for (const evidencePath of [malformed, invalid]) {
      const result = runQualityGate(evidencePath);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('"passed":false');
    }
  });

  it("exits nonzero when replay evidence fails", () => {
    const file = join(mkdtempSync(join(tmpdir(), "quality-gate-")), "failed.json");
    writeFileSync(file, JSON.stringify([{ expected: "accepted", actual: "denied" }]));
    expect(() => execFileSync(process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npm", process.platform === "win32" ? ["/d", "/s", "/c", `npm run eval:quality -- ${file}`] : ["run", "eval:quality", "--", file], { cwd: process.cwd(), stdio: "pipe" })).toThrow();
  });

  it("accepts complete replay evidence", () => {
    const file = join(mkdtempSync(join(tmpdir(), "quality-gate-")), "passed.json");
    writeFileSync(file, JSON.stringify([{ expected: "accepted", actual: "accepted" }]));
    const result = runQualityGate(file);
    expect(result.status).toBe(0);
    expect(result.output).toContain('"passed":true');
  });
});
