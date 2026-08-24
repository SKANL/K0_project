import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.argv[2];
if (!root) throw new Error("RELEASE_ARTIFACT_DIRECTORY_REQUIRED");
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]));
  return nested.flat();
}
const artifacts = await files(root);
if (!artifacts.length) throw new Error("RELEASE_ARTIFACTS_MISSING");
const entries = await Promise.all(artifacts.map(async (file) => ({ path: relative(root, file).replaceAll("\\", "/"), sha256: createHash("sha256").update(await readFile(file)).digest("hex") })));
entries.sort((a, b) => a.path.localeCompare(b.path));
await writeFile(join(root, "checksums.txt"), entries.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n") + "\n");
await writeFile(join(root, "provenance.json"), JSON.stringify({ version: "k0-provenance/v1", commit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, channel: process.env.K0_RELEASE_CHANNEL, artifacts: entries }, null, 2) + "\n");
