// Pure launch decisions: model fallback, task delivery, validation, prompt routing.
import type { AgentDefaults, SubagentSessionMode } from "../agents.ts";
import type { SeededSubagentSessionMode } from "../session.ts";

export function resolveEffectiveSessionMode(
  params: { fork?: boolean },
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  if (params.fork) return "fork";
  return agentDefs?.sessionMode ?? "standalone";
}

/** Fall back to the parent model when the requested one has no configured auth. */
export interface ModelFallbackDecision {
  model?: string;
  warning?: string;
  /** False when we fell back to a model with unknown thinking levels. */
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
  params: { fork?: boolean },
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: SeededSubagentSessionMode | null;
  inheritsConversationContext: boolean;
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
  };
}

// Kept in the child's --tools allowlist even when the definition restricts tools.
const SUBAGENT_CONTROL_TOOLS = ["ask_question"] as const;

/** Build the --tools allowlist; pi 0.70+ applies --tools to extension tools too. */
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
 * Positional prompt args. Artifact delivery prepends an empty message so the
 * /skill: prompts stay in messages[1..], where pi expands them.
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

// Linux caps one argv entry at MAX_ARG_STRLEN; 32K chars is worst-case-safe.
const TASK_ARGV_MAX_CHARS = 32_000;

/** Positional arg unless a leading "-" parses as a flag or argv limits are hit. */
export function resolveTaskDelivery(fullTask: string): "direct" | "artifact" {
  if (fullTask.startsWith("-")) return "artifact";
  if (fullTask.length > TASK_ARGV_MAX_CHARS) return "artifact";
  return "direct";
}

/** Reject parameter combinations that would otherwise silently degrade. */
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
  // Resumed sessions are always autonomous: the reply's turn end auto-exits.
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

/** Identity and lifecycle contract into pi's prompt slots, per systemPromptMode. */
export function composeSystemPromptParts(opts: {
  identity: string | null;
  systemPromptMode?: "replace" | "append";
  interactive: boolean;
}): { append: string; replace: string | null } {
  const completionHint = opts.interactive
    ? "This pane is user-driven: the user works with you here directly."
    : "Ending your turn finishes this task — your final message is returned to the parent. To ask the parent, call ask_question.";
  const identityInReplace =
    opts.identity != null && opts.systemPromptMode === "replace";
  const append =
    identityInReplace || !opts.identity
      ? completionHint
      : `${opts.identity}\n\n${completionHint}`;
  return { append, replace: identityInReplace ? opts.identity : null };
}
