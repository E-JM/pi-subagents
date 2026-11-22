// Shared runtime state: /reload-surviving symbol-keyed store, interval
// handles, the running-subagent registry, and shared status config.
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadStatusConfig, type SubagentStatusState } from "./status.ts";

// Survive /reload: closures from the previous module load keep running, so
// clear its timers and abort its poll loops (otherwise /reload leaves
// duplicate intervals and pollers behind).
export const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
export const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
export const POLL_ABORT_KEY = Symbol.for("pi-subagents/poll-abort-controller");

/** Symbol-keyed store for state that must survive /reload. */
export const globalStore = globalThis as Record<symbol, unknown>;

{
  clearStoredInterval(WIDGET_INTERVAL_KEY);
  clearStoredInterval(STATUS_INTERVAL_KEY);
  const prevAbort = globalStore[POLL_ABORT_KEY] as AbortController | undefined;
  if (prevAbort) prevAbort.abort();
  globalStore[POLL_ABORT_KEY] = new AbortController();
}

export function getModuleAbortSignal(): AbortSignal {
  return (globalStore[POLL_ABORT_KEY] as AbortController).signal;
}

/**
 * The symbol-keyed globalStore slots are the single home for the interval
 * handles: closures from an older module load still see the same slots, so
 * /reload teardown and runtime teardown both act on the same timer.
 */
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

export type IntervalHandle = ReturnType<typeof setInterval>;

/**
 * Result from running a single subagent.
 */
export interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  /** Filename (not a bare session id) of the copied Claude transcript under CLAUDE_SESSIONS_DIR. */
  claudeSessionId?: string;
  exitCode: number;
  elapsed: number;
  /** Provider/agent error message when auto-retry exhausted (overload, rate limit, etc.). */
  errorMessage?: string;
}

/**
 * State for a launched (but not yet completed) subagent.
 */
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
  /**
   * When true, the pane never wakes the parent session — not on status
   * transitions, not on idleness (there is no idle lifeline). The user
   * drives the conversation in the subagent's pane (e.g. planner), and only
   * the user closes it (directly, or by asking the parent for subagent_close).
   */
  interactive: boolean;
}

/** All currently running subagents, keyed by id. */
export const runningSubagents = new Map<string, RunningSubagent>();

/**
 * Session files claimed by an in-flight resume (claimed synchronously
 * before the async launch, released once the run registers or the resume
 * fails): closes the check-then-act window parallel subagent_message calls
 * would otherwise race through.
 */
export const claimedResumeSessions = new Set<string>();

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;

export function setLatestContext(ctx: ExtensionContext | null): void {
  latestCtx = ctx;
}

export function getLatestContext(): ExtensionContext | null {
  return latestCtx;
}

export const statusConfig = loadStatusConfig();
