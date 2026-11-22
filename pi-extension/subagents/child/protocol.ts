/**
 * The turn-end contract a sub-agent session follows. Pure: child.ts wires these
 * to pi's events and performs the side effects.
 */

/** Structural view of the agent messages we inspect, so tests can pass literals. */
export interface AgentTurnMessage {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
}

export type AgentEndDecision =
  /** Turn ended normally: exit, and the last assistant message is the result. */
  | { action: "done" }
  /** Turn ended in a provider error: exit, but report the failure. */
  | { action: "error"; errorMessage: string }
  /** Keep the pane alive; `reason` names the rule that held it open. */
  | {
      action: "wait";
      reason: "interactive" | "awaiting-reply" | "queued-input" | "aborted";
    };

/** Message used when pi reports stopReason=error without an errorMessage field. */
const MISSING_ERROR_MESSAGE =
  "Subagent agent loop ended with stopReason=error (no errorMessage field).";

/** The message when the latest assistant turn failed, else null. */
export function findLatestAssistantError(
  messages: AgentTurnMessage[] | undefined,
): string | null {
  return errorText(lastAssistantMessage(messages));
}

/**
 * What the session does when a turn ends. Interactive panes and pending input
 * keep it alive; otherwise it exits, reporting a provider error when the final
 * turn had one. Input outranks that error: exiting would drop what the next
 * turn was about to process.
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

  if (state.awaitingReply) return { action: "wait", reason: "awaiting-reply" };

  if (state.unconsumedInput) {
    return { action: "wait", reason: "queued-input" };
  }

  const last = lastAssistantMessage(state.messages);
  const errorMessage = errorText(last);
  if (errorMessage) return { action: "error", errorMessage };

  // Escape aborts the turn, not the session: the user may send more input.
  if (last?.stopReason === "aborted") {
    return { action: "wait", reason: "aborted" };
  }

  return { action: "done" };
}

function lastAssistantMessage(
  messages: AgentTurnMessage[] | undefined,
): AgentTurnMessage | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return messages[i];
  }
  return undefined;
}

function errorText(message: AgentTurnMessage | undefined): string | null {
  if (message?.stopReason !== "error") return null;
  const raw =
    typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
  return raw || MISSING_ERROR_MESSAGE;
}
