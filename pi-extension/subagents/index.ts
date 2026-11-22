// Composition root for the subagents extension: wires the register* functions
// from the focused modules into the pi extension lifecycle.
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  discoverAgentDefinitions,
  loadAgentDefaults,
  parseAgentDefinition,
  resolveDenyTools,
  resolveInteractive,
} from "./agents.ts";
import {
  buildClaudeCommand,
  buildPiInvocation,
  buildPiPromptArgs,
  buildSubagentEnvPrefix,
  buildSubagentToolAllowlist,
  composeFullTask,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveModelWithFallback,
  resolveResumeLaunchBehavior,
  SubagentSpawnParams,
} from "./launch.ts";
import {
  claimedResumeSessions,
  clearStoredInterval,
  globalStore,
  POLL_ABORT_KEY,
  runningSubagents,
  setLatestContext,
  STATUS_INTERVAL_KEY,
  WIDGET_INTERVAL_KEY,
} from "./state.ts";
import {
  closeRunningSubagent,
  exitSummaryFallback,
  resolveResultPresentation,
  sanitizeArtifactMessage,
  sanitizeInjectedMessage,
} from "./supervise.ts";
import {
  formatAvailableAgents,
  formatRunningSubagents,
  matchLiveTarget,
  registerSubagentCloseTool,
  registerSubagentMessageTool,
  registerSubagentSpawnTool,
  resolveRunningTarget,
} from "./tools.ts";
import { registerSubagentCommands } from "./commands.ts";
import {
  borderLine,
  registerSubagentMessageRenderers,
  renderSubagentWidgetLines,
} from "./ui.ts";
import { decideAgentEnd, findLatestAssistantError } from "./child.ts";
import { getShellReadyDelayMs } from "./util.ts";

export const __test__ = {
  borderLine,
  getShellReadyDelayMs,
  renderSubagentWidgetLines,
  parseAgentDefinition,
  loadAgentDefaults,
  discoverAgentDefinitions,
  resolveInteractive,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveModelWithFallback,
  buildSubagentToolAllowlist,
  buildPiPromptArgs,
  resolveDenyTools,
  resolveRunningTarget,
  matchLiveTarget,
  formatRunningSubagents,
  formatAvailableAgents,
  resolveResultPresentation,
  resolveResumeLaunchBehavior,
  closeRunningSubagent,
  sanitizeInjectedMessage,
  sanitizeArtifactMessage,
  decideAgentEnd,
  findLatestAssistantError,
  runningSubagents,
  buildSubagentEnvPrefix,
  buildPiInvocation,
  buildClaudeCommand,
  exitSummaryFallback,
  composeFullTask,
  SubagentSpawnParams,
};

export default function subagentsExtension(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    setLatestContext(ctx);
  });

  pi.on("session_shutdown", (_event, _ctx) => {
    clearStoredInterval(WIDGET_INTERVAL_KEY);
    clearStoredInterval(STATUS_INTERVAL_KEY);
    const moduleAbort = globalStore[POLL_ABORT_KEY] as
      | AbortController
      | undefined;
    if (moduleAbort) moduleAbort.abort();
    // If pi ever caches module instances across sessions, the next session
    // must not inherit an already-aborted module signal — re-arm it.
    globalStore[POLL_ABORT_KEY] = new AbortController();
    for (const [_id, agent] of runningSubagents) {
      agent.abortController?.abort();
    }
    runningSubagents.clear();
    claimedResumeSessions.clear();
  });

  // Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
  const deniedTools = new Set(
    (process.env.PI_DENY_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const shouldRegister = (name: string) => !deniedTools.has(name);

  registerSubagentSpawnTool(pi, shouldRegister);
  registerSubagentMessageTool(pi, shouldRegister);
  registerSubagentCloseTool(pi, shouldRegister);
  registerSubagentCommands(pi);
  registerSubagentMessageRenderers(pi);
}
