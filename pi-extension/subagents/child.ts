/**
 * Extension loaded into every Pi-backed sub-agent session.
 *
 * Lifecycle protocol ("turn-end = done"):
 * - When the agent's turn ends without a pending ask_question, the session
 *   exits automatically and the last assistant message is returned to the
 *   parent as the run result — no explicit done tool is needed.
 * - ask_question({ message }) surfaces a question to the parent session and
 *   keeps this session alive: the turn ends in "waiting for reply", and any
 *   input (the parent's reply arrives typed into the pane) releases the wait
 *   and re-enables auto-exit for the next turn end.
 * - Input that arrives while the agent is not running (queued mid-run, or a
 *   human typing in the pane) counts as unconsumed until a turn has
 *   processed it: the session stays alive through the reply turn, then the
 *   normal turn-end rule applies. Typing never takes the session over
 *   permanently.
 * - Interactive spawns (PI_SUBAGENT_INTERACTIVE=1) never auto-exit; the pane
 *   stays open for the user and the parent supervises idleness.
 *
 * Also renders the agent identity + tools widget (Ctrl+J) and records the
 * activity snapshot the parent's status supervision polls.
 */

import { writeFileSync } from "node:fs";
import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { createSubagentActivityRecorder } from "./activity.ts";

/**
 * Minimal shape of the agent messages this module inspects. Kept structural
 * (instead of importing AgentMessage) so the exported helpers stay easy to
 * call from tests with plain literals.
 */
export interface AgentTurnMessage {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by decideAgentEnd).
 */
export function findLatestAssistantError(
  messages: AgentTurnMessage[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw =
      typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage:
        raw ||
        "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

/** stopReason of the latest assistant message ("aborted" matters here). */
function lastAssistantStopReason(
  messages: AgentTurnMessage[] | undefined,
): string | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return messages[i].stopReason;
  }
  return undefined;
}

export type AgentEndDecision =
  | { action: "exit"; exitType: "done" }
  | { action: "exit"; exitType: "error"; errorMessage: string }
  | {
      action: "wait";
      reason: "interactive" | "awaiting-reply" | "queued-input" | "aborted";
    };

/**
 * Decide what a subagent session does when its agent turn ends. Pure so the
 * whole lifecycle protocol stays unit-testable:
 *
 * - interactive spawns always stay open (the pane is user-driven; the
 *   parent is never woken for it and only the user closes it);
 * - autonomous sessions exit on turn end — the last assistant message is the
 *   result — unless an ask_question is still awaiting its reply, input has
 *   arrived that no completed turn has processed yet (queued mid-run, or a
 *   human typing in the pane), or the turn was aborted (escape). Pending
 *   input and asks outrank a provider error: exiting on the error would
 *   silently drop what the next turn was going to process, so the pane
 *   stays alive instead and the error surfaces on a later exit.
 */
export function decideAgentEnd(state: {
  interactive: boolean;
  awaitingReply: boolean;
  unconsumedInput: boolean;
  messages: AgentTurnMessage[] | undefined;
}): AgentEndDecision {
  if (state.interactive) {
    return { action: "wait", reason: "interactive" };
  }

  // Pending input and asks outrank a provider error: exiting on the error
  // would silently drop the reply/input the next turn was going to process.
  // Wait instead — the error still surfaces on a later exit, or the parent
  // closes the pane.
  if (state.awaitingReply) return { action: "wait", reason: "awaiting-reply" };

  if (state.unconsumedInput) {
    return { action: "wait", reason: "queued-input" };
  }

  const errorInfo = findLatestAssistantError(state.messages);
  if (errorInfo) {
    return {
      action: "exit",
      exitType: "error",
      errorMessage: errorInfo.errorMessage,
    };
  }

  if (lastAssistantStopReason(state.messages) === "aborted") {
    return { action: "wait", reason: "aborted" };
  }

  return { action: "exit", exitType: "done" };
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const interactive = process.env.PI_SUBAGENT_INTERACTIVE === "1";
  const sessionFile = process.env.PI_SUBAGENT_SESSION;
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });

  // Lifecycle flags. awaitingReply is set by ask_question and released by any
  // input. Input that has not been processed by a completed turn counts as
  // unconsumed: it keeps the session alive until the reply turn ends —
  // whether it came from the parent or from a human typing in the pane.
  let awaitingReply = false;
  let inputCount = 0;
  let consumedInputCount = 0;
  // inputCount as of the current turn's start: the turn consumes what
  // existed when it began, so input arriving after the final assistant
  // message (but before turn_end) stays unconsumed and holds the pane for
  // its own turn instead of being silently dropped.
  let turnStartInputCount = 0;

  function writeExitSidecar(payload: unknown): void {
    if (!sessionFile) return;
    try {
      writeFileSync(`${sessionFile}.exit`, JSON.stringify(payload));
    } catch {
      // Best effort — even without the sidecar, the watcher's screen-sentinel
      // fallback still observes the process exit.
    }
  }

  function renderWidget(ctx: {
    ui: { setWidget: (key: string, content: unknown) => void };
  }) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui, theme: Theme) => {
        const box = new Box(1, 0, (text: string) =>
          theme.bg("toolSuccessBg", text),
        );

        const label = subagentAgent || subagentName;
        const agentTag = label
          ? theme.bold(theme.fg("accent", `[${label}]`))
          : "";

        if (expanded) {
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+J to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = `\n${theme.fg("muted", "denied: ")}${deniedList}`;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") +
                theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+J to expand)");

          const content = new Text(
            `${agentTag}${countInfo}${deniedInfo}${hint}`,
            0,
            0,
          );
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  pi.on("session_start", (_event, ctx) => {
    recorder.sessionStart();
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx);
  });

  pi.on("input", () => {
    recorder.input();
    // Any input releases a pending ask — the reply (or the user's message)
    // starts a fresh turn whose end re-evaluates auto-exit. The input stays
    // unconsumed until its turn completes.
    awaitingReply = false;
    inputCount += 1;
  });

  pi.on("before_agent_start", () => {
    recorder.beforeAgentStart();
  });

  pi.on("agent_start", () => {
    recorder.agentStart();
  });

  pi.on("agent_end", (event, ctx) => {
    // Without a session file there is no sidecar channel to the parent:
    // exiting would kill a plain (non-subagent) session mid-use. ask_question
    // already guards the same way.
    if (!sessionFile) {
      recorder.agentEndWaiting();
      return;
    }
    // AgentMessage satisfies the structural AgentTurnMessage view.
    const messages = event.messages as AgentTurnMessage[];
    const decision = decideAgentEnd({
      interactive,
      awaitingReply,
      unconsumedInput: inputCount > consumedInputCount,
      messages,
    });

    if (decision.action === "exit") {
      if (decision.exitType === "error") {
        // Surface stopReason: "error" turns (auto-retry exhausted, provider
        // overload, …) to the parent so it learns the run failed instead of
        // mistaking a stale assistant message for the result.
        writeExitSidecar({
          type: "error",
          errorMessage: decision.errorMessage,
          stopReason: "error",
        });
      } else {
        writeExitSidecar({ type: "done" });
      }
      recorder.agentEndDone();
      ctx.shutdown();
      return;
    }

    recorder.agentEndWaiting();
  });

  pi.on("turn_start", (event) => {
    turnStartInputCount = inputCount;
    recorder.turnStart(event.turnIndex);
  });

  pi.on("turn_end", (event) => {
    // The turn consumed the input that existed when it started; anything
    // that arrived later stays unconsumed for the next turn.
    consumedInputCount = turnStartInputCount;
    recorder.turnEnd(event.turnIndex);
  });

  pi.on("before_provider_request", () => {
    recorder.beforeProviderRequest();
  });

  pi.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  pi.on("message_update", (event) => {
    recorder.messageUpdate(event.assistantMessageEvent?.type);
  });

  pi.on("tool_execution_start", (event) => {
    recorder.toolExecutionStart(event.toolCallId, event.toolName);
  });

  pi.on("tool_call", (event) => {
    recorder.toolCall(event.toolCallId, event.toolName);
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate(event.toolCallId, event.toolName);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult(event.toolCallId, event.toolName);
  });

  pi.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd(event.toolCallId, event.toolName);
  });

  pi.on("session_shutdown", () => {
    // The session_shutdown event carries no reason; the recorder falls back
    // to stopping writes without marking the phase done.
    recorder.sessionShutdown();
  });

  pi.registerShortcut("ctrl+j", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx);
    },
  });

  pi.registerTool({
    name: "ask_question",
    label: "Ask Parent",
    description:
      "Ask the parent a question and wait for its reply. Use whenever you need " +
      "input, a decision, or information you cannot get yourself — then END YOUR TURN. " +
      "The reply arrives as your next user message, prefixed [parent]; the session stays " +
      "alive while you wait. Do NOT ask in plain text — the user may not be watching; " +
      "the parent always is.",
    parameters: Type.Object({
      message: Type.String({
        description:
          "The question for the parent — self-contained, with the context needed to answer it",
      }),
    }),
    async execute(_toolCallId, params) {
      if (!sessionFile) {
        throw new Error(
          "ask_question is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      // Write the sidecar before latching awaitingReply: if the write fails
      // (ENOSPC, dir removed), the tool error surfaces to the model and the
      // turn-end decision must not park the session waiting for a reply the
      // parent will never see.
      writeFileSync(
        `${sessionFile}.ask`,
        JSON.stringify({
          name: subagentName || "subagent",
          message: params.message,
        }),
      );
      awaitingReply = true;
      recorder.askQuestion();
      return {
        content: [
          {
            type: "text",
            text:
              "Question delivered to the parent. End your turn now — the reply " +
              "arrives as your next user message. Do not continue working in this turn.",
          },
        ],
        details: {},
      };
    },
  });
}
