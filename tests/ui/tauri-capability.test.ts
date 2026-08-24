import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const productRoot = resolve(process.cwd(), "apps/product");

describe("Tauri product capability contract", () => {
  it("ships a mobile-ready shell with only the named product bridge commands", async () => {
    const config = JSON.parse(await readFile(resolve(productRoot, "src-tauri/tauri.conf.json"), "utf8"));
    const capability = JSON.parse(await readFile(resolve(productRoot, "src-tauri/capabilities/main.json"), "utf8"));

    expect(config.build.frontendDist).toBe("../dist");
    expect(config.app.windows).toEqual([expect.objectContaining({ label: "main" })]);
    expect(capability.permissions).toEqual(["core:default"]);
    expect(capability.remote).toBeUndefined();
  });

  it("does not expose filesystem, shell, or arbitrary browser capabilities", async () => {
    const capability = await readFile(resolve(productRoot, "src-tauri/capabilities/main.json"), "utf8");
    const source = await readFile(resolve(productRoot, "src-tauri/src/lib.rs"), "utf8");

    expect(capability).not.toMatch(/fs:|shell:|http:|browser:/);
    expect(source).toContain("k0_product_shell_contract");
    expect(source).not.toMatch(/Command::new|std::process|tauri_plugin_shell/);
  });
});

  it("builds the configured frontend distribution from the declared index source", async () => {
    const buildSource = await readFile(resolve(productRoot, "build.mjs"), "utf8");
    expect(buildSource).toMatch(/readFile\(new URL\("\.\/index\.html"/);
    expect(buildSource).not.toContain("<!doctype html>");
  });
