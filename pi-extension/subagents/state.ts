// Shared runtime state that survives /reload: timers, registry, status config.
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadStatusConfig } from "./status/config.ts";
import type { SubagentStatusState } from "./status/snapshot.ts";

// Closures from the previous module load keep running after /reload, so their
// timers and pollers must be cleared or they pile up.
export const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
export const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
const POLL_ABORT_KEY = Symbol.for("pi-subagents/poll-abort-controller");

/** Symbol-keyed store for state that must survive /reload. */
export const globalStore = globalThis as Record<symbol, unknown>;

teardownModuleTimers();

/**
 * Stop timers and poll loops left by the current module load, then re-arm the
 * abort controller. Runs at load and on session_shutdown.
 */
export function teardownModuleTimers(): void {
  clearStoredInterval(WIDGET_INTERVAL_KEY);
  clearStoredInterval(STATUS_INTERVAL_KEY);
  const prevAbort = globalStore[POLL_ABORT_KEY] as AbortController | undefined;
  if (prevAbort) prevAbort.abort();
  // Re-arm so a cached module never inherits an aborted signal.
  globalStore[POLL_ABORT_KEY] = new AbortController();
}

export function getModuleAbortSignal(): AbortSignal {
  return (globalStore[POLL_ABORT_KEY] as AbortController).signal;
}

/** Interval handles live in the symbol-keyed store so /reload teardown reaches them. */
export function getStoredInterval(key: symbol): IntervalHandle | null {
  return (globalStore[key] as IntervalHandle | null | undefined) ?? null;
}

export function clearStoredInterval(key: symbol): void {
  const handle = getStoredInterval(key);
  if (handle) {
    clearInterval(handle);
    globalStore[key] = null;
  }
}

type IntervalHandle = ReturnType<typeof setInterval>;

export interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  /** Copied Claude transcript filename under CLAUDE_SESSIONS_DIR. */
  claudeSessionId?: string;
  exitCode: number;
  elapsed: number;
  /** Provider/agent error after retries were exhausted. */
  errorMessage?: string;
}

export interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  startTime: number;
  sessionFile: string;
  launchScriptFile?: string;
  activityFile?: string;
  abortController?: AbortController;
  cli?: string;
  sentinelFile?: string;
  statusState: SubagentStatusState;
  /** Set when the launch fell back from the agent's model (no credentials). */
  modelWarning?: string;
  /** Pane never wakes the parent (no status/idle lifeline); only the user closes it. */
  interactive: boolean;
}

/**
 * Owns live runs and resume claims; all mutation goes through it. Module-level
 * on purpose: /reload re-executes the module and gets a fresh registry.
 */
class SubagentRegistry {
  readonly #runs = new Map<string, RunningSubagent>();
  readonly #resumeClaims = new Set<string>();

  /** Snapshot of live runs in insertion order. */
  all(): RunningSubagent[] {
    return [...this.#runs.values()];
  }

  get(id: string): RunningSubagent | undefined {
    return this.#runs.get(id);
  }

  register(running: RunningSubagent): void {
    this.#runs.set(running.id, running);
  }

  unregister(id: string): void {
    this.#runs.delete(id);
  }

  isEmpty(): boolean {
    return this.#runs.size === 0;
  }

  /** Drop all runs and claims; aborting runs is the caller's job. */
  clear(): void {
    this.#runs.clear();
    this.#resumeClaims.clear();
  }

  /** Take an exclusive resume claim; false when one already exists. */
  tryClaimResume(sessionPath: string): boolean {
    if (this.#resumeClaims.has(sessionPath)) return false;
    this.#resumeClaims.add(sessionPath);
    return true;
  }

  releaseResumeClaim(sessionPath: string): void {
    this.#resumeClaims.delete(sessionPath);
  }
}

/** Registry for this module load. */
export const registry = new SubagentRegistry();

/** Context from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;

export function setLatestContext(ctx: ExtensionContext | null): void {
  latestCtx = ctx;
}

export function getLatestContext(): ExtensionContext | null {
  return latestCtx;
}

export const statusConfig = loadStatusConfig();
