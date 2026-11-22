import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { loadAgentDefaults } from "../agents.ts";
import {
  currentSubagentDepth,
  MAX_SUBAGENT_DEPTH,
} from "../launch/policies.ts";
import { SubagentSpawnParams } from "../launch/schema.ts";
import { launchSubagent } from "../launch/spawn.ts";
import { startWatchPipeline } from "../lifecycle.ts";
import { isMuxAvailable } from "../mux/backend.ts";
import { formatAvailableAgents } from "../targeting.ts";
import {
  detailsOf,
  renderResultFallback,
  targetCallText,
} from "../ui/renderers.ts";
import { muxUnavailableResult, textResult } from "./shared.ts";

const SUBAGENT_SPAWN_DESCRIPTION =
  "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
  "Fire-and-forget: returns immediately with only an acknowledgement; the result " +
  "arrives later as an automatic steer message that starts a new turn. " +
  "Never poll, sleep/wait, or assume/fabricate results — the harness handles delivery. " +
  "After spawning, end your turn or do other independent work (parallel spawns are fine). " +
  "The sub-agent's turn end is its completion: its closing message is returned to you automatically.";

export function registerSubagentSpawnTool(
  pi: ExtensionAPI,
  shouldRegister: (name: string) => boolean,
): void {
  if (shouldRegister("subagent_spawn"))
    pi.registerTool({
      name: "subagent_spawn",
      label: "Spawn Subagent",
      description: SUBAGENT_SPAWN_DESCRIPTION,
      promptSnippet: SUBAGENT_SPAWN_DESCRIPTION,
      parameters: SubagentSpawnParams,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        // Block same-agent recursion (e.g. planner spawning planner).
        const currentAgent = process.env.PI_SUBAGENT_AGENT;
        if (params.agent && currentAgent && params.agent === currentAgent) {
          return textResult(
            `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
            { error: "self-spawn blocked" },
          );
        }

        // The self-spawn guard only catches same-agent recursion; this caps all nesting.
        if (currentSubagentDepth() >= MAX_SUBAGENT_DEPTH) {
          return textResult(
            `Subagent nesting is capped at ${MAX_SUBAGENT_DEPTH} levels and you are at the limit. ` +
              `Do the work yourself instead of spawning another sub-agent.`,
            { error: "depth limit", depth: currentSubagentDepth() },
          );
        }

        if (params.agent && !loadAgentDefaults(params.agent)) {
          const text = `Unknown agent "${params.agent}". Available agents:\n${formatAvailableAgents()}`;
          return textResult(text, {
            error: "unknown agent",
            agent: params.agent,
          });
        }

        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return textResult(
            "Error: no session file. Start pi with a persistent session to use subagents.",
            { error: "no session file" },
          );
        }

        const running = await launchSubagent(params, ctx);

        // Fire-and-forget: the watcher's .then() steers the result later.
        startWatchPipeline(pi, running);
        return textResult(
          `Sub-agent "${params.name}" launched and is now running in the background. ` +
            `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
            `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
            `Until then, move on to other work or tell the user you're waiting.` +
            (running.modelWarning ? `\n\n⚠️ ${running.modelWarning}` : ""),
          {
            id: running.id,
            name: params.name,
            task: params.task,
            agent: params.agent,
            sessionFile: running.sessionFile,
            launchScriptFile: running.launchScriptFile,
            status: "started",
            ...(running.modelWarning
              ? { modelWarning: running.modelWarning }
              : {}),
          },
        );
      },

      renderCall(args, theme) {
        const partialArgs = args as Record<string, unknown>;
        const name =
          typeof partialArgs.name === "string" && partialArgs.name
            ? partialArgs.name
            : "(unnamed)";
        const task =
          typeof partialArgs.task === "string" ? partialArgs.task : "";
        const agent =
          typeof partialArgs.agent === "string" && partialArgs.agent
            ? theme.fg("dim", ` (${partialArgs.agent})`)
            : "";
        const cwdHint =
          typeof partialArgs.cwd === "string" && partialArgs.cwd
            ? theme.fg("dim", ` in ${partialArgs.cwd}`)
            : "";
        let text = `▸ ${theme.fg("toolTitle", theme.bold(name))}${agent}${cwdHint}`;

        // Show a one-line preview: renderCall re-runs as args.task grows token by token.
        if (task) {
          const firstLine =
            task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview =
            firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
          if (preview) {
            text += `\n${theme.fg("toolOutput", preview)}`;
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = detailsOf(result.details);
        const name = details.name ?? "(unnamed)";

        if (details.status === "started") {
          return targetCallText(name, theme, "started");
        }

        return renderResultFallback(result, theme);
      },
    });
}
