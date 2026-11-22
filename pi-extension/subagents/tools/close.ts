import type {
  AgentToolResult,
  ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { closeRunningSubagent } from "../lifecycle.ts";
import { formatRunningSubagents, resolveRunningTarget } from "../targeting.ts";
import {
  detailsOf,
  renderResultFallback,
  renderTargetCall,
  targetCallText,
} from "../ui/renderers.ts";
import { textResult } from "./shared.ts";

const SUBAGENT_CLOSE_DESCRIPTION =
  "Close a running subagent's pane and finish its session. Use for cleanup " +
  "when a subagent is stalled or no longer needed — any output produced so " +
  "far still arrives as an automatic steer message. Interactive subagents " +
  "are user-driven panes: close one only when the user explicitly asks, " +
  "never on your own initiative.";

interface SubagentCloseDetails {
  status?: "closing";
  id?: string;
  name?: string;
  error?: string;
}

export function registerSubagentCloseTool(
  pi: ExtensionAPI,
  shouldRegister: (name: string) => boolean,
): void {
  if (shouldRegister("subagent_close"))
    pi.registerTool({
      name: "subagent_close",
      label: "Close Subagent",
      description: SUBAGENT_CLOSE_DESCRIPTION,
      promptSnippet: SUBAGENT_CLOSE_DESCRIPTION,
      parameters: Type.Object({
        id: Type.Optional(
          Type.String({ description: "Exact running subagent id" }),
        ),
        name: Type.Optional(
          Type.String({ description: "Exact running subagent display name" }),
        ),
      }),

      async execute(
        _toolCallId,
        params,
      ): Promise<AgentToolResult<SubagentCloseDetails>> {
        const resolved = resolveRunningTarget(params);
        if (!resolved.ok) {
          const text = `${resolved.error}\n\n${formatRunningSubagents()}`;
          return textResult(text, { error: resolved.error });
        }

        const { running, matchedBy } = resolved.value;
        closeRunningSubagent(running, "closed-by-parent");

        return textResult(
          `Closing subagent "${running.name}".` +
            (matchedBy === "name" && params.id?.trim()
              ? ` Note: id "${params.id.trim()}" matched no live subagent — resolved by name instead.`
              : ""),
          {
            status: "closing" as const,
            id: running.id,
            name: running.name,
          },
        );
      },

      renderCall(args, theme) {
        return renderTargetCall(args, theme, "close");
      },

      renderResult(result, _opts, theme) {
        const details = detailsOf(result.details);
        if (details.status === "closing") {
          return targetCallText(
            details.name ?? details.id ?? "subagent",
            theme,
            "closing",
          );
        }

        return renderResultFallback(result, theme);
      },
    });
}
