import { join } from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import type { Result } from "../result.ts";

/**
 * The activity vocabulary. One list per dimension: the union type is derived
 * from it, so a new event/phase/scope cannot be spelled two different ways.
 */
export const ACTIVITY_PHASES = [
  "starting",
  "active",
  "waiting",
  "done",
] as const;

export const ACTIVITY_SCOPES = [
  "agent",
  "turn",
  "provider",
  "streaming",
  "tool",
] as const;

export const ACTIVITY_EVENTS = [
  "session_start",
  "input",
  "before_agent_start",
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "before_provider_request",
  "after_provider_response",
  "message_update",
  "tool_execution_start",
  "tool_call",
  "tool_execution_update",
  "tool_result",
  "tool_execution_end",
  "ask_question",
  "session_shutdown",
] as const;

export type SubagentActivityPhase = (typeof ACTIVITY_PHASES)[number];
export type SubagentActivityScope = (typeof ACTIVITY_SCOPES)[number];
export type SubagentActivityEvent = (typeof ACTIVITY_EVENTS)[number];

/** Longest free-text field accepted from a child-written snapshot. */
export const MAX_ACTIVITY_STRING_LENGTH = 200;

const activityText = Type.String({
  maxLength: MAX_ACTIVITY_STRING_LENGTH,
  pattern: "^[^\\r\\n]*$",
});

/** Wire format of the child-written snapshot; the state type derives from it. */
export const SubagentActivitySchema = Type.Object({
  version: Type.Literal(1),
  runningChildId: Type.String(),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  sequence: Type.Integer(),
  latestEvent: Type.Union(ACTIVITY_EVENTS.map((event) => Type.Literal(event))),
  phase: Type.Union(ACTIVITY_PHASES.map((phase) => Type.Literal(phase))),
  agentActive: Type.Boolean(),
  turnActive: Type.Boolean(),
  providerActive: Type.Boolean(),
  toolActive: Type.Boolean(),
  activeScope: Type.Optional(
    Type.Union(ACTIVITY_SCOPES.map((scope) => Type.Literal(scope))),
  ),
  activeSince: Type.Optional(Type.Number()),
  waitingSince: Type.Optional(Type.Number()),
  /**
   * Heartbeat period (ms) advertised by the child. A parent may call a frozen
   * active snapshot hung only when this is present; older children lack it.
   */
  heartbeatMs: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  turnIndex: Type.Optional(Type.Integer()),
  messageEventType: Type.Optional(activityText),
  toolCallId: Type.Optional(activityText),
  toolName: Type.Optional(activityText),
  toolStartedAt: Type.Optional(Type.Number()),
  toolEndedAt: Type.Optional(Type.Number()),
});

export type SubagentActivityState = Static<typeof SubagentActivitySchema>;

/** Why a child-written snapshot could not be used. */
export type ActivityReadError =
  | { kind: "missing" | "wrong-id" }
  | { kind: "invalid"; message: string };

export type ActivityReadResult = Result<
  SubagentActivityState,
  ActivityReadError
>;

export function getSubagentActivityFile(
  artifactDir: string,
  runningChildId: string,
): string {
  return join(artifactDir, "subagent-activity", `${runningChildId}.json`);
}
