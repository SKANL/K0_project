import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

type TaskEvidence = Record<string, unknown> & { taskId: string; evidenceMode: string; testPath: string; evidenceHash: string };

function hash(record: TaskEvidence): string {
  const { evidenceHash: _evidenceHash, ...canonical } = record;
  const sort = (value: unknown): unknown => Array.isArray(value) ? value.map(sort) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sort(child)]))
    : value;
  return `sha256:${createHash("sha256").update(JSON.stringify(sort(canonical))).digest("hex")}`;
}

describe("K0 closure evidence", () => {
  it("keeps all 32 task records canonical, test-addressable, and candid about retrospective RED evidence", async () => {
    const source = await readFile(new URL("../../docs/evidence/k0-complete-platform-tasks.json", import.meta.url), "utf8");
    const artifact = JSON.parse(source) as { schema: string; tasks: TaskEvidence[] };
    expect(artifact.schema).toBe("k0-task-evidence/v1");
    expect(artifact.tasks).toHaveLength(32);
    expect(new Set(artifact.tasks.map((task) => task.taskId)).size).toBe(32);
    for (const task of artifact.tasks) {
      expect(task.testPath).toMatch(/^((tests\/|apps\/product\/src-tauri\/src\/).+)/);
      expect(task.evidenceHash).toBe(hash(task));
      if (task.evidenceMode === "retrospective-current-contract") {
        expect((task.red as { result: string }).result).toContain("retrospective");
      }
    }
  });
});
