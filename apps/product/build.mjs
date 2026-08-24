import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const output = new URL("./dist/", import.meta.url);
await mkdir(output, { recursive: true });
await cp(new URL("./src/styles.css", import.meta.url), new URL("./dist/styles.css", import.meta.url));
const indexSource = await readFile(new URL("./index.html", import.meta.url), "utf8");
await writeFile(new URL("./dist/index.html", import.meta.url), indexSource.replace("./src/styles.css", "./styles.css").replace("./src/main.ts", "./main.js"));
await build({ bundle: true, entryPoints: ["apps/product/src/main.ts"], format: "esm", outfile: "apps/product/dist/main.js", target: "es2022" });
