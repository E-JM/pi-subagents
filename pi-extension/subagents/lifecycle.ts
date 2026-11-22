// Run lifecycle: the watch pipeline, the 1s supervision loop, and the close
// path. Result/ask delivery lives in delivery.ts.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readSubagentActivityFile } from "./activity/read.ts";
import type {
  ActivityReadResult,
  SubagentActivityState,
} from "./activity/schema.ts";
import {
  deliverAsk,
  deliverWatchError,
  deliverWatchResult,
  exitSummaryFallback,
} from "./delivery.ts";
import { type AskPayload, type PollResult, pollForExit } from "./exit-poll.ts";
import { elapsedSeconds, errorMessage } from "./format.ts";
import { closeSurface, readScreen } from "./mux/api.ts";
import { err } from "./result.ts";
import { findLastAssistantMessage, getNewEntries } from "./session.ts";
import {
  clearStoredInterval,
  getModuleAbortSignal,
  getStoredInterval,
  globalStore,
  type RunningSubagent,
  registry,
  STATUS_INTERVAL_KEY,
  type SubagentResult,
  statusConfig,
} from "./state.ts";
import {
  capStatusLines,
  formatStatusAggregate,
  formatTransitionLine,
} from "./status/format.ts";
import { advanceStatusState, observeStatus } from "./status/snapshot.ts";
import { startWidgetRefresh, updateWidget } from "./ui/widget.ts";

function activityLabel(activity: SubagentActivityState): string | undefined {
  if (activity.phase !== "active") return undefined;
  if (activity.activeScope === "tool") return activity.toolName ?? "tool";
  if (activity.activeScope === "provider") return "provider";
  if (activity.activeScope === "streaming") return "streaming";
  return activity.activeScope;
}

function observeRunningSubagent(
  running: RunningSubagent,
  observedAt = Date.now(),
) {
  if (running.cli === "claude") return;

  const activityFile = running.activityFile;
  const read: ActivityReadResult = activityFile
    ? readSubagentActivityFile(activityFile, running.id)
    : err({ kind: "missing" });

  if (read.ok) {
    const activity = read.value;
    running.statusState = observeStatus(
      running.statusState,
      {
        snapshot: "present",
        updatedAt: activity.updatedAt,
        sequence: activity.sequence,
        phase: activity.phase,
        active: activity.phase === "active",
        activeScope: activity.activeScope,
        activeSince: activity.activeSince,
        waitingSince: activity.waitingSince,
        latestEvent: activity.latestEvent,
        activityLabel: activityLabel(activity),
        heartbeatMs: activity.heartbeatMs,
      },
      observedAt,
    );
    return;
  }

  const problem = read.error;
  running.statusState = observeStatus(
    running.statusState,
    {
      snapshot: problem.kind,
      snapshotError: problem.kind === "invalid" ? problem.message : undefined,
    },
    observedAt,
  );
}

/**
 * Close a run's pane and finish its session: the sidecar makes pollForExit
 * finish on its next tick, so the output so far becomes the result.
 */
export function closeRunningSubagent(
  running: RunningSubagent,
  reason: string,
): void {
  if (running.cli === "claude") {
    if (running.sentinelFile) {
      try {
        // Private mode matches the hook's umask; exclusive create refuses a
        // file or symlink planted at the /tmp-shared path.
        writeFileSync(running.sentinelFile, "", { mode: 0o600, flag: "wx" });
      } catch {
        // Already written by the hook, or planted: the screen sentinel still
        // lets pollForExit finish.
      }
    }
  } else {
    try {
      writeFileSync(
        `${running.sessionFile}.exit`,
        JSON.stringify({ type: "done", reason }),
      );
    } catch {
      // Best effort — the screen sentinel may still fire in pollForExit.
    }
  }

  // Pane may already be gone; pollForExit still observes the sidecar.
  closeSurface(running.surface);
}

/**
 * 1s supervision loop: widget refresh plus stalled/recovered steering. There is
 * no idle lifeline, so an interactive pane never wakes the parent.
 */
function startSupervisionLoop(pi: ExtensionAPI) {
  if (getStoredInterval(STATUS_INTERVAL_KEY)) return;

  globalStore[STATUS_INTERVAL_KEY] = setInterval(() => {
    if (registry.isEmpty()) {
      clearStoredInterval(STATUS_INTERVAL_KEY);
      return;
    }

    const transitionLines: string[] = [];
    const now = Date.now();
    let shouldRefreshWidget = false;

    for (const running of registry.all()) {
      observeRunningSubagent(running, now);
      const { nextState, snapshot, transition } = advanceStatusState(
        running.statusState,
        now,
      );
      if (nextState.currentKind !== running.statusState.currentKind) {
        shouldRefreshWidget = true;
      }
      running.statusState = nextState;

      // Interactive panes never wake the parent; only the user closes them.
      if (transition && !running.interactive && statusConfig.enabled) {
        transitionLines.push(
          formatTransitionLine(running.name, snapshot, transition),
        );
      }
    }

    if (shouldRefreshWidget && statusConfig.enabled) updateWidget();

    if (transitionLines.length > 0) {
      const capped = capStatusLines(transitionLines, statusConfig.lineLimit);
      pi.sendMessage(
        {
          customType: "subagent_status",
          content: formatStatusAggregate(
            transitionLines,
            statusConfig.lineLimit,
          ),
          display: true,
          details: { lines: capped.visibleLines, overflow: capped.overflow },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  }, 1000);
}

/** Register a run and start its watcher, abort controller, and loops. */
export function startWatchPipeline(
  pi: ExtensionAPI,
  running: RunningSubagent,
  onResult?: (result: SubagentResult) => void,
): void {
  // The watcher needs its own controller: the calling tool's signal is done as
  // soon as the tool returns.
  const watcherAbort = new AbortController();
  running.abortController = watcherAbort;
  startWidgetRefresh();
  startSupervisionLoop(pi);
  watchSubagent(running, watcherAbort.signal, (ask) =>
    deliverAsk(pi, running, ask),
  )
    .then((result) =>
      onResult ? onResult(result) : deliverWatchResult(pi, running, result),
    )
    .catch((err) => deliverWatchError(pi, running, err));
}

/** Local copy of Claude Code transcripts, exposed as `claudeSessionId` in results. */
const CLAUDE_SESSIONS_DIR = join(
  process.env.HOME ?? "/tmp",
  ".pi",
  "agent",
  "sessions",
  "claude-code",
);

function copyClaudeSession(sentinelFile: string): string | null {
  try {
    // The stop hook records the transcript path in a `.transcript` sidecar.
    const transcriptFile = `${sentinelFile}.transcript`;
    if (!existsSync(transcriptFile)) return null;
    const transcriptPath = readFileSync(transcriptFile, "utf-8").trim();
    if (!transcriptPath || !existsSync(transcriptPath)) return null;
    mkdirSync(CLAUDE_SESSIONS_DIR, { recursive: true });
    const filename =
      transcriptPath.split("/").pop() ?? `claude-${Date.now()}.jsonl`;
    const dest = join(CLAUDE_SESSIONS_DIR, filename);
    copyFileSync(transcriptPath, dest);
    return filename;
  } catch {
    return null;
  }
}

/** Watch a run until it exits, then close it and hand back the result. */
export async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
  onAsk?: (ask: AskPayload) => void,
): Promise<SubagentResult> {
  const { name, task, sessionFile, startTime } = running;

  try {
    const result = await pollForExit(
      running.surface,
      AbortSignal.any([signal, getModuleAbortSignal()]),
      {
        interval: 1000,
        sessionFile,
        sentinelFile: running.sentinelFile,
        onAsk,
        onTick() {
          observeRunningSubagent(running);
        },
      },
    );

    const elapsed = elapsedSeconds(startTime);
    return running.cli === "claude"
      ? finishClaudeRun(running, result, elapsed)
      : finishPiRun(running, result, elapsed);
  } catch (error) {
    finishRun(running);
    const elapsed = elapsedSeconds(startTime);
    if (signal.aborted) {
      return {
        name,
        task,
        summary: "Subagent cancelled.",
        exitCode: 1,
        elapsed,
        sessionFile,
      };
    }
    return {
      name,
      task,
      summary: `Subagent error: ${errorMessage(error)}`,
      exitCode: 1,
      elapsed,
    };
  }
}

/** Claude Code leaves its output in the sentinel file, or on screen. */
function finishClaudeRun(
  running: RunningSubagent,
  result: PollResult,
  elapsed: number,
): SubagentResult {
  const summary =
    readSentinelSummary(running) ||
    readScreenSummary(running.surface) ||
    placeholderSummary(result);
  const sessionId = running.sentinelFile
    ? takeClaudeSession(running.sentinelFile)
    : null;

  finishRun(running);
  return {
    name: running.name,
    task: running.task,
    summary,
    exitCode: result.exitCode,
    elapsed,
    ...(sessionId ? { claudeSessionId: sessionId } : {}),
  };
}

/** A Pi child writes its session file; the last assistant message is the result. */
function finishPiRun(
  running: RunningSubagent,
  result: PollResult,
  elapsed: number,
): SubagentResult {
  const entries = existsSync(running.sessionFile)
    ? getNewEntries(running.sessionFile, 0)
    : [];
  const summary =
    findLastAssistantMessage(entries) ?? exitSummaryFallback(result);

  finishRun(running);
  return {
    name: running.name,
    task: running.task,
    summary,
    sessionFile: running.sessionFile,
    exitCode: result.exitCode,
    elapsed,
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
  };
}

/** Close the pane, drop any unconsumed ask sidecar, and forget the run. */
function finishRun(running: RunningSubagent): void {
  closeSurface(running.surface);
  try {
    // An .ask written in the same tick as the exit must not leak into a resume.
    unlinkSync(`${running.sessionFile}.ask`);
  } catch {
    // No pending ask.
  }
  registry.unregister(running.id);
}

function readSentinelSummary(running: RunningSubagent): string {
  if (!running.sentinelFile) return "";
  try {
    return readFileSync(running.sentinelFile, "utf-8").trim();
  } catch {
    // Fall through to the screen read.
    return "";
  }
}

function readScreenSummary(surface: string): string {
  try {
    return readScreen(surface, 200)
      .replace(/__SUBAGENT_DONE_\d+__/, "")
      .trimEnd();
  } catch {
    // Pane may already be gone.
    return "";
  }
}

function placeholderSummary(result: PollResult): string {
  return result.exitCode !== 0
    ? `Claude Code exited with code ${result.exitCode}`
    : "Claude Code exited without output";
}

/** Copy the transcript into the local claude-code dir and consume the sidecars. */
function takeClaudeSession(sentinelFile: string): string | null {
  const sessionId = copyClaudeSession(sentinelFile);
  try {
    unlinkSync(sentinelFile);
  } catch {
    // Already consumed.
  }
  try {
    unlinkSync(`${sentinelFile}.transcript`);
  } catch {
    // Already consumed.
  }
  return sessionId;
}
