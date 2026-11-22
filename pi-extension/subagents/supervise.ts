// Watching, supervision loop, result delivery, and closing for running
// subagents.
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
import {
  type ActivityReadResult,
  readSubagentActivityFile,
  type SubagentActivityState,
} from "./activity.ts";
import { closeSurface, readScreen } from "./cmux.ts";
import { pollForExit, type AskPayload } from "./exit-poll.ts";
import { findLastAssistantMessage, getNewEntries } from "./session.ts";
import {
  clearStoredInterval,
  getModuleAbortSignal,
  getStoredInterval,
  globalStore,
  runningSubagents,
  STATUS_INTERVAL_KEY,
  statusConfig,
  type RunningSubagent,
  type SubagentResult,
} from "./state.ts";
import {
  advanceStatusState,
  capStatusLines,
  formatStatusAggregate,
  formatTransitionLine,
  observeStatus,
} from "./status.ts";
import {
  resultLabelCompleted,
  resultLabelFailedExit,
  resultLabelProviderError,
  startWidgetRefresh,
  updateWidget,
} from "./ui.ts";
import { elapsedSeconds, errorMessage, formatElapsed } from "./util.ts";

export function resolveResultPresentation(
  result: Pick<
    SubagentResult,
    "exitCode" | "elapsed" | "summary" | "sessionFile" | "errorMessage"
  >,
  name: string,
): string {
  const sessionRef = result.sessionFile
    ? `\n\nSession: ${result.sessionFile}\nResume with subagent_message if a follow-up is needed.`
    : "";

  if (result.errorMessage) {
    // Auto-retry exhausted: surface the provider/network failure instead of
    // silently treating the run as completed.
    return (
      `${resultLabelProviderError(name, formatElapsed(result.elapsed))}\n\n` +
      `Error: ${result.errorMessage}\n\n` +
      `The subagent did not produce a result. You can retry by spawning a new ` +
      `subagent or resume the session with subagent_message.${sessionRef}`
    );
  }

  return result.exitCode !== 0
    ? `${resultLabelFailedExit(name, result.exitCode)}\n\n${result.summary}${sessionRef}`
    : `${resultLabelCompleted(name, formatElapsed(result.elapsed))}\n\n${result.summary}${sessionRef}`;
}

/**
 * Steer a finished watcher result to the parent. Shared by the launch and
 * resume paths: rendered by resolveResultPresentation.
 *
 * `summary` overrides the watcher's summary — the resume path re-extracts it
 * from entries added since the resume, because the watcher only saw the
 * pre-existing session content.
 */
export function deliverWatchResult(
  pi: ExtensionAPI,
  running: RunningSubagent,
  result: SubagentResult,
  opts: { summary?: string } = {},
): void {
  updateWidget();

  // The summary is child-controlled text that renders on this session's
  // screen — neutralize the sentinel so a nested child's final message
  // cannot fake this pane's completion in a grandparent's exit poller.
  const summary = neutralizeSentinel(opts.summary ?? result.summary);
  const errorMessage = result.errorMessage
    ? neutralizeSentinel(result.errorMessage)
    : undefined;

  const presentation = resolveResultPresentation(
    {
      ...result,
      summary,
      errorMessage,
      sessionFile: result.sessionFile ?? running.sessionFile,
    },
    running.name,
  );

  pi.sendMessage(
    {
      customType: "subagent_result",
      content: presentation,
      display: true,
      details: {
        name: running.name,
        task: running.task,
        agent: running.agent,
        exitCode: result.exitCode,
        elapsed: result.elapsed,
        sessionFile: result.sessionFile ?? running.sessionFile,
        ...(errorMessage ? { errorMessage } : {}),
        ...(result.claudeSessionId
          ? { claudeSessionId: result.claudeSessionId }
          : {}),
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

/** Steer a watcher failure (thrown by watchSubagent) to the parent. */
export function deliverWatchError(
  pi: ExtensionAPI,
  running: RunningSubagent,
  err: unknown,
): void {
  updateWidget();
  pi.sendMessage(
    {
      customType: "subagent_result",
      content: `Sub-agent "${running.name}" error: ${errorMessage(err)}`,
      display: true,
      details: {
        name: running.name,
        task: running.task,
        errorMessage: errorMessage(err),
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

/**
 * Steer a subagent's ask_question to the parent. Non-terminating: the child
 * stays alive awaiting the reply, which arrives via subagent_message.
 */
export function deliverAsk(
  pi: ExtensionAPI,
  running: RunningSubagent,
  ask: AskPayload,
): void {
  updateWidget();
  const sessionFile = running.sessionFile;
  const sessionRef = sessionFile ? `\n\nSession: ${sessionFile}` : "";
  // The ask payload is child-controlled and renders on this pane — same
  // sentinel neutralization as delivered results.
  const name = neutralizeSentinel(ask.name);
  const message = neutralizeSentinel(ask.message);
  pi.sendMessage(
    {
      customType: "subagent_ask",
      content:
        `Sub-agent "${name}" has a question:\n\n${message}${sessionRef}\n` +
        `Reply live with subagent_message (name: "${running.name}").`,
      display: true,
      details: {
        name,
        message,
        agent: running.agent,
        sessionFile,
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

function activityLabel(activity: SubagentActivityState): string | undefined {
  if (activity.phase !== "active") return undefined;
  if (activity.activeScope === "tool") return activity.toolName ?? "tool";
  if (activity.activeScope === "provider") return "provider";
  if (activity.activeScope === "streaming") return "streaming";
  return activity.activeScope;
}

export function observeRunningSubagent(
  running: RunningSubagent,
  observedAt = Date.now(),
) {
  if (running.cli === "claude") return;

  const activityFile = running.activityFile;
  const read: ActivityReadResult = activityFile
    ? readSubagentActivityFile(activityFile, running.id)
    : { ok: false, reason: "missing" };

  if (read.ok) {
    running.statusState = observeStatus(
      running.statusState,
      {
        snapshot: "present",
        updatedAt: read.activity.updatedAt,
        sequence: read.activity.sequence,
        phase: read.activity.phase,
        active: read.activity.phase === "active",
        activeScope: read.activity.activeScope,
        activeSince: read.activity.activeSince,
        waitingSince: read.activity.waitingSince,
        latestEvent: read.activity.latestEvent,
        activityLabel: activityLabel(read.activity),
        heartbeatMs: read.activity.heartbeatMs,
      },
      observedAt,
    );
    return;
  }

  running.statusState = observeStatus(
    running.statusState,
    {
      snapshot: read.reason,
      snapshotError: read.error,
    },
    observedAt,
  );
}

/**
 * Break the screen-sentinel literal so delivered text can never match the
 * exit poller's completion pattern (a pasted `__SUBAGENT_DONE_0__` would
 * otherwise kill the pane as a fake completion).
 */
export function neutralizeSentinel(text: string): string {
  return text.replace(/__SUBAGENT_DONE_/g, "__SUBAGENT-DONE_");
}

/**
 * Sanitize a message for typing into a live subagent pane: collapse all
 * whitespace runs containing newlines into single spaces (pane send is
 * line-oriented), trim, and hard-cap at 4000 chars.
 */
export function sanitizeInjectedMessage(message: string): string {
  const collapsed = neutralizeSentinel(
    message.replace(/\s*\n\s*/g, " ").trim(),
  );
  const MAX_INJECTED_MESSAGE_LENGTH = 4000;
  if (collapsed.length <= MAX_INJECTED_MESSAGE_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_INJECTED_MESSAGE_LENGTH)}…[truncated]`;
}

/**
 * Sanitize a message delivered via the artifact/@file channel (resume): the
 * file tolerates newlines, so only trim, cap length, and neutralize the
 * sentinel (file contents render on the child's screen too).
 */
export function sanitizeArtifactMessage(message: string): string {
  const trimmed = message.trim();
  const MAX_ARTIFACT_MESSAGE_LENGTH = 20_000;
  const capped =
    trimmed.length <= MAX_ARTIFACT_MESSAGE_LENGTH
      ? trimmed
      : `${trimmed.slice(0, MAX_ARTIFACT_MESSAGE_LENGTH)}…[truncated]`;
  return neutralizeSentinel(capped);
}

/**
 * Close a running subagent's pane and finish its session.
 *
 * Writes the `.exit` sidecar (with the close reason) so pollForExit finishes
 * normally on its next tick and the run's output so far is delivered as the
 * result, then closes the pane.
 */
export function closeRunningSubagent(
  running: RunningSubagent,
  reason: string,
): void {
  if (running.cli === "claude") {
    if (running.sentinelFile) {
      try {
        // Private mode matches the hook's umask; exclusive create refuses a
        // pre-existing file (or symlink) planted at the /tmp-shared path.
        writeFileSync(running.sentinelFile, "", { mode: 0o600, flag: "wx" });
      } catch {
        // Already created by the hook (normal completion) or planted —
        // best effort, the screen sentinel may still fire in pollForExit.
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
  closeSurfaceSafe(running.surface);
}

/**
 * 1s supervision loop for all running subagents: status-widget refresh and
 * stalled/recovered steering when the widget is enabled. There is no idle
 * lifeline: the parent is only woken by results, child ask_questions, and
 * stalled/recovered transitions on autonomous runs. Interactive panes never
 * wake the parent — only the user closes them.
 */
export function startSupervisionLoop(pi: ExtensionAPI) {
  if (getStoredInterval(STATUS_INTERVAL_KEY)) return;

  globalStore[STATUS_INTERVAL_KEY] = setInterval(() => {
    if (runningSubagents.size === 0) {
      clearStoredInterval(STATUS_INTERVAL_KEY);
      return;
    }

    const transitionLines: string[] = [];
    const now = Date.now();
    let shouldRefreshWidget = false;

    for (const running of runningSubagents.values()) {
      observeRunningSubagent(running, now);
      const { nextState, snapshot, transition } = advanceStatusState(
        running.statusState,
        now,
      );
      if (nextState.currentKind !== running.statusState.currentKind) {
        shouldRefreshWidget = true;
      }
      running.statusState = nextState;

      // Interactive subagents never wake the parent — not on transitions,
      // not on idleness. The user drives the pane; only the user closes it.
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

/**
 * Register a fresh run and pair it with its background watcher: starts the
 * widget + supervision loops, attaches a dedicated abort controller, and
 * fire-and-forgets the watch pipeline that steers results and asks back.
 */
export function startWatchPipeline(
  pi: ExtensionAPI,
  running: RunningSubagent,
  onResult?: (result: SubagentResult) => void,
): void {
  // Separate AbortController for the watcher — the calling tool's own signal
  // completes as soon as the tool returns.
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

/** Exit summary when no assistant message carried the result. */
export function exitSummaryFallback(
  result: Pick<SubagentResult, "exitCode" | "errorMessage">,
  subject = "Sub-agent",
  withoutSuffix = "output",
): string {
  if (result.errorMessage) {
    return `Subagent error: ${result.errorMessage}`;
  }
  if (result.exitCode !== 0) {
    return `${subject} exited with code ${result.exitCode}`;
  }
  return `${subject} exited without ${withoutSuffix}`;
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
    // The sentinel writer (plugin/hooks/on-stop.sh) always records the
    // Claude Code transcript path in a `.transcript` sidecar so the watcher
    // can copy the session file into CLAUDE_SESSIONS_DIR.
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

/**
 * Close a pane, tolerating surfaces that are already gone (e.g. closed via
 * subagent_close moments before the watcher finished).
 */
function closeSurfaceSafe(surface: string): void {
  try {
    closeSurface(surface);
  } catch {
    // Pane already closed.
  }
}

/**
 * Watch a launched subagent until it exits. Polls for completion, steers
 * ask_question payloads back via onAsk as they appear, extracts the summary
 * from the session file, cleans up the surface, and removes the entry from
 * runningSubagents.
 */
export async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
  onAsk?: (ask: AskPayload) => void,
): Promise<SubagentResult> {
  const { name, task, surface, startTime, sessionFile } = running;

  try {
    const result = await pollForExit(
      surface,
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

    if (running.cli === "claude") {
      let summary = "";

      if (running.sentinelFile) {
        try {
          summary = readFileSync(running.sentinelFile, "utf-8").trim();
        } catch {}
      }

      if (!summary) {
        // Pane may already be gone (closed via subagent_close) — fall through
        // to the placeholder summary instead of failing the result.
        try {
          summary = readScreen(surface, 200)
            .replace(/__SUBAGENT_DONE_\d+__/, "")
            .trimEnd();
        } catch {}
      }

      if (!summary) {
        summary =
          result.exitCode !== 0
            ? `Claude Code exited with code ${result.exitCode}`
            : "Claude Code exited without output";
      }

      let sessionId: string | null = null;
      if (running.sentinelFile) {
        sessionId = copyClaudeSession(running.sentinelFile);
        try {
          unlinkSync(running.sentinelFile);
        } catch {}
        try {
          unlinkSync(`${running.sentinelFile}.transcript`);
        } catch {}
      }

      closeSurfaceSafe(surface);
      runningSubagents.delete(running.id);

      return {
        name,
        task,
        summary,
        exitCode: result.exitCode,
        elapsed,
        ...(sessionId ? { claudeSessionId: sessionId } : {}),
      };
    }

    const allEntries = existsSync(sessionFile)
      ? getNewEntries(sessionFile, 0)
      : [];
    const summary =
      findLastAssistantMessage(allEntries) ?? exitSummaryFallback(result);

    // Best-effort cleanup of a possibly-unconsumed `.ask` sidecar (a fresh
    // ask written in the same poll tick as the exit must not leak into a
    // later resume).
    try {
      unlinkSync(`${sessionFile}.ask`);
    } catch {}

    closeSurfaceSafe(surface);
    runningSubagents.delete(running.id);

    return {
      name,
      task,
      summary,
      sessionFile,
      exitCode: result.exitCode,
      elapsed,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    };
  } catch (err) {
    const message = errorMessage(err);
    try {
      closeSurface(surface);
    } catch {}
    // Same sidecar hygiene as the success path: a fresh .ask written in the
    // dying tick must not leak into a later resume as a ghost question.
    try {
      unlinkSync(`${sessionFile}.ask`);
    } catch {}
    runningSubagents.delete(running.id);

    if (signal.aborted) {
      return {
        name,
        task,
        summary: "Subagent cancelled.",
        exitCode: 1,
        elapsed: elapsedSeconds(startTime),
        sessionFile,
      };
    }
    return {
      name,
      task,
      summary: `Subagent error: ${message}`,
      exitCode: 1,
      elapsed: elapsedSeconds(startTime),
    };
  }
}
