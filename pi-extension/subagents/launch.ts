// Launch policy, command building, and the subagent launcher.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { getSubagentActivityFile } from "./activity.ts";
import {
  getAgentConfigDir,
  loadAgentDefaults,
  resolveDenyTools,
  resolveInteractive,
  type AgentDefaults,
  type SubagentSessionMode,
} from "./agents.ts";
import {
  createSurface,
  getMuxBackend,
  sendLongCommand,
  shellEscape,
} from "./cmux.ts";
import {
  type SeededSubagentSessionMode,
  seedSubagentSessionFile,
} from "./session.ts";
import { runningSubagents, type RunningSubagent } from "./state.ts";
import { createStatusState } from "./status.ts";
import {
  fileTimestamp,
  getArtifactDir,
  getShellReadyDelayMs,
  randomHex,
  safeFileName,
  SUBAGENTS_DIR,
} from "./util.ts";

/**
 * Spawn-tool parameters. `interactive` lives in agent frontmatter only —
 * it is a property of the role, not of an individual call.
 */
export const SubagentSpawnParams = Type.Object({
  name: Type.String({ description: "Display name for the subagent" }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  agent: Type.Optional(
    Type.String({
      description:
        "Agent name to load defaults from (e.g. 'worker', 'scout', 'reviewer'). Reads .pi/agents/<name>.md or ~/.pi/agent/agents/<name>.md for model, tools, skills. Unknown names fail with the available list.",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({
      description: "Appended to system prompt (role instructions)",
    }),
  ),
  model: Type.Optional(
    Type.String({ description: "Model override (overrides agent default)" }),
  ),
  skills: Type.Optional(
    Type.String({
      description: "Comma-separated skills (overrides agent default)",
    }),
  ),
  tools: Type.Optional(
    Type.String({
      description: "Comma-separated tools (overrides agent default)",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.",
    }),
  ),
  fork: Type.Optional(
    Type.Boolean({
      description:
        "Force the full-context fork mode for this spawn. The sub-agent inherits the current session conversation, overriding any agent frontmatter session-mode.",
    }),
  ),
  resumeSessionId: Type.Optional(
    Type.String({
      description:
        "Resume a previous Claude Code session by its ID. Loads the conversation history and continues where it left off. The copied transcript file is returned as `claudeSessionId` in the subagent result details. Use this to retry cancelled runs or ask follow-up questions.",
    }),
  ),
});

export function resolveSubagentPaths(
  params: Static<typeof SubagentSpawnParams>,
  agentDefs: AgentDefaults | null,
): {
  effectiveCwd: string | null;
  localAgentDir: string | null;
  effectiveAgentDir: string;
} {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd
    ? rawCwd.startsWith("/")
      ? rawCwd
      : join(cwdBase, rawCwd)
    : null;
  const localAgentDir = effectiveCwd
    ? join(effectiveCwd, ".pi", "agent")
    : null;
  const effectiveAgentDir =
    localAgentDir && existsSync(localAgentDir)
      ? localAgentDir
      : getAgentConfigDir();
  return { effectiveCwd, localAgentDir, effectiveAgentDir };
}

export function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

export function resolveEffectiveSessionMode(
  params: Static<typeof SubagentSpawnParams>,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  if (params.fork) return "fork";
  return agentDefs?.sessionMode ?? "standalone";
}

/**
 * Decide the --model string for a subagent launch when the agent's model may
 * be unusable in this environment.
 *
 * Agent definitions hardcode model ids (e.g. anthropic/claude-sonnet-4-6)
 * that can lack credentials on the spawning machine — the child pi dies at
 * startup with "No API key found for anthropic" and the run is
 * dead-on-arrival. When the requested provider has no configured auth, fall
 * back to the parent session's model and return a warning, instead of
 * spawning a subagent that can never produce a result.
 *
 * The credential probe is injected so the decision stays unit-testable.
 * Thinking suffixes are dropped on fallback: the agent's tuned level may not
 * be valid on the parent's model.
 */
export interface ModelFallbackDecision {
  model?: string;
  warning?: string;
  /** Whether the agent's `thinking` frontmatter may be appended (true unless
   * we fell back to a model whose thinking levels are unknown). */
  applyThinking: boolean;
}

export function resolveModelWithFallback(params: {
  requestedModel?: string;
  hasAuth: (provider: string, modelId: string) => boolean;
  parentModel?: string;
}): ModelFallbackDecision {
  const requested = params.requestedModel?.trim();
  if (!requested) return { applyThinking: true };
  const slash = requested.indexOf("/");
  if (slash <= 0) return { model: requested, applyThinking: true };
  const provider = requested.slice(0, slash);
  const rest = requested.slice(slash + 1);
  const colon = rest.indexOf(":");
  const modelId = colon === -1 ? rest : rest.slice(0, colon);
  if (params.hasAuth(provider, modelId)) {
    return { model: requested, applyThinking: true };
  }
  const fallback = params.parentModel?.trim();
  if (!fallback) {
    return {
      model: requested,
      applyThinking: true,
      warning:
        `Agent model "${requested}" has no configured credentials in this ` +
        `environment and no parent model is available to fall back to — the ` +
        `subagent may fail to start. Log in to the provider or override the model.`,
    };
  }
  return {
    model: fallback,
    applyThinking: false,
    warning:
      `Agent model "${requested}" has no configured credentials in this ` +
      `environment; falling back to the parent session model "${fallback}". ` +
      `Log in to the provider or configure models.json to use the agent's model.`,
  };
}

export function resolveLaunchBehavior(
  params: Static<typeof SubagentSpawnParams>,
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: SeededSubagentSessionMode | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

/**
 * Control tools the child needs to talk back to the parent. Always added to
 * the child --tools allowlist even when the definition restricts tools.
 */
const SUBAGENT_CONTROL_TOOLS = ["ask_question"] as const;

/**
 * Build the child --tools allowlist.
 *
 * Pi 0.70+ applies --tools to built-in, extension, and custom tools. If a
 * subagent definition restricts tools to e.g. "read,bash,write", the child
 * control tool ask_question from child.ts would otherwise be hidden.
 */
export function buildSubagentToolAllowlist(
  effectiveTools?: string,
): string | null {
  const requested = (effectiveTools ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);

  if (requested.length === 0) return null;

  const allow = new Set(requested);
  for (const tool of SUBAGENT_CONTROL_TOOLS) {
    allow.add(tool);
  }

  return [...allow].join(",");
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */
export function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  const skillPrompts = (params.effectiveSkills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);

  const needsSeparator =
    params.taskDelivery === "artifact" && skillPrompts.length > 0;

  return [...(needsSeparator ? [""] : []), ...skillPrompts, params.taskArg];
}

/**
 * Cross-parameter contract checks that must fail loudly instead of silently
 * degrading (pure/unit-testable, called from launchSubagent):
 * - resumeSessionId only means anything to the claude CLI;
 * - fork seeds pi-format session files claude cannot read;
 * - fork × interactive is the unattended-forever pane: forked bare-task
 *   delivery plus no auto-exit means nothing ever completes;
 * - on the claude path, tool allowlists cannot be enforced
 *   (--dangerously-skip-permissions ignores them) and skills have no
 *   mapping — all would silently degrade into something other than what
 *   was declared.
 */
export function validateSpawnCombos(params: {
  fork?: boolean;
  interactive: boolean;
  cli?: string;
  resumeSessionId?: string;
  tools?: string;
  skills?: string;
}): void {
  const claude = params.cli === "claude";
  if (params.resumeSessionId && !claude) {
    throw new Error(
      "resumeSessionId is only supported for claude-backed agents (cli: claude) — pi-backed spawns would silently ignore it and start a fresh session.",
    );
  }
  if (params.fork && claude) {
    throw new Error(
      "fork is not supported for claude-backed agents: claude cannot read pi-seeded session files, so the conversation would not be inherited.",
    );
  }
  if (params.fork && params.interactive) {
    throw new Error(
      "fork spawns cannot be interactive: forked bare-task delivery plus no auto-exit means nothing ever completes. Drop fork or interactive.",
    );
  }
  if (claude && params.tools) {
    throw new Error(
      "tools cannot be restricted on claude-backed agents: claude runs with --dangerously-skip-permissions, where --allowedTools only pre-approves and never restricts. Remove the tools declaration or the cli: claude flag.",
    );
  }
  if (claude && params.interactive) {
    throw new Error(
      "interactive is not supported for claude-backed agents. Drop interactive or the cli: claude flag.",
    );
  }
  if (claude && params.skills) {
    throw new Error(
      "skills have no mapping on claude-backed agents and would be silently dropped. Remove the skills declaration or the cli: claude flag.",
    );
  }
}

export function resolveResumeLaunchBehavior(): {
  interactive: boolean;
} {
  // Resumed sessions are always autonomous: the resume message is parent
  // input, the reply's turn end auto-exits and steers the result back.
  return { interactive: false };
}

/** Maximum subagent nesting (parent orchestrator = depth 0). */
export const MAX_SUBAGENT_DEPTH = 3;

/** Nesting depth of this process from PI_SUBAGENT_DEPTH (0 when unset). */
export function currentSubagentDepth(): number {
  const raw = process.env.PI_SUBAGENT_DEPTH?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

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

/**
 * Shared pi-invocation skeleton: session flag, herdr TUI fallback, the
 * child extension hook, env prefix, cd, and the DONE marker. `escapedArgs`
 * are pre-shaped command words (flags verbatim, values shell-escaped).
 */
export function buildPiInvocation(opts: {
  sessionFile: string;
  envPrefix: string;
  escapedArgs: string[];
  effectiveCwd?: string;
}): string {
  const parts = ["pi", "--session", shellEscape(opts.sessionFile)];

  // herdr's `pane read` can't see alt-screen panes, which breaks
  // pollForExit's crash detection, so force regular mode there.
  if (getMuxBackend() === "herdr") {
    parts.push("--tui-mode", "regular");
  }

  // Load child.ts so the session auto-exits when its turn ends (writing the
  // .exit sidecar) and can ask the parent questions via ask_question.
  parts.push("-e", shellEscape(join(SUBAGENTS_DIR, "child.ts")));

  parts.push(...opts.escapedArgs);

  const cdPrefix = opts.effectiveCwd
    ? `cd ${shellEscape(opts.effectiveCwd)} && `
    : "";
  return `${cdPrefix}${opts.envPrefix}${parts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;
}

/** Claude Code invocation, including the sentinel env var and DONE marker. */
export function buildClaudeCommand(opts: {
  id: string;
  task: string;
  systemPrompt?: string;
  resumeSessionId?: string;
  model?: string;
  agentBody: string;
  /** Pi-side deny list, forwarded best-effort (names may not match). */
  disallowedTools?: string;
  effectiveCwd?: string;
  /** Nesting depth to propagate through the claude hop. */
  depth?: number;
}): { command: string; sentinelFile: string } {
  // 128 bits of sentinel id: the path lives in world-writable /tmp, so it
  // must be unguessable in advance (pre-create/symlink planting).
  const sentinelFile = `/tmp/pi-claude-${randomHex(16)}-done`;
  const cmdParts: string[] = [];
  cmdParts.push(`PI_CLAUDE_SENTINEL=${shellEscape(sentinelFile)}`);
  // A claude child has full bash; propagate the nesting depth so a pi it
  // launches manually cannot reset the cap.
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

  // Tool allowlists are rejected at validation (unenforceable under
  // --dangerously-skip-permissions). A deny list is forwarded as
  // best-effort defense-in-depth: claude ignores names it does not know,
  // and denies the tool when they happen to match.
  if (opts.disallowedTools) {
    cmdParts.push("--disallowedTools", shellEscape(opts.disallowedTools));
  }

  // Params-over-defaults convention — opposite of the pi path, where the
  // agent-file body wins.
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

/**
 * Send a launch command into a pane via a generated shell script under the
 * session artifacts; returns the script path.
 */
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

/** Single construction site for tracked runs (pi/claude spawns + resume). */
export function createRunningSubagent(init: {
  id: string;
  name: string;
  task: string;
  surface: string;
  startTime: number;
  sessionFile: string;
  launchScriptFile: string;
  interactive: boolean;
  source: "pi" | "claude";
  agent?: string;
  activityFile?: string;
  sentinelFile?: string;
  modelWarning?: string;
}): RunningSubagent {
  return {
    id: init.id,
    name: init.name,
    task: init.task,
    agent: init.agent,
    surface: init.surface,
    startTime: init.startTime,
    sessionFile: init.sessionFile,
    launchScriptFile: init.launchScriptFile,
    activityFile: init.activityFile,
    sentinelFile: init.sentinelFile,
    interactive: init.interactive,
    modelWarning: init.modelWarning,
    cli: init.source === "claude" ? "claude" : undefined,
    statusState: createStatusState({
      source: init.source,
      startTimeMs: init.startTime,
    }),
  };
}

/**
 * Assemble the full task text. Fork mode inherits the conversation and gets
 * the bare task; blank-session modes get wrapper instructions and
 * artifact-backed handoff.
 *
 * There is exactly one completion rule for every spawn: ending the turn is
 * finishing — the last assistant message is returned to the parent and the
 * session closes. Questions for the parent go through ask_question; nothing
 * needs to be "called" to finish.
 */
export function composeFullTask(opts: {
  task: string;
  roleBlock: string;
  inheritsConversationContext: boolean;
  interactive: boolean;
}): string {
  const completionHint = opts.interactive
    ? "This pane is user-driven: the user works with you here directly."
    : "Ending your turn finishes this task — your final message is returned to the parent. To ask the parent, call ask_question.";
  if (opts.inheritsConversationContext) return opts.task;
  return `${opts.roleBlock}\n\n${completionHint}\n\n${opts.task}`;
}

/**
 * Launch a subagent: creates the multiplexer pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
export async function launchSubagent(
  params: Static<typeof SubagentSpawnParams>,
  ctx: {
    sessionManager: {
      getSessionFile(): string | null;
      getSessionId(): string;
      getSessionDir(): string;
    };
    cwd: string;
    /** Structural slice of ModelRegistry used by the credential fallback. */
    modelRegistry: {
      find(provider: string, modelId: string): unknown;
      hasConfiguredAuth(model: unknown): boolean;
    };
    model?: { provider: string; id: string } | null;
  },
  options?: { surface?: string },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = randomHex(8);

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
  const requestedModel = params.model ?? agentDefs?.model;
  const effectiveTools = params.tools ?? agentDefs?.tools;
  const effectiveSkills = params.skills ?? agentDefs?.skills;
  const effectiveThinking = agentDefs?.thinking;
  // Interactive is a property of the role (frontmatter), not of the call —
  // and the frontmatter contract is enforced: autonomous agents (spawning:
  // false) may not declare it.
  const effectiveInteractive = resolveInteractive({
    agentName: params.agent ?? params.name,
    agentDefs,
  });
  validateSpawnCombos({
    fork: params.fork,
    interactive: effectiveInteractive,
    cli: agentDefs?.cli,
    resumeSessionId: params.resumeSessionId,
    tools: effectiveTools,
    skills: effectiveSkills,
  });

  // Credential fallback: the agent's hardcoded model may be unusable here.
  // Claude-backed launches manage their own auth (claude CLI login), so only
  // Pi-backed launches get the fallback. A malformed ctx is a programming
  // bug and fails the launch loudly; a probe failure on user-managed data
  // (corrupt models.json / auth storage) is "auth unknown" — keep the
  // requested model and let the child surface the real failure, so a broken
  // probe never blocks every spawn.
  const modelDecision =
    agentDefs?.cli === "claude"
      ? { model: requestedModel, applyThinking: true }
      : resolveModelWithFallback({
          requestedModel,
          hasAuth: (provider, modelId) => {
            const registry = ctx.modelRegistry;
            if (
              typeof registry?.find !== "function" ||
              typeof registry.hasConfiguredAuth !== "function"
            ) {
              throw new TypeError(
                "launchSubagent requires ctx.modelRegistry with find/hasConfiguredAuth",
              );
            }
            try {
              const found = registry.find(provider, modelId);
              return found ? registry.hasConfiguredAuth(found) : false;
            } catch {
              return true;
            }
          },
          parentModel: ctx.model
            ? `${ctx.model.provider}/${ctx.model.id}`
            : undefined,
        });
  const effectiveModel = modelDecision.model;

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");
  const sessionId = ctx.sessionManager.getSessionId();
  const artifactDir = getArtifactDir(
    ctx.sessionManager.getSessionDir(),
    sessionId,
  );

  const { effectiveCwd, localAgentDir, effectiveAgentDir } =
    resolveSubagentPaths(params, agentDefs);
  const targetCwdForSession = effectiveCwd ?? ctx.cwd;
  const sessionDir = getDefaultSessionDirFor(
    targetCwdForSession,
    effectiveAgentDir,
  );

  // Timestamp + unique suffix so simultaneous launches never race on the
  // session file.
  const timestamp = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23)}Z`;
  const uuid = [id, randomHex(8), randomHex(8), randomHex(4)].join("-");
  const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

  // Use pre-created surface (parallel mode) or create a new one.
  // For new surfaces, pause briefly so the shell is ready before sending the command.
  const surfacePreCreated = !!options?.surface;
  const surface = options?.surface ?? createSurface(params.name);
  if (!surfacePreCreated) {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, getShellReadyDelayMs()),
    );
  }

  const launchBehavior = resolveLaunchBehavior(params, agentDefs);

  if (launchBehavior.seededSessionMode) {
    seedSubagentSessionFile({
      mode: launchBehavior.seededSessionMode,
      parentSessionFile: sessionFile,
      childSessionFile: subagentSessionFile,
      childCwd: targetCwdForSession,
    });
  }

  const activityFile = getSubagentActivityFile(artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });

  const denySet = resolveDenyTools(agentDefs);
  // NOTE: unlike tools/model/skills above, the agent-file body wins over an
  // explicit systemPrompt here. The Claude path below resolves the same two
  // inputs in reverse (params over defaults) — keep the difference in mind
  // when changing either.
  const identity = agentDefs?.body ?? params.systemPrompt ?? null;
  const systemPromptMode = agentDefs?.systemPromptMode;
  const identityInSystemPrompt = systemPromptMode && identity;
  const roleBlock =
    identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
  const fullTask = composeFullTask({
    task: params.task,
    roleBlock,
    inheritsConversationContext: launchBehavior.inheritsConversationContext,
    interactive: effectiveInteractive,
  });
  if (agentDefs?.cli === "claude") {
    const { command, sentinelFile } = buildClaudeCommand({
      id,
      task: params.task,
      systemPrompt: params.systemPrompt,
      resumeSessionId: params.resumeSessionId,
      model: effectiveModel,
      agentBody: agentDefs.body,
      disallowedTools: denySet.size > 0 ? [...denySet].join(",") : undefined,
      effectiveCwd,
      depth: currentSubagentDepth() + 1,
    });

    const launchScriptFile = sendLaunchScript(surface, command, {
      artifactDir,
      fileBase: `${safeFileName(params.name, "subagent")}-${id}`,
      preambleLines: [
        `# Claude Code subagent launch script for ${params.name}`,
        `# Generated: ${new Date().toISOString()}`,
        `# Surface: ${surface}`,
      ],
    });

    const running = createRunningSubagent({
      id,
      name: params.name,
      task: params.task,
      agent: params.agent,
      surface,
      startTime,
      sessionFile: subagentSessionFile,
      launchScriptFile,
      interactive: effectiveInteractive,
      source: "claude",
      sentinelFile,
    });

    runningSubagents.set(id, running);
    return running;
  }

  // Trailing command words: flags verbatim, values shell-escaped.
  const escapedArgs: string[] = [];
  if (effectiveModel) {
    const model =
      effectiveThinking && modelDecision.applyThinking
        ? `${effectiveModel}:${effectiveThinking}`
        : effectiveModel;
    escapedArgs.push("--model", shellEscape(model));
  }

  // Pi auto-detects file paths in --system-prompt/--append-system-prompt, so
  // pass the identity as a file to dodge shell escaping of multiline content.
  if (identityInSystemPrompt && identity) {
    const flag =
      systemPromptMode === "replace"
        ? "--system-prompt"
        : "--append-system-prompt";
    const syspromptPath = join(
      artifactDir,
      `context/${safeFileName(params.name, "subagent")}-sysprompt-${fileTimestamp()}.md`,
    );
    mkdirSync(dirname(syspromptPath), { recursive: true });
    writeFileSync(syspromptPath, identity, "utf8");
    escapedArgs.push(flag, shellEscape(syspromptPath));
  }

  const toolAllowlist = buildSubagentToolAllowlist(effectiveTools);
  if (toolAllowlist) {
    escapedArgs.push("--tools", shellEscape(toolAllowlist));
  }

  // Fork mode gets the task as a direct arg; blank-session modes use
  // artifact-backed handoff so instructions arrive as the first message.
  let taskArg: string;
  if (launchBehavior.taskDelivery === "direct") {
    taskArg = fullTask;
  } else {
    const artifactName = `context/${safeFileName(params.name, "subagent")}-${fileTimestamp()}.md`;
    const artifactPath = join(artifactDir, artifactName);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, fullTask, "utf8");
    taskArg = `@${artifactPath}`;
  }
  for (const promptArg of buildPiPromptArgs({
    effectiveSkills,
    taskDelivery: launchBehavior.taskDelivery,
    taskArg,
  })) {
    escapedArgs.push(shellEscape(promptArg));
  }

  // effectiveCwd is resolved above so the env prefix and the cd agree.
  const command = buildPiInvocation({
    sessionFile: subagentSessionFile,
    envPrefix: buildSubagentEnvPrefix({
      name: params.name,
      sessionFile: subagentSessionFile,
      id,
      activityFile,
      surface,
      agent: params.agent,
      interactive: effectiveInteractive,
      denyTools: denySet,
      depth: currentSubagentDepth() + 1,
      // Prefer the target cwd's own .pi/agent/ as config root when present.
      agentConfigDir:
        localAgentDir && existsSync(localAgentDir)
          ? localAgentDir
          : process.env.PI_CODING_AGENT_DIR,
    }),
    escapedArgs,
    effectiveCwd,
  });

  const launchScriptFile = sendLaunchScript(surface, command, {
    artifactDir,
    fileBase: `${safeFileName(params.name, "subagent")}-${id}`,
    preambleLines: [
      `# Subagent launch script for ${params.name}`,
      `# Generated: ${new Date().toISOString()}`,
      `# Session: ${subagentSessionFile}`,
      `# Surface: ${surface}`,
    ],
  });

  const running = createRunningSubagent({
    id,
    name: params.name,
    task: params.task,
    agent: params.agent,
    surface,
    startTime,
    sessionFile: subagentSessionFile,
    launchScriptFile,
    activityFile,
    interactive: effectiveInteractive,
    modelWarning: modelDecision.warning,
    source: "pi",
  });

  runningSubagents.set(id, running);
  return running;
}
