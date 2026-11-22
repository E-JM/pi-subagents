// Shell command construction: env prefixes, pi/claude invocations, pane delivery.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SUBAGENTS_DIR } from "../files.ts";
import { sendLongCommand } from "../mux/api.ts";
import { getMuxBackend } from "../mux/backend.ts";
import { randomHex } from "../random.ts";
import { shellEscape } from "../shell.ts";

/** Env assignments shared by every pi-backed launch and resume, in one place. */
export function buildSubagentEnvPrefix(spec: {
  name: string;
  sessionFile: string;
  id: string;
  activityFile: string;
  interactive?: boolean;
  agent?: string;
  surface?: string;
  denyTools?: Set<string>;
  agentConfigDir?: string;
  depth?: number;
}): string {
  const parts: string[] = [];
  if (spec.agentConfigDir) {
    parts.push(`PI_CODING_AGENT_DIR=${shellEscape(spec.agentConfigDir)}`);
  }
  if (spec.denyTools && spec.denyTools.size > 0) {
    parts.push(`PI_DENY_TOOLS=${shellEscape([...spec.denyTools].join(","))}`);
  }
  parts.push(`PI_SUBAGENT_NAME=${shellEscape(spec.name)}`);
  if (spec.agent) {
    parts.push(`PI_SUBAGENT_AGENT=${shellEscape(spec.agent)}`);
  }
  if (spec.interactive) {
    parts.push("PI_SUBAGENT_INTERACTIVE=1");
  }
  parts.push(`PI_SUBAGENT_SESSION=${shellEscape(spec.sessionFile)}`);
  parts.push(`PI_SUBAGENT_ID=${shellEscape(spec.id)}`);
  if (spec.depth != null) {
    parts.push(`PI_SUBAGENT_DEPTH=${spec.depth}`);
  }
  parts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(spec.activityFile)}`);
  if (spec.surface) {
    parts.push(`PI_SUBAGENT_SURFACE=${shellEscape(spec.surface)}`);
  }
  return `${parts.join(" ")} `;
}

/** Shared pi-invocation skeleton: session, extension hook, env prefix, cd, DONE marker. */
export function buildPiInvocation(opts: {
  sessionFile: string;
  envPrefix: string;
  escapedArgs: string[];
  effectiveCwd?: string | null;
}): string {
  const parts = ["pi", "--session", shellEscape(opts.sessionFile)];

  // herdr's `pane read` can't see alt-screen panes, breaking crash detection.
  if (getMuxBackend() === "herdr") {
    parts.push("--tui-mode", "regular");
  }

  // child.ts makes the session auto-exit at turn end and adds ask_question.
  parts.push("-e", shellEscape(join(SUBAGENTS_DIR, "child.ts")));

  parts.push(...opts.escapedArgs);

  const cdPrefix = opts.effectiveCwd
    ? `cd ${shellEscape(opts.effectiveCwd)} && `
    : "";
  return `${cdPrefix}${opts.envPrefix}${parts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;
}

export function buildClaudeCommand(opts: {
  id: string;
  task: string;
  systemPrompt?: string;
  resumeSessionId?: string;
  model?: string;
  agentBody?: string;
  /** Pi-side deny list, forwarded best-effort (names may not match). */
  disallowedTools?: string;
  effectiveCwd?: string | null;
  depth?: number;
}): { command: string; sentinelFile: string } {
  // Sentinel path lives in world-writable /tmp, so 128 bits keep it unguessable.
  const sentinelFile = `/tmp/pi-claude-${randomHex(16)}-done`;
  const cmdParts: string[] = [];
  cmdParts.push(`PI_CLAUDE_SENTINEL=${shellEscape(sentinelFile)}`);
  // A claude child has full bash; propagate depth so a manual pi can't reset the cap.
  if (opts.depth != null) {
    cmdParts.push(`PI_SUBAGENT_DEPTH=${opts.depth}`);
  }
  cmdParts.push("claude");
  cmdParts.push("--dangerously-skip-permissions");

  const pluginDir = join(SUBAGENTS_DIR, "plugin");
  if (existsSync(pluginDir)) {
    cmdParts.push("--plugin-dir", shellEscape(pluginDir));
  }

  if (opts.model) {
    cmdParts.push("--model", shellEscape(opts.model));
  }

  // Allowlists are rejected at validation; a deny list is best-effort defense-in-depth.
  if (opts.disallowedTools) {
    cmdParts.push("--disallowedTools", shellEscape(opts.disallowedTools));
  }

  // Params over agent body — the reverse of the pi path.
  const sp = opts.systemPrompt ?? opts.agentBody;
  if (sp) {
    cmdParts.push("--append-system-prompt", shellEscape(sp));
  }

  if (opts.resumeSessionId) {
    cmdParts.push("--resume", shellEscape(opts.resumeSessionId));
  }

  // For resumed sessions the task doubles as the follow-up instruction.
  cmdParts.push(shellEscape(opts.task));

  const cdPrefix = opts.effectiveCwd
    ? `cd ${shellEscape(opts.effectiveCwd)} && `
    : "";
  return {
    sentinelFile,
    command: `${cdPrefix}${cmdParts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`,
  };
}

/** Write the command to a script under session artifacts and send it; returns the path. */
export function sendLaunchScript(
  surface: string,
  command: string,
  opts: { artifactDir: string; fileBase: string; preambleLines: string[] },
): string {
  const scriptPath = join(
    opts.artifactDir,
    "subagent-scripts",
    `${opts.fileBase}.sh`,
  );
  sendLongCommand(surface, command, {
    scriptPath,
    scriptPreamble: opts.preambleLines.join("\n"),
  });
  return scriptPath;
}
