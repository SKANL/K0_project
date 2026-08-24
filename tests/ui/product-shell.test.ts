import { describe, expect, it } from "vitest";
import {
  createProductShellState,
  productShellView,
  renderProductShellMarkup,
  transitionProductShell
} from "../../apps/product/src/product-shell.js";
import type { ProductShellEvent } from "../../apps/product/src/product-shell.js";
import { JSDOM } from "jsdom";
import { mountProductShell } from "../../apps/product/src/dom.js";

const browserResult = (status: "completed" | "denied" = "completed") => ({
  status,
  receipt: { id: "browser-command-1", state: "ready", status, replayed: false }
});

describe("product shell state machine", () => {
  it("moves workspace navigation with keyboard input without losing the selected workspace", () => {
    const ready = createProductShellState({ workspaceId: "workspace-a", workspaceName: "Northstar" });
    const inbox = transitionProductShell(ready, { type: "KEYBOARD_NAVIGATION", key: "2" });

    expect(inbox.workspaceId).toBe("workspace-a");
    expect(inbox.route).toBe("inbox");
    expect(productShellView(inbox).mainLandmarkLabel).toBe("Inbox for Northstar");
  });

  it("keeps a deterministic trace visible while a tool approval is awaiting consent", () => {
    const ready = createProductShellState({ workspaceId: "workspace-a", workspaceName: "Northstar" });
    const approval = transitionProductShell(ready, {
      type: "TOOL_APPROVAL_REQUESTED",
      approval: { commandId: "cmd-7", toolName: "browser.act", reason: "Click the saved invoice", risk: "high" }
    });

    expect(approval.status).toBe("awaiting-consent");
    expect(productShellView(approval).consent).toEqual({
      commandId: "cmd-7",
      title: "Approval required for browser.act",
      description: "Click the saved invoice",
      confirmLabel: "Approve once"
    });
    expect(productShellView(approval).trace).toEqual([
      { commandId: "cmd-7", event: "tool.approval.requested", sequence: 1 }
    ]);
  });

  it("offers recovery from offline and error states without pretending an action completed", () => {
    const ready = createProductShellState({ workspaceId: "workspace-a", workspaceName: "Northstar" });
    const offline = transitionProductShell(ready, { type: "CONNECTION_OFFLINE" });
    const recovery = transitionProductShell(offline, { type: "RECOVERY_REQUESTED" });
    const failed = transitionProductShell(recovery, { type: "RECOVERY_FAILED", message: "Gateway unavailable" });

    expect(productShellView(offline).notice).toMatchObject({ kind: "offline", actionLabel: "Reconnect" });
    expect(recovery.status).toBe("recovering");
    expect(productShellView(failed).notice).toMatchObject({ kind: "error", message: "Gateway unavailable", actionLabel: "Try again" });
  });

  it("renders keyboard-operable landmarks, a skip link, and a consent dialog with native controls", () => {
    const awaitingConsent = transitionProductShell(createProductShellState({ workspaceId: "workspace-a", workspaceName: "Northstar" }), {
      type: "TOOL_APPROVAL_REQUESTED",
      approval: { commandId: "cmd-8", toolName: "browser.observe", reason: "Read the confirmation page", risk: "medium" }
    });
    const markup = renderProductShellMarkup(awaitingConsent);

    expect(markup).toContain('href="#product-main"');
    expect(markup).toContain('<nav aria-label="Workspace navigation">');
    expect(markup).toContain('<main id="product-main" tabindex="-1" aria-label="Workspaces for Northstar">');
    expect(markup).toContain('role="dialog" aria-modal="true"');
    expect(markup).toContain('<button type="button" data-event="approve">Approve once</button>');
  });

  it("moves focus into an approval dialog, traps Tab, returns focus on Escape, and focuses the active view", () => {
    const dom = new JSDOM('<!doctype html><div id="app"></div>', { pretendToBeVisual: true });
    const shell = mountProductShell(dom.window.document);

    const inbox = dom.window.document.querySelector<HTMLButtonElement>('[data-route="inbox"]')!;
    inbox.click();
    expect(dom.window.document.activeElement?.id).toBe("product-main");

    dom.window.document.querySelector<HTMLButtonElement>('[data-route="browser"]')!.click();
    const request = dom.window.document.querySelector<HTMLButtonElement>('[data-event="browser-navigate"]')!;
    request.click();
    expect(dom.window.document.activeElement?.getAttribute("data-event")).toBe("approve");

    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(dom.window.document.activeElement?.getAttribute("data-event")).toBe("deny");
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(shell.state.status).toBe("ready");
    expect(dom.window.document.activeElement?.getAttribute("data-event")).toBe("browser-navigate");
  });

  it("suppresses numeric route shortcuts while consent is open", () => {
    const dom = new JSDOM('<!doctype html><div id="app"></div>', { pretendToBeVisual: true });
    const shell = mountProductShell(dom.window.document);

    dom.window.document.querySelector<HTMLButtonElement>('[data-route="browser"]')!.click();
    dom.window.document.querySelector<HTMLButtonElement>('[data-event="browser-navigate"]')!.click();
    const shortcut = new dom.window.KeyboardEvent("keydown", { key: "2", bubbles: true, cancelable: true });
    dom.window.document.dispatchEvent(shortcut);

    expect(shortcut.defaultPrevented).toBe(true);
    expect(shell.state).toMatchObject({ route: "browser", status: "awaiting-consent" });
    expect(dom.window.document.activeElement?.getAttribute("data-event")).toBe("approve");
  });

  it("makes loading, empty, offline, and recovery/error paths dispatcher-reachable", () => {
    const dom = new JSDOM('<!doctype html><div id="app"></div>', { pretendToBeVisual: true });
    mountProductShell(dom.window.document);

    dom.window.document.querySelector<HTMLButtonElement>('[data-event="data-loading"]')!.click();
    expect(dom.window.document.querySelector(".loading")).not.toBeNull();
    dom.window.document.querySelector<HTMLButtonElement>('[data-event="data-empty"]')!.click();
    expect(dom.window.document.querySelector(".empty")).not.toBeNull();
    dom.window.document.querySelector<HTMLButtonElement>('[data-event="offline"]')!.click();
    dom.window.document.querySelector<HTMLButtonElement>('[data-event="recover"]')!.click();
    expect(dom.window.document.querySelector(".recovering")).not.toBeNull();
    dom.window.document.querySelector<HTMLButtonElement>('[data-event="recovery-failed"]')!.click();
    expect(dom.window.document.querySelector(".error")?.textContent).toContain("Workspace service is unavailable.");
  });

  it("uses provider events and explicit consent to run a browser boundary action", async () => {
    const dom = new JSDOM('<!doctype html><div id="app"></div>', { pretendToBeVisual: true });
    const calls: Array<{ command: string; args: unknown }> = [];
    const shell = mountProductShell(dom.window.document, {
      browser: {
        invoke: async (command, args) => {
          calls.push({ command, args });
          return command === "browser.health" ? { health: { healthy: true } } : browserResult();
        }
      }
    });

    await Promise.resolve();
    expect(calls[0]?.command).toBe("browser.health");
    dom.window.document.querySelector<HTMLButtonElement>('[data-route="browser"]')!.click();
    expect(dom.window.document.querySelector("h1")?.textContent).toBe("Browser");
    dom.window.document.querySelector<HTMLButtonElement>('[data-event="browser-navigate"]')!.click();
    expect(shell.state.status).toBe("awaiting-consent");
    expect(calls.map((call) => call.command)).not.toContain("browser.navigate");

    dom.window.document.querySelector<HTMLButtonElement>('[data-event="approve"]')!.click();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.map((call) => call.command)).toContain("product.consent.resolve");
    expect(calls.map((call) => call.command)).toContain("browser.navigate");
    expect(calls.findIndex((call) => call.command === "product.consent.resolve")).toBeLessThan(calls.findIndex((call) => call.command === "browser.navigate"));
    expect(shell.state.trace.at(-1)).toMatchObject({ event: "browser.navigate.completed" });
  });

  it("renders dynamic provider text as text, isolates background content, and reverse-wraps modal focus", () => {
    const dom = new JSDOM('<!doctype html><div id="app"></div>', { pretendToBeVisual: true });
    mountProductShell(dom.window.document);
    dom.window.document.querySelector<HTMLButtonElement>('[data-route="browser"]')!.click();
    const request = dom.window.document.querySelector<HTMLButtonElement>('[data-event="browser-navigate"]')!;
    request.click();
    const dialog = dom.window.document.querySelector<HTMLElement>('[role="dialog"]')!;
    const background = dom.window.document.querySelector<HTMLElement>('[data-product-background]')!;
    expect(background.inert).toBe(true);
    expect(background.getAttribute("aria-hidden")).toBe("true");
    expect(dialog.textContent).toContain("browser.navigate");
    dom.window.document.querySelector<HTMLButtonElement>('[data-event="approve"]')!.focus();
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    expect(dom.window.document.activeElement?.getAttribute("data-event")).toBe("deny");
  });
});

it("uses provider consent details and invokes browser navigation only after the real approval", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { pretendToBeVisual: true });
  const calls: Array<{ command: string; args: unknown }> = [];
  let providerEvent: ((event: ProductShellEvent) => void) | undefined;
  const shell = mountProductShell(dom.window.document, {
    browser: { invoke: async (command, args) => { calls.push({ command, args }); return command === "browser.health" ? { health: { healthy: true } } : browserResult(); } },
    events: { subscribe(listener) { providerEvent = listener; return () => {}; } }
  });
  providerEvent!({ type: "NAVIGATED", route: "browser" });
  dom.window.document.querySelector<HTMLButtonElement>("[data-event=browser-navigate]")!.click();
  expect(shell.state.approval).toMatchObject({ toolName: "browser.navigate", commandId: "browser-navigate-1" });
  expect(calls.map((call) => call.command)).not.toContain("browser.navigate");
  dom.window.document.querySelector<HTMLButtonElement>("[data-event=approve]")!.click();
  await Promise.resolve();
  expect(calls).toContainEqual(expect.objectContaining({ command: "browser.navigate" }));
});

it("keeps every provider state transition reachable and never parses provider text as markup", () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { pretendToBeVisual: true });
  let providerEvent: ((event: ProductShellEvent) => void) | undefined;
  const shell = mountProductShell(dom.window.document, { events: { subscribe(listener) { providerEvent = listener; return () => {}; } } });
  providerEvent!({ type: "TOOL_APPROVAL_REQUESTED", approval: { commandId: "external-1", toolName: "browser.observe", reason: '<img src=x onerror=alert(1)>', risk: "low" } });
  expect(dom.window.document.querySelector("img")).toBeNull();
  expect(dom.window.document.querySelector("[role=dialog]")?.textContent).toContain("<img src=x onerror=alert(1)>");
  providerEvent!({ type: "TOOL_APPROVAL_RESOLVED", approved: false });
  providerEvent!({ type: "DATA_LOADING" });
  providerEvent!({ type: "DATA_EMPTY" });
  providerEvent!({ type: "DATA_READY" });
  providerEvent!({ type: "CONNECTION_OFFLINE" });
  providerEvent!({ type: "RECOVERY_REQUESTED" });
  providerEvent!({ type: "RECOVERY_SUCCEEDED" });
  expect(shell.state).toMatchObject({ status: "ready", approval: undefined });
});


describe("Tool Approvals production route", () => {
  it("exposes a Tool Approvals route and mounts the browser boundary with the provider event port", async () => {
    const state = transitionProductShell(createProductShellState({ workspaceId: "workspace-a", workspaceName: "Northstar" }), { type: "NAVIGATED", route: "tool-approvals" });
    expect(productShellView(state).mainLandmarkLabel).toBe("Tool Approvals for Northstar");

    const startup = await import("../../apps/product/src/main.js");
    expect(startup.productRuntime.browser).toBeDefined();
    expect(startup.productRuntime.events).toBeDefined();
  });
});
