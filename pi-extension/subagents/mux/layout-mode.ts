// Subagent layout mode (columns vs tiled grid, herdr/tmux only).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SubagentLayoutMode = "columns" | "tiled";

const LAYOUT_MODE_KEY = Symbol.for("pi-subagents/layout-mode");
const LAYOUT_MODE_FILE = "subagents-layout.json";

function parseLayoutMode(value: unknown): SubagentLayoutMode | null {
  return value === "columns" || value === "tiled" ? value : null;
}

function agentConfigDirForLayout(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function readPersistedLayoutMode(): SubagentLayoutMode | null {
  try {
    const raw = JSON.parse(
      readFileSync(join(agentConfigDirForLayout(), LAYOUT_MODE_FILE), "utf8"),
    );
    return parseLayoutMode(raw?.mode);
  } catch {
    return null;
  }
}

/**
 * Resolve the active subagent pane layout for herdr/tmux. Precedence: the
 * choice persisted by /subagent-layout, then PI_SUBAGENT_LAYOUT, then
 * "columns". Cached on globalThis so it survives /reload.
 */
export function getSubagentLayoutMode(): SubagentLayoutMode {
  const store = globalThis as Record<symbol, unknown>;
  const cached = parseLayoutMode(store[LAYOUT_MODE_KEY]);
  if (cached) return cached;
  const mode =
    readPersistedLayoutMode() ??
    parseLayoutMode(process.env.PI_SUBAGENT_LAYOUT) ??
    "columns";
  store[LAYOUT_MODE_KEY] = mode;
  return mode;
}

/** Set the layout mode and persist it so the choice survives restarts. */
export function setSubagentLayoutMode(mode: SubagentLayoutMode): void {
  (globalThis as Record<symbol, unknown>)[LAYOUT_MODE_KEY] = mode;
  try {
    mkdirSync(agentConfigDirForLayout(), { recursive: true });
    writeFileSync(
      join(agentConfigDirForLayout(), LAYOUT_MODE_FILE),
      `${JSON.stringify({ mode }, null, 2)}\n`,
    );
  } catch {
    // Best effort — the in-memory mode still applies to this session.
  }
}
