import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { BrowserContractBoundary, BrowserContractCommand } from "./dom.js";
import type { ProductShellEvent } from "./product-shell.js";

export type ProductEventPort = Readonly<{ subscribe(listener: (event: ProductShellEvent) => void): () => void }>;

const browserCommands = new Set(["browser.health", "browser.navigate", "product.consent.resolve"]);
const tauriCommandName = (command: BrowserContractCommand) => command.replaceAll(".", "_");

export const productRuntime: Readonly<{ browser: BrowserContractBoundary; events: ProductEventPort }> = Object.freeze({
  browser: Object.freeze({
    invoke(command: BrowserContractCommand, args: unknown): Promise<unknown> {
      if (!browserCommands.has(command)) return Promise.reject(new Error("BROWSER_CONTRACT_DENIED"));
      return invoke(tauriCommandName(command), { args });
    }
  }),
  events: Object.freeze({
    subscribe(listener: (event: ProductShellEvent) => void): () => void {
      let active = true;
      let unlisten: (() => void) | undefined;
      void listen<ProductShellEvent>("product-shell-event", (event) => { if (active) listener(event.payload); }).then((dispose) => { if (active) unlisten = dispose; else dispose(); });
      return () => { active = false; unlisten?.(); };
    }
  })
});
