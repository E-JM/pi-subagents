// Spawn orchestration: resolve the plan, then run it on the pi or claude branch.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Static } from "@sinclair/typebox";
import { getSubagentActivityFile } from "../activity/schema.ts";
import {
  type AgentDefaults,
  getAgentConfigDir,
  loadAgentDefaults,
  resolveDenyTools,
  resolveInteractive,
} from "../agents.ts";
import {
  fileTimestamp,
  getArtifactDir,
  safeFileName,
  writeArtifactFile,
} from "../files.ts";
import { createSurface } from "../mux/api.ts";
import { randomHex } from "../random.ts";
import { seedSubagentSessionFile } from "../session.ts";
import { getShellReadyDelayMs, shellEscape } from "../shell.ts";
import { type RunningSubagent, registry } from "../state.ts";
import { createStatusState } from "../status/snapshot.ts";
import {
  buildClaudeCommand,
  buildPiInvocation,
  buildSubagentEnvPrefix,
  sendLaunchScript,
} from "./command-builder.ts";
import {
  buildPiPromptArgs,
  buildSubagentToolAllowlist,
  composeSystemPromptParts,
  currentSubagentDepth,
  type ModelFallbackDecision,
  resolveLaunchBehavior,
  resolveModelWithFallback,
  resolveTaskDelivery,
  validateSpawnCombos,
} from "./policies.ts";
import type { SubagentSpawnParams } from "./schema.ts";

interface LaunchContext {
  sessionManager: {
    getSessionFile(): string | null | undefined;
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
}

interface ResolvedSpawn {
  params: Static<typeof SubagentSpawnParams>;
  id: string;
  startTime: number;
  agentDefs: AgentDefaults | null;
  modelDecision: ModelFallbackDecision;
  interactive: boolean;
  effectiveTools?: string;
  effectiveSkills?: string;
  effectiveThinking?: string;
  denySet: Set<string>;
  /** Parent session file (fork seeds from it). */
  sessionFile: string;
  artifactDir: string;
  effectiveCwd: string | null;
  localAgentDir: string | null;
  targetCwdForSession: string;
  childSessionFile: string;
  promptParts: { append: string; replace: string | null };
}

function resolveSubagentPaths(
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

function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

/** Decide the full launch plan before a pane exists; fails loudly on invalid input. */
function resolveSpawn(
  params: Static<typeof SubagentSpawnParams>,
  ctx: LaunchContext,
): ResolvedSpawn {
  const startTime = Date.now();
  const id = randomHex(8);

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
  const requestedModel = params.model ?? agentDefs?.model;
  const effectiveTools = params.tools ?? agentDefs?.tools;
  const effectiveSkills = params.skills ?? agentDefs?.skills;
  const effectiveThinking = agentDefs?.thinking;
  // Interactive is a role property from frontmatter, not a per-call option.
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

  // Claude launches manage their own auth, so only pi launches fall back. A
  // failed probe counts as "auth unknown" so a broken probe never blocks spawns.
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

  // Timestamp + unique suffix so concurrent launches never share a session file.
  const timestamp = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23)}Z`;
  const uuid = [id, randomHex(8), randomHex(8), randomHex(4)].join("-");
  const childSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

  const denySet = resolveDenyTools(agentDefs);
  // Unlike tools/model/skills, the agent body wins over an explicit
  // systemPrompt here; the Claude path resolves these two in reverse.
  const identity = agentDefs?.body ?? params.systemPrompt ?? null;
  const systemPromptMode = agentDefs?.systemPromptMode;
  // The Claude path ignores this and wires identity/task in buildClaudeCommand.
  const promptParts = composeSystemPromptParts({
    identity,
    systemPromptMode,
    interactive: effectiveInteractive,
  });

  return {
    params,
    id,
    startTime,
    agentDefs,
    modelDecision,
    interactive: effectiveInteractive,
    effectiveTools,
    effectiveSkills,
    effectiveThinking,
    denySet,
    sessionFile,
    artifactDir,
    effectiveCwd,
    localAgentDir,
    targetCwdForSession,
    childSessionFile,
    promptParts,
  };
}

function registerPlannedRun(running: RunningSubagent): RunningSubagent {
  registry.register(running);
  return running;
}

function launchOnClaude(plan: ResolvedSpawn, surface: string): RunningSubagent {
  const { params, id, agentDefs } = plan;
  const { command, sentinelFile } = buildClaudeCommand({
    id,
    task: params.task,
    systemPrompt: params.systemPrompt,
    resumeSessionId: params.resumeSessionId,
    model: plan.modelDecision.model,
    agentBody: agentDefs?.body,
    disallowedTools:
      plan.denySet.size > 0 ? [...plan.denySet].join(",") : undefined,
    effectiveCwd: plan.effectiveCwd,
    depth: currentSubagentDepth() + 1,
  });

  const launchScriptFile = sendLaunchScript(surface, command, {
    artifactDir: plan.artifactDir,
    fileBase: `${safeFileName(params.name, "subagent")}-${id}`,
    preambleLines: [
      `# Claude Code subagent launch script for ${params.name}`,
      `# Generated: ${new Date().toISOString()}`,
      `# Surface: ${surface}`,
    ],
  });

  return registerPlannedRun(
    createRunningSubagent({
      id,
      name: params.name,
      task: params.task,
      agent: params.agent,
      surface,
      startTime: plan.startTime,
      sessionFile: plan.childSessionFile,
      launchScriptFile,
      interactive: plan.interactive,
      source: "claude",
      sentinelFile,
    }),
  );
}

function buildSpawnEscapedArgs(plan: ResolvedSpawn): string[] {
  // Trailing command words: flags verbatim, values shell-escaped.
  const escapedArgs: string[] = [];
  const { params, effectiveThinking } = plan;
  const effectiveModel = plan.modelDecision.model;

  if (effectiveModel) {
    const model =
      effectiveThinking && plan.modelDecision.applyThinking
        ? `${effectiveModel}:${effectiveThinking}`
        : effectiveModel;
    escapedArgs.push("--model", shellEscape(model));
  }

  // Wrapper payloads travel as files: pi resolves file paths for both prompt
  // flags, avoiding shell escaping of multiline content.
  const baseName = `${safeFileName(params.name, "subagent")}-${fileTimestamp()}`;
  if (plan.promptParts.replace != null) {
    const replacePath = writeArtifactFile(
      join(plan.artifactDir, `context/${baseName}-sysprompt.md`),
      plan.promptParts.replace,
    );
    escapedArgs.push("--system-prompt", shellEscape(replacePath));
  }
  const appendPath = writeArtifactFile(
    join(plan.artifactDir, `context/${baseName}-wrapper.md`),
    plan.promptParts.append,
  );
  escapedArgs.push("--append-system-prompt", shellEscape(appendPath));

  const toolAllowlist = buildSubagentToolAllowlist(plan.effectiveTools);
  if (toolAllowlist) {
    escapedArgs.push("--tools", shellEscape(toolAllowlist));
  }

  // The task is the bare first message; artifact delivery avoids argv limits.
  const taskDelivery = resolveTaskDelivery(params.task);
  let taskArg: string;
  if (taskDelivery === "direct") {
    taskArg = params.task;
  } else {
    const artifactPath = writeArtifactFile(
      join(plan.artifactDir, `context/${baseName}.md`),
      params.task,
    );
    taskArg = `@${artifactPath}`;
  }
  for (const promptArg of buildPiPromptArgs({
    effectiveSkills: plan.effectiveSkills,
    taskDelivery,
    taskArg,
  })) {
    escapedArgs.push(shellEscape(promptArg));
  }

  return escapedArgs;
}

function launchOnPi(
  plan: ResolvedSpawn,
  surface: string,
  activityFile: string,
): RunningSubagent {
  const { params, id } = plan;
  const escapedArgs = buildSpawnEscapedArgs(plan);

  // effectiveCwd is resolved in resolveSpawn so the env prefix and cd agree.
  const command = buildPiInvocation({
    sessionFile: plan.childSessionFile,
    envPrefix: buildSubagentEnvPrefix({
      name: params.name,
      sessionFile: plan.childSessionFile,
      id,
      activityFile,
      surface,
      agent: params.agent,
      interactive: plan.interactive,
      denyTools: plan.denySet,
      depth: currentSubagentDepth() + 1,
      // Prefer the target cwd's own .pi/agent/ as config root when present.
      agentConfigDir:
        plan.localAgentDir && existsSync(plan.localAgentDir)
          ? plan.localAgentDir
          : process.env.PI_CODING_AGENT_DIR,
    }),
    escapedArgs,
    effectiveCwd: plan.effectiveCwd,
  });

  const launchScriptFile = sendLaunchScript(surface, command, {
    artifactDir: plan.artifactDir,
    fileBase: `${safeFileName(params.name, "subagent")}-${id}`,
    preambleLines: [
      `# Subagent launch script for ${params.name}`,
      `# Generated: ${new Date().toISOString()}`,
      `# Session: ${plan.childSessionFile}`,
      `# Surface: ${surface}`,
    ],
  });

  return registerPlannedRun(
    createRunningSubagent({
      id,
      name: params.name,
      task: params.task,
      agent: params.agent,
      surface,
      startTime: plan.startTime,
      sessionFile: plan.childSessionFile,
      launchScriptFile,
      activityFile,
      interactive: plan.interactive,
      modelWarning: plan.modelDecision.warning,
      source: "pi",
    }),
  );
}

/** Single construction site for tracked runs (spawns and resume). */
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

/** Launch a subagent and return the tracked run; watchSubagent() observes completion. */
export async function launchSubagent(
  params: Static<typeof SubagentSpawnParams>,
  ctx: LaunchContext,
  options?: { surface?: string },
): Promise<RunningSubagent> {
  const plan = resolveSpawn(params, ctx);

  // Reuse a pre-created surface, or create one and wait for the shell to start.
  const surfacePreCreated = !!options?.surface;
  const surface = options?.surface ?? createSurface(params.name);
  if (!surfacePreCreated) {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, getShellReadyDelayMs()),
    );
  }

  const launchBehavior = resolveLaunchBehavior(params, plan.agentDefs);
  if (launchBehavior.seededSessionMode) {
    seedSubagentSessionFile({
      mode: launchBehavior.seededSessionMode,
      parentSessionFile: plan.sessionFile,
      childSessionFile: plan.childSessionFile,
      childCwd: plan.targetCwdForSession,
    });
  }

  const activityFile = getSubagentActivityFile(plan.artifactDir, plan.id);
  mkdirSync(dirname(activityFile), { recursive: true });

  return plan.agentDefs?.cli === "claude"
    ? launchOnClaude(plan, surface)
    : launchOnPi(plan, surface, activityFile);
}
