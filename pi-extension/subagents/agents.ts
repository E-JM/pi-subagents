import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SUBAGENTS_DIR } from "./files.ts";

export type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

export interface AgentDefaults {
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  denyTools?: string;
  spawning?: boolean;
  /** Keep the pane open for the user. Invalid on `spawning: false` agents. */
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  cli?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

export type AgentSource = "package" | "global" | "project";

interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

const SPAWNING_TOOLS = new Set([
  "subagent_spawn",
  "subagent_message",
  "subagent_close",
]);

/** Denied tool names: `spawning: false` expands to SPAWNING_TOOLS, then
 * `deny-tools` adds names on top. */
export function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
  const denied = new Set<string>();
  if (!agentDefs) return denied;

  if (agentDefs.spawning === false) {
    for (const t of SPAWNING_TOOLS) denied.add(t);
  }

  if (agentDefs.denyTools) {
    for (const t of agentDefs.denyTools
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      denied.add(t);
    }
  }

  return denied;
}

/**
 * Interactive flag, enforcing the frontmatter contract: autonomous agents
 * auto-exit at turn end, so `interactive: true` is a config error for them.
 */
export function resolveInteractive(params: {
  agentName?: string;
  agentDefs: AgentDefaults | null;
}): boolean {
  const interactive = params.agentDefs?.interactive ?? false;
  if (interactive && params.agentDefs?.spawning === false) {
    throw new Error(
      `Agent "${params.agentName ?? "unknown"}" declares interactive: true but sets spawning: false. ` +
        `Autonomous agents auto-exit when their turn ends — an interactive flag nobody attends would dead-lock. ` +
        `Remove interactive from the frontmatter or enable spawning.`,
    );
  }
  return interactive;
}

export function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function getBundledAgentsDir(): string {
  return join(SUBAGENTS_DIR, "../../agents");
}

function getFrontmatterValue(
  frontmatter: string,
  key: string,
): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim();
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value == null) return undefined;
  // First token only, so `spawning: false # note` still parses safely.
  return value.trim().split(/\s+/)[0] === "true";
}

function parseSessionMode(
  value: string | undefined,
): SubagentSessionMode | undefined {
  const token = value?.trim().split(/\s+/)[0];
  if (token === "standalone" || token === "lineage-only" || token === "fork") {
    return token;
  }
  return undefined;
}

export function parseAgentDefinition(
  content: string,
  fallbackName: string,
): AgentDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1] ?? "";
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");

  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    model: getFrontmatterValue(frontmatter, "model"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    skills:
      getFrontmatterValue(frontmatter, "skill") ??
      getFrontmatterValue(frontmatter, "skills"),
    thinking: getFrontmatterValue(frontmatter, "thinking"),
    denyTools: getFrontmatterValue(frontmatter, "deny-tools"),
    spawning: parseOptionalBoolean(
      getFrontmatterValue(frontmatter, "spawning"),
    ),
    interactive: parseOptionalBoolean(
      getFrontmatterValue(frontmatter, "interactive"),
    ),
    sessionMode: parseSessionMode(
      getFrontmatterValue(frontmatter, "session-mode"),
    ),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    cli: getFrontmatterValue(frontmatter, "cli"),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(
        frontmatter,
        "disable-model-invocation",
      )?.toLowerCase() === "true",
  };
}

export function discoverAgentDefinitions(): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: AgentSource }> = [
    { path: getBundledAgentsDir(), source: "package" },
    { path: join(getAgentConfigDir(), "agents"), source: "global" },
    { path: join(process.cwd(), ".pi", "agents"), source: "project" },
  ];

  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)
      .filter((entry) => entry.endsWith(".md"))
      .sort()) {
      const parsed = parseAgentDefinition(
        readFileSync(join(dir, file), "utf8"),
        file.replace(/\.md$/, ""),
      );
      if (!parsed) continue;
      agents.set(parsed.name, { ...parsed, source });
    }
  }

  return [...agents.values()];
}

/** Agent names become `<name>.md` paths: reject traversal and absolute paths. */
const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function loadAgentDefaults(agentName: string): AgentDefaults | null {
  if (!AGENT_NAME_PATTERN.test(agentName)) return null;
  const configDir = getAgentConfigDir();
  const paths = [
    join(process.cwd(), ".pi", "agents", `${agentName}.md`),
    join(configDir, "agents", `${agentName}.md`),
    join(getBundledAgentsDir(), `${agentName}.md`),
  ];

  for (const p of paths) {
    if (!existsSync(p)) continue;
    const parsed = parseAgentDefinition(readFileSync(p, "utf8"), agentName);
    if (parsed) return parsed;
  }

  return null;
}
