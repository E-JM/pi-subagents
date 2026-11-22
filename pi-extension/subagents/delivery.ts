// Steers finished results, watcher failures, and child questions to the parent.
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AskPayload } from "./exit-poll.ts";
import { errorMessage, formatElapsed } from "./format.ts";
import { neutralizeSentinel } from "./sanitize.ts";
import type { RunningSubagent, SubagentResult } from "./state.ts";
import {
  resultLabelCompleted,
  resultLabelFailedExit,
  resultLabelProviderError,
} from "./ui/renderers.ts";
import { updateWidget } from "./ui/widget.ts";

/** Result text for the parent: summary plus session-ref trailer. */
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

/** Steer a finished watcher result; `summary` overrides the watcher's on resume. */
export function deliverWatchResult(
  pi: ExtensionAPI,
  running: RunningSubagent,
  result: SubagentResult,
  opts: { summary?: string } = {},
): void {
  updateWidget();

  // Child-controlled text renders here: neutralize so a nested child can't fake completion.
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

/** Steer ask_question to the parent; the child stays alive awaiting the reply. */
export function deliverAsk(
  pi: ExtensionAPI,
  running: RunningSubagent,
  ask: AskPayload,
): void {
  updateWidget();
  const sessionFile = running.sessionFile;
  const sessionRef = sessionFile ? `\n\nSession: ${sessionFile}` : "";
  // Child-controlled text renders here; same sentinel treatment as results.
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
