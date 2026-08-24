/** Browser control is an injected, capability-scoped host port. */
export type BrowserState = "idle" | "navigating" | "ready" | "acting" | "observing" | "recovering" | "failed";
export type BrowserAction = "click" | "fill" | "press" | "select";
export type BrowserCapability = "browser.navigate" | "browser.act" | "browser.observe" | "browser.reconcile";
export type BrowserIdentity = Readonly<{ tenantId: string; actorId: string; sessionId: string; profileId: string; tabId: string; policyVersion: number }>;
export type BrowserExecutionContext = Readonly<{ commandId: string; idempotencyToken: string; signal: AbortSignal } & BrowserIdentity>;
export type BrowserReconciliation = Readonly<{ outcome: "completed" | "not_found" | "unknown" }>;
export type BrowserHealth = Readonly<{ healthy: boolean; code?: string }>;
export type BrowserAdapter = Readonly<{
  navigate(url: string, context: BrowserExecutionContext): Promise<{ url: string; title?: string }>;
  act(locator: string, action: BrowserAction, context: BrowserExecutionContext): Promise<{ changed: boolean; postcondition?: { evidence: string }; [key: string]: unknown }>;
  snapshot(context: BrowserExecutionContext): Promise<string>;
  reconcile(context: Omit<BrowserExecutionContext, "signal">): Promise<BrowserReconciliation>;
  health?: (context: BrowserIdentity) => Promise<BrowserHealth>;
}>;
export type BrowserAuthorizationDecision = { allowed: true; tenantId: string; actorId: string; capability: BrowserCapability; policyVersion: number; sessionId: string } | { allowed: false; code: string };
export type BrowserAuthorizationPort = Readonly<{ authorize(request: BrowserIdentity & { capability: BrowserCapability }): Promise<BrowserAuthorizationDecision> }>;
export type BrowserSessionPort = Readonly<{ isActive(session: BrowserIdentity): Promise<boolean> }>;
export type BrowserCapabilityContract = Readonly<{ version: "browser-control/v1"; capabilities: readonly BrowserCapability[]; limits: { maxSnapshotChars: number; maxActionsPerCommand: 1 } }>;
export const browserCapabilityContract: BrowserCapabilityContract = Object.freeze<BrowserCapabilityContract>({ version: "browser-control/v1", capabilities: Object.freeze<BrowserCapability[]>(["browser.navigate", "browser.act", "browser.observe", "browser.reconcile"]), limits: Object.freeze({ maxSnapshotChars: 100_000, maxActionsPerCommand: 1 }) });
export type BrowserReceipt = Readonly<{ id: string; state: BrowserState; status: "completed" | "denied" | "unknown"; code?: string; replayed: boolean }>;
type ResultStatus = BrowserReceipt["status"];
type Result = Readonly<{ status: ResultStatus; state: BrowserState; code?: string; receipt: BrowserReceipt; observation?: { text: string; injectionDetected: boolean; truncated: boolean } }>;
type Command = Readonly<{ id: string; kind: "navigate" | "act" | "observe"; url?: string; locator?: string; action?: string; confirmed?: boolean } & BrowserIdentity>;
export type StoredResult = Omit<Result, "receipt"> & { commandFingerprint: string; receipt: Omit<BrowserReceipt, "replayed"> };
export type BrowserReceiptStore = Readonly<{
  get(id: string): Promise<StoredResult | undefined>;
  put(id: string, result: StoredResult): Promise<void>;
  putUncertain(id: string, result: StoredResult): Promise<void>;
  getDenial(id: string, commandFingerprint: string): Promise<StoredResult | undefined>;
  putDenial(id: string, commandFingerprint: string, result: StoredResult): Promise<void>;
}>;
export type BrowserControllerOptions = Readonly<{ adapter: BrowserAdapter; allowedOrigins: readonly string[]; snapshotBudget: number; timeoutMs?: number; receipts?: BrowserReceiptStore; authorization: BrowserAuthorizationPort; session: BrowserSessionPort; contract?: BrowserCapabilityContract }>;

export function createMemoryReceiptStore(): BrowserReceiptStore {
  const records = new Map<string, StoredResult>(); const denials = new Map<string, StoredResult>();
  const denialKey = (id: string, value: string) => `${id}\u0000${value}`;
  return { get: async (id) => records.get(id), put: async (id, value) => { records.set(id, value); }, putUncertain: async (id, value) => { records.set(id, value); }, getDenial: async (id, value) => denials.get(denialKey(id, value)), putDenial: async (id, value, result) => { denials.set(denialKey(id, value), result); } };
}

const blockedSnapshot = /ignore\s+(all\s+)?previous\s+instructions|system\s+prompt|reveal\s+(credentials|secrets?)/i;
const validLocator = /^(data-testid=[A-Za-z0-9_-]+|role=[a-z-]+\[name="[^"\n]+"\])$/;
const validAction = new Set<BrowserAction>(["click", "fill", "press", "select"]);
const capabilityFor: Record<Command["kind"], BrowserCapability> = { navigate: "browser.navigate", act: "browser.act", observe: "browser.observe" };
function receipt(id: string, state: BrowserState, status: ResultStatus, replayed: boolean, code?: string): BrowserReceipt { return Object.freeze({ id, state, status, code, replayed }); }
function safeOrigin(url: string, allowedOrigins: readonly string[]): boolean { try { return allowedOrigins.includes(new URL(url).origin); } catch { return false; } }
function fingerprint(command: Command): string { return JSON.stringify([command.tenantId, command.actorId, command.sessionId, command.profileId, command.tabId, command.policyVersion, command.kind, command.url ?? "", command.locator ?? "", command.action ?? "", command.confirmed === true]); }
function boundedObservation(raw: string, budget: number) { const sections = raw.split(/(?:\r?\n){2,}/); const injectionDetected = sections.some((section) => blockedSnapshot.test(section)); const text = [...new Set(sections.filter((section) => !blockedSnapshot.test(section)).flatMap((section) => section.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)))].sort().join("\n"); return Object.freeze({ text: text.slice(0, budget), injectionDetected, truncated: text.length > budget }); }
async function within<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> { const controller = new AbortController(); let timeout: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([work(controller.signal), new Promise<T>((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error("BROWSER_TIMEOUT")); }, timeoutMs); })]); } finally { if (timeout) clearTimeout(timeout); } }

export function createBrowserController(options: BrowserControllerOptions) {
  const contract = options.contract ?? browserCapabilityContract;
  if (contract.version !== "browser-control/v1" || contract.limits.maxActionsPerCommand !== 1 || !Number.isFinite(contract.limits.maxSnapshotChars) || contract.limits.maxSnapshotChars < 0) throw new RangeError("BROWSER_CAPABILITY_CONTRACT_INVALID");
  if (!Number.isFinite(options.snapshotBudget) || options.snapshotBudget < 0 || options.snapshotBudget > contract.limits.maxSnapshotChars) throw new RangeError("BROWSER_INVALID_SNAPSHOT_BUDGET");
  const timeoutMs = options.timeoutMs ?? 10_000; if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("BROWSER_INVALID_TIMEOUT");
  const receipts = options.receipts ?? createMemoryReceiptStore(); const states: BrowserState[] = ["idle"]; let state: BrowserState = "idle";
  const readyOrigins = new Map<string, string>(); const readiness = new Set<string>();
  const transition = (next: BrowserState) => { if (state !== next) { state = next; states.push(next); } };
  const identityKey = (command: BrowserIdentity) => JSON.stringify([command.tenantId, command.actorId, command.sessionId, command.profileId, command.tabId]);
  const readinessKey = (command: BrowserIdentity, origin: string) => JSON.stringify([command.tenantId, command.actorId, command.sessionId, command.profileId, command.tabId, origin]);
  const isReady = (command: BrowserIdentity) => { const origin = readyOrigins.get(identityKey(command)); return origin !== undefined && readiness.has(readinessKey(command, origin)); };
  const markReady = (command: BrowserIdentity, url: string) => { const origin = new URL(url).origin; readyOrigins.set(identityKey(command), origin); readiness.add(readinessKey(command, origin)); };
  const result = (command: Command, status: ResultStatus, code?: string, observation?: Result["observation"]): Result => Object.freeze({ status, state, code, observation, receipt: receipt(command.id, state, status, false, code) });
  const stored = (command: Command, value: Result): StoredResult => { const { replayed: _replayed, ...storedReceipt } = value.receipt; return { ...value, commandFingerprint: fingerprint(command), receipt: storedReceipt }; };
  const replay = (found: StoredResult): Result => Object.freeze({ ...found, receipt: receipt(found.receipt.id, found.state, found.status, true, found.code) });
  const persistDenial = async (command: Command, code: string): Promise<Result> => { const value = result(command, "denied", code); await receipts.putDenial(command.id, fingerprint(command), stored(command, value)); return value; };
  const recover = async (command: Command, code: string): Promise<Result> => { transition("recovering"); const value = result(command, "unknown", code); try { await receipts.putUncertain(command.id, stored(command, value)); } catch { /* fail closed: the caller still receives an uncertain result */ } return value; };
  const authorize = async (command: Command, requestedCapability = capabilityFor[command.kind]): Promise<Result | undefined> => { const capability = requestedCapability; if (!contract.capabilities.includes(capability)) return persistDenial(command, "BROWSER_CAPABILITY_DENIED"); if (!await options.session.isActive(command)) return persistDenial(command, "BROWSER_SESSION_REVOKED"); const decision = await options.authorization.authorize({ ...command, capability }); if (!decision.allowed) return persistDenial(command, decision.code); if (decision.tenantId !== command.tenantId || decision.actorId !== command.actorId || decision.sessionId !== command.sessionId) return persistDenial(command, "BROWSER_CROSS_TENANT"); if (decision.capability !== capability) return persistDenial(command, "BROWSER_CAPABILITY_DENIED"); if (decision.policyVersion !== command.policyVersion) return persistDenial(command, "BROWSER_STALE_POLICY"); return undefined; };
  const prior = async (command: Command): Promise<Result | undefined> => { const denial = await receipts.getDenial(command.id, fingerprint(command)); if (denial) return replay(denial); const found = await receipts.get(command.id); if (!found) return undefined; if (found.commandFingerprint !== fingerprint(command)) return persistDenial(command, "BROWSER_IDEMPOTENCY_CONFLICT"); if (found.status === "unknown") { transition("recovering"); return result(command, "unknown", "BROWSER_RECONCILIATION_REQUIRED"); } return replay(found); };
  const saveEffect = async (command: Command, value: Result): Promise<Result> => { try { await receipts.put(command.id, stored(command, value)); return value; } catch { return recover(command, "BROWSER_RECEIPT_UNCERTAIN"); } };
  const context = (command: Command, signal: AbortSignal): BrowserExecutionContext => ({ commandId: command.id, idempotencyToken: command.id, signal, tenantId: command.tenantId, actorId: command.actorId, sessionId: command.sessionId, profileId: command.profileId, tabId: command.tabId, policyVersion: command.policyVersion });
  const prepare = async (command: Command): Promise<Result | undefined> => (await authorize(command)) ?? await prior(command);

  return Object.freeze({
    history: (): readonly BrowserState[] => Object.freeze([...states]),
    health: async (identity: BrowserIdentity) => ({ contract, health: options.adapter.health ? await options.adapter.health(identity) : { healthy: true } }),
    navigate: async (command: { id: string; url: string } & BrowserIdentity): Promise<Result> => { const input: Command = { ...command, kind: "navigate" }; const existing = await prepare(input); if (existing) return existing; if (state === "recovering") return persistDenial(input, "BROWSER_RECONCILIATION_REQUIRED"); if (!safeOrigin(command.url, options.allowedOrigins)) return persistDenial(input, "BROWSER_ORIGIN_DENIED"); transition("navigating"); try { const final = await within((signal) => options.adapter.navigate(command.url, context(input, signal)), timeoutMs); if (!safeOrigin(final.url, options.allowedOrigins)) { transition("idle"); return persistDenial(input, "BROWSER_FINAL_ORIGIN_DENIED"); } markReady(input, final.url); transition("ready"); return saveEffect(input, result(input, "completed")); } catch (error) { return recover(input, error instanceof Error && error.message === "BROWSER_TIMEOUT" ? "BROWSER_TIMEOUT" : "BROWSER_ADAPTER_FAILURE"); } },
    act: async (command: { id: string; locator: string; action: string; confirmed?: boolean } & BrowserIdentity): Promise<Result> => { const input: Command = { ...command, kind: "act" }; const existing = await prepare(input); if (existing) return existing; if (state === "recovering") return persistDenial(input, "BROWSER_RECONCILIATION_REQUIRED"); if (!isReady(input)) return persistDenial(input, "BROWSER_NOT_READY"); if (!command.confirmed) return persistDenial(input, "BROWSER_CONFIRMATION_REQUIRED"); if (!validLocator.test(command.locator) || !validAction.has(command.action as BrowserAction)) return persistDenial(input, "BROWSER_ACTION_DENIED"); transition("acting"); try { const output = await within((signal) => options.adapter.act(command.locator, command.action as BrowserAction, context(input, signal)), timeoutMs); if (!output.changed || !output.postcondition?.evidence.trim()) { transition("ready"); return persistDenial(input, "BROWSER_POSTCONDITION_REQUIRED"); } transition("ready"); return saveEffect(input, result(input, "completed")); } catch (error) { return recover(input, error instanceof Error && error.message === "BROWSER_TIMEOUT" ? "BROWSER_TIMEOUT" : "BROWSER_ADAPTER_FAILURE"); } },
    observe: async (command: { id: string } & BrowserIdentity): Promise<Result> => { const input: Command = { ...command, kind: "observe" }; const existing = await prepare(input); if (existing) return existing; if (state === "recovering") return persistDenial(input, "BROWSER_RECONCILIATION_REQUIRED"); if (!isReady(input)) return persistDenial(input, "BROWSER_NOT_READY"); transition("observing"); try { const observation = boundedObservation(await within((signal) => options.adapter.snapshot(context(input, signal)), timeoutMs), options.snapshotBudget); transition("ready"); return saveEffect(input, result(input, "completed", undefined, observation)); } catch (error) { return recover(input, error instanceof Error && error.message === "BROWSER_TIMEOUT" ? "BROWSER_TIMEOUT" : "BROWSER_ADAPTER_FAILURE"); } },
    reconcile: async (command: Command): Promise<Result> => { const authorization = await authorize(command, "browser.reconcile"); if (authorization) return authorization; const pending = await receipts.get(command.id); if (!pending || pending.commandFingerprint !== fingerprint(command) || pending.status !== "unknown") return persistDenial(command, "BROWSER_RECONCILIATION_REQUIRED"); transition("recovering"); const outcome = await options.adapter.reconcile({ commandId: command.id, idempotencyToken: command.id, tenantId: command.tenantId, actorId: command.actorId, sessionId: command.sessionId, profileId: command.profileId, tabId: command.tabId, policyVersion: command.policyVersion }); if (outcome.outcome === "unknown") return result(command, "unknown", "BROWSER_RECONCILIATION_REQUIRED"); transition("ready"); if (outcome.outcome === "completed") return saveEffect(command, result(command, "completed")); return persistDenial(command, "BROWSER_EFFECT_NOT_FOUND"); },
  });
}

export function createTauriBrowserIpcHandler(controller: ReturnType<typeof createBrowserController>) {
  return async (request: { command: string; args: unknown }): Promise<{ ok: true; value: unknown } | { ok: false; code: string }> => {
    const args = request.args as never;
    switch (request.command) { case "browser.navigate": return { ok: true, value: await controller.navigate(args) }; case "browser.act": return { ok: true, value: await controller.act(args) }; case "browser.observe": return { ok: true, value: await controller.observe(args) }; case "browser.reconcile": return { ok: true, value: await controller.reconcile(args) }; case "browser.health": return { ok: true, value: await controller.health(args) }; default: return { ok: false, code: "BROWSER_IPC_DENIED" }; }
  };
}
