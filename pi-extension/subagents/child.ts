/**
 * Extension loaded into every Pi-backed sub-agent session: wires the turn-end
 * contract in child/protocol.ts to pi's events, renders the agent widget
 * (Ctrl+J), records the activity snapshot, and provides ask_question.
 */

import { writeFileSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { createSubagentActivityRecorder } from "./activity/recorder.ts";
import { type AgentTurnMessage, decideAgentEnd } from "./child/protocol.ts";

function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const interactive = process.env.PI_SUBAGENT_INTERACTIVE === "1";
  const sessionFile = process.env.PI_SUBAGENT_SESSION;
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });

  // ask_question sets awaitingReply; any input clears it. Input that no
  // completed turn has processed keeps the pane open until its own turn ends.
  let awaitingReply = false;
  let inputCount = 0;
  let consumedInputCount = 0;
  // The turn consumes the input that existed when it started, so input arriving
  // after the final assistant message still holds the pane for its own turn.
  let turnStartInputCount = 0;

  function writeExitSidecar(payload: unknown): void {
    if (!sessionFile) return;
    try {
      writeFileSync(`${sessionFile}.exit`, JSON.stringify(payload));
    } catch {
      // Best effort: the screen-sentinel fallback still sees the process exit.
    }
  }

  function renderWidget(ctx: ExtensionContext) {
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
    // No session file means no sidecar channel: exiting would kill a plain
    // session mid-use. ask_question guards the same way.
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

    if (decision.action === "wait") {
      recorder.agentEndWaiting();
      return;
    }

    // A failed turn still exits, but the parent must learn it failed rather
    // than mistake the stale assistant message for the result.
    writeExitSidecar(
      decision.action === "error"
        ? {
            type: "error",
            errorMessage: decision.errorMessage,
            stopReason: "error",
          }
        : { type: "done" },
    );
    recorder.agentEndDone();
    ctx.shutdown();
  });

  pi.on("turn_start", (event) => {
    turnStartInputCount = inputCount;
    recorder.turnStart(event.turnIndex);
  });

  pi.on("turn_end", (event) => {
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
    // The event carries no reason, so the recorder stops without marking the
    // phase done.
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

      // Write first: if this throws, the tool error reaches the model instead of
      // parking the session on a question the parent never sees.
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
