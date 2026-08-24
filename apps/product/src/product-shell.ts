export type ProductRoute = "workspaces" | "inbox" | "runs" | "memory" | "integrations" | "browser" | "tool-approvals";
export type ProductStatus = "ready" | "loading" | "empty" | "offline" | "recovering" | "error" | "awaiting-consent" | "unsupported";

export type ToolApproval = {
  commandId: string;
  toolName: string;
  reason: string;
  risk: "low" | "medium" | "high";
  args?: unknown;
};

export type TraceEvent = { commandId: string; event: string; sequence: number };

export type ProductShellState = {
  workspaceId: string;
  workspaceName: string;
  route: ProductRoute;
  status: ProductStatus;
  message?: string;
  approval?: ToolApproval;
  trace: readonly TraceEvent[];
};

export type ProductShellEvent =
  | { type: "KEYBOARD_NAVIGATION"; key: string }
  | { type: "NAVIGATED"; route: ProductRoute }
  | { type: "TOOL_APPROVAL_REQUESTED"; approval: ToolApproval }
  | { type: "TOOL_APPROVAL_RESOLVED"; approved: boolean }
  | { type: "CONNECTION_OFFLINE" }
  | { type: "OFFLINE_OUTCOME"; outcome: "queued" | "running" | "failed" | "unknown" }
  | { type: "CAPABILITY_UNSUPPORTED"; capability: string; alternative?: string }
  | { type: "RECOVERY_REQUESTED" }
  | { type: "RECOVERY_SUCCEEDED" }
  | { type: "RECOVERY_FAILED"; message: string }
  | { type: "DATA_LOADING" }
  | { type: "DATA_EMPTY" }
  | { type: "DATA_READY" }
  | { type: "BROWSER_ACTION_COMPLETED"; commandId: string; toolName: "browser.navigate" | "browser.act" | "browser.observe"; status: "completed" | "denied" | "unknown" };

const routes: readonly ProductRoute[] = ["workspaces", "inbox", "runs", "memory", "integrations", "browser", "tool-approvals"];
const keyboardRoutes: Readonly<Record<string, ProductRoute>> = { "1": "workspaces", "2": "inbox", "3": "runs", "4": "memory", "5": "integrations" };

export function createProductShellState(input: { workspaceId: string; workspaceName: string }): ProductShellState {
  return { ...input, route: "workspaces", status: "ready", trace: [] };
}

function appendTrace(state: ProductShellState, commandId: string, event: string): readonly TraceEvent[] {
  return [...state.trace, { commandId, event, sequence: state.trace.length + 1 }];
}

export function transitionProductShell(state: ProductShellState, event: ProductShellEvent): ProductShellState {
  switch (event.type) {
    case "KEYBOARD_NAVIGATION":
      return keyboardRoutes[event.key] ? { ...state, route: keyboardRoutes[event.key], status: "ready", message: undefined } : state;
    case "NAVIGATED":
      return { ...state, route: event.route, status: "ready", message: undefined };
    case "TOOL_APPROVAL_REQUESTED":
      return { ...state, status: "awaiting-consent", approval: event.approval, trace: appendTrace(state, event.approval.commandId, "tool.approval.requested") };
    case "TOOL_APPROVAL_RESOLVED":
      return state.approval
        ? { ...state, status: "ready", approval: undefined, trace: appendTrace(state, state.approval.commandId, event.approved ? "tool.approval.approved" : "tool.approval.denied") }
        : state;
    case "CONNECTION_OFFLINE":
      return { ...state, status: "offline", message: "The desktop shell is offline. No action was sent." };
    case "OFFLINE_OUTCOME":
      return { ...state, status: event.outcome === "failed" ? "error" : event.outcome === "unknown" ? "recovering" : "offline", message: `Offline outcome: ${event.outcome}.` };
    case "CAPABILITY_UNSUPPORTED":
      return { ...state, status: "unsupported", message: `${event.capability} is unsupported on this platform.${event.alternative ? ` ${event.alternative}` : ""}` };
    case "RECOVERY_REQUESTED":
      return { ...state, status: "recovering", message: "Reconnecting without replaying previous actions." };
    case "RECOVERY_SUCCEEDED":
      return { ...state, status: "ready", message: undefined };
    case "RECOVERY_FAILED":
      return { ...state, status: "error", message: event.message };
    case "DATA_LOADING":
      return { ...state, status: "loading", message: "Loading workspace evidence." };
    case "DATA_EMPTY":
      return { ...state, status: "empty", message: "No records are available in this workspace." };
    case "DATA_READY":
      return { ...state, status: "ready", message: undefined };
    case "BROWSER_ACTION_COMPLETED":
      return {
        ...state,
        status: event.status === "completed" ? "ready" : event.status === "unknown" ? "recovering" : "error",
        message: event.status === "completed" ? undefined : `Browser action ${event.status}.`,
        trace: appendTrace(state, event.commandId, `${event.toolName}.${event.status}`)
      };
  }
}

export function productShellView(state: ProductShellState) {
  const approval = state.approval;
  const notices: Partial<Record<ProductStatus, { kind: "loading" | "empty" | "offline" | "recovering" | "error"; actionLabel?: string }>> = {
    loading: { kind: "loading" },
    empty: { kind: "empty" },
    offline: { kind: "offline", actionLabel: "Reconnect" },
    recovering: { kind: "recovering" },
    error: { kind: "error", actionLabel: "Try again" },
    unsupported: { kind: "error" }
  };
  const notice = notices[state.status];
  return {
    routes,
    mainLandmarkLabel: `${routeLabel(state.route)} for ${state.workspaceName}`,
    notice: notice && { ...notice, message: state.message },
    consent: approval && {
      commandId: approval.commandId,
      title: `Approval required for ${approval.toolName}`,
      description: approval.reason,
      confirmLabel: "Approve once"
    },
    trace: [...state.trace]
  };
}

function routeLabel(route: ProductRoute) { return route.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" "); }
function escapeHtml(value: string) { return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character); }

export function renderProductShellMarkup(state: ProductShellState): string {
  const view = productShellView(state);
  return `
    <a class="skip-link" href="#product-main">Skip to workspace content</a>
    <div data-product-background="true"><header class="topbar"><strong>K0</strong><span>Commercial agent operations</span><button data-event="offline" type="button">Connection status</button></header>
    <div class="layout">
      <nav aria-label="Workspace navigation"><h2>Workspace</h2>${view.routes.map((route, index) => `<button type="button" data-route="${route}" aria-current="${state.route === route ? "page" : "false"}">${index + 1}. ${routeLabel(route)}</button>`).join("")}</nav>
      <main id="product-main" tabindex="-1" aria-label="${escapeHtml(view.mainLandmarkLabel)}">
        <p class="eyebrow">${escapeHtml(state.workspaceName)}</p><h1>${routeLabel(state.route)}</h1>
        <p>Use keyboard shortcuts 1–5 to change workspaces. Actions are represented as deterministic evidence before they are sent.</p>
        ${view.notice ? `<section class="notice ${view.notice.kind}" role="${view.notice.kind === "error" ? "alert" : "status"}" aria-live="${view.notice.kind === "error" ? "assertive" : "polite"}"><strong>${view.notice.kind}</strong><p>${escapeHtml(view.notice.message ?? "")}</p>${view.notice.actionLabel ? `<button type="button" data-event="recover">${view.notice.actionLabel}</button>` : ""}</section>` : ""}
        <section aria-labelledby="agent-runs"><h2 id="agent-runs">Agent runs</h2><button type="button" data-event="approval">Request browser approval</button><p>Runs wait for explicit consent; no tool effect is implied by this shell.</p></section>
        ${state.route === "browser" ? `<section aria-labelledby="browser-view"><h2 id="browser-view">Browser</h2><p>Browser actions use the injected capability-scoped browser contract.</p><button type="button" data-event="browser-navigate">Navigate to approved page</button></section>` : ""}${state.route === "tool-approvals" ? `<section aria-labelledby="tool-approvals-view"><h2 id="tool-approvals-view">Tool Approvals</h2><p>${view.consent ? escapeHtml(view.consent.title) : "No tool approval is waiting."}</p></section>` : ""}
      </main>
      <aside aria-label="Trace and evidence"><h2>Trace evidence</h2><ol>${view.trace.map((trace) => `<li>${trace.sequence}. ${escapeHtml(trace.event)} (${escapeHtml(trace.commandId)})</li>`).join("") || "<li>No trace events yet.</li>"}</ol></aside>
    </div></div>
    ${view.consent ? `<section class="consent" aria-labelledby="consent-title" role="dialog" aria-modal="true"><h2 id="consent-title">${escapeHtml(view.consent.title)}</h2><p>${escapeHtml(view.consent.description)}</p><button type="button" data-event="approve">${view.consent.confirmLabel}</button><button type="button" data-event="deny">Deny</button></section>` : ""}`;
}
