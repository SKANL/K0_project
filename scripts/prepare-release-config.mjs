import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const publicKey = process.env.TAURI_UPDATER_PUBLIC_KEY;
if (!publicKey || publicKey.includes("__TAURI_")) throw new Error("TAURI_UPDATER_PUBLIC_KEY_REQUIRED");
const source = JSON.parse(await readFile("apps/product/src-tauri/tauri.conf.json", "utf8"));
if (source.plugins?.updater?.pubkey !== "__TAURI_UPDATER_PUBLIC_KEY__") throw new Error("TAURI_UPDATER_TEMPLATE_INVALID");
source.plugins.updater.pubkey = publicKey;
const directory = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "k0-release-config-"));
const path = join(directory, "tauri.release.conf.json");
await writeFile(path, `${JSON.stringify(source, null, 2)}\n`);
process.stdout.write(`path=${path}\n`);
