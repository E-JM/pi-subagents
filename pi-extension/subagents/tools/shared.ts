import type { AgentToolResult } from "@mariozechner/pi-coding-agent";
import { muxSetupHint } from "../mux/backend.ts";

/** Every tool result here is one text block plus the details the renderer reads. */
export function textResult<T>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: "text", text }], details };
}

/** Uniform "no multiplexer" result, shared by all three tools. */
export function muxUnavailableResult() {
  return textResult(
    `Subagents require a supported terminal multiplexer. ${muxSetupHint()}`,
    { error: "mux not available" },
  );
}
