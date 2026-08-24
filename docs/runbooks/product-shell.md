# Product shell operations

The K0 product shell is a Tauri 2 webview for agent workspaces. Browser actions are sent only through the injected, capability-scoped browser contract after a one-time consent decision; the shell does not grant filesystem, shell, HTTP, or browser-plugin access.

## Quick path

1. Open the K0 main window and select a workspace with buttons or shortcuts `1`–`5`.
2. Review the trace pane before approving a proposed tool action.
3. Use **Reconnect** after an offline state; recovery never replays an uncertain action.

Use `npm run build` for a reproducible package build. It runs `build:product` first, which regenerates the ignored `apps/product/dist/` bundle, then runs Cargo with the locked Rust dependency graph. Do not commit `dist/`.

## Boundaries

| Topic | Decision |
|---|---|
| Desktop host | Tauri 2 only; Electron is not included. |
| Capabilities | Only the `main` window receives `main-capability`; filesystem, shell, HTTP, and browser plugins are absent. Each invoked Rust command resolves its own fixed entry in the `main-capability` mapping; caller-supplied command or capability values never grant authority, and unknown entries are denied. |
| UI state | `product-shell.ts` owns deterministic transitions and view models; `dom.ts` renders and dispatches events, while `main.ts` only mounts it. |
| Browser | The Browser route calls `browser.health` and, only after consent, `browser.navigate` on the production Tauri browser contract boundary. |
| Consent | Approval surfaces identify the command, reason, and one-time confirmation. |
| Recovery | Offline and error notices state that no prior effect was replayed. |

## Accessibility checklist

- [x] Skip link, landmarks, heading structure, and visible keyboard focus are present.
- [x] Buttons use native controls and meet a 44px minimum target size.
- [x] Keyboard shortcuts have matching visible navigation.
- [x] The active route focuses the main landmark; approvals use a modal focus trap, return focus to their trigger, and close with Escape.
- [x] Reduced motion is respected and the mobile layout collapses to one column.

## Rollback

Revert the product shell source, its focused UI/Rust tests, and this runbook together. This removes only the desktop product shell and its contract tests.

