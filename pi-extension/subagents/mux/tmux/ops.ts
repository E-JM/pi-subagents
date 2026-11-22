import { execFileSync } from "node:child_process";
import {
  parentRatioFromEnv,
  placedPanes,
  selectSpawnAnchor,
} from "../layout-grid.ts";
import { getSubagentLayoutMode } from "../layout-mode.ts";
import { createTrackedPaneList } from "../tracked-panes.ts";
import {
  parseTmuxPaneGeometry,
  planTmuxGridRebalance,
  planTmuxRebalance,
  TMUX_PANES,
  type TmuxGridResizeOp,
  type TmuxPaneGeometry,
  type TmuxResizeOp,
  tmuxSubagentArea,
} from "./layout.ts";

const TMUX_GEOMETRY_FORMAT =
  "#{pane_id}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}|#{window_width}|#{window_height}";

function readTmuxPaneGeometry(targetPaneId?: string): TmuxPaneGeometry[] {
  const args = ["list-panes", "-F", TMUX_GEOMETRY_FORMAT];
  if (targetPaneId) args.push("-t", targetPaneId);
  try {
    return parseTmuxPaneGeometry(
      execFileSync("tmux", args, { encoding: "utf8" }),
    );
  } catch {
    return [];
  }
}

/** Tracked tmux subagent panes; globalThis + Symbol.for so it survives /reload. */
const TMUX_SUBAGENT_PANES_KEY = Symbol.for("pi-subagents/tmux-subagent-panes");

const tmuxPanes = createTrackedPaneList(TMUX_SUBAGENT_PANES_KEY);

/** Exported for tests only. */
export function setTmuxSubagentPaneList(paneIds: string[]): void {
  tmuxPanes.setPaneList(paneIds);
}

function tmuxParentRatio(): number {
  return parentRatioFromEnv("PI_SUBAGENT_TMUX_PARENT_RATIO");
}

function applyTmuxResizeOps(ops: TmuxResizeOp[]): void {
  for (const op of ops) {
    try {
      execFileSync(
        "tmux",
        ["resize-pane", "-t", op.paneId, "-x", String(op.width)],
        {
          encoding: "utf8",
        },
      );
    } catch {
      // Best effort — tmux clamps to minimum pane sizes.
    }
  }
}

/**
 * Parent width fixed, subagents equal. A second pass absorbs tmux's size
 * clamps. Best effort — never blocks spawning.
 */
function rebalanceTmuxSubagentLayout(parentPaneId: string): void {
  for (let pass = 0; pass < 2; pass++) {
    const panes = readTmuxPaneGeometry(parentPaneId);
    if (panes.length === 0) return;
    const ops = planTmuxRebalance(
      panes,
      parentPaneId,
      tmuxParentRatio(),
      tmuxPanes.paneList(),
    );
    if (ops.length === 0) return;
    applyTmuxResizeOps(ops);
  }
}

function applyTmuxGridResizeOps(ops: TmuxGridResizeOp[]): void {
  for (const op of ops) {
    try {
      // tmux resizes one axis at a time: `-x` columns, `-y` rows.
      const axes = [
        ["-x", op.width],
        ["-y", op.height],
      ] as const;
      for (const [flag, size] of axes) {
        if (size === undefined) continue;
        execFileSync(
          "tmux",
          ["resize-pane", "-t", op.paneId, flag, String(size)],
          {
            encoding: "utf8",
          },
        );
      }
    } catch {
      // Best effort — tmux clamps to minimum pane sizes.
    }
  }
}

/** Same passes as the column rebalance, targeting the tiled grid. */
function rebalanceTmuxGridLayout(parentPaneId: string): void {
  const tracked = tmuxPanes.paneList();
  if (tracked.length === 0) return;
  for (let pass = 0; pass < 2; pass++) {
    const panes = readTmuxPaneGeometry(parentPaneId);
    if (panes.length === 0) return;
    const ops = planTmuxGridRebalance(
      panes,
      parentPaneId,
      tracked,
      tmuxParentRatio(),
    );
    if (ops.length === 0) return;
    applyTmuxGridResizeOps(ops);
  }
}

/** Rebalance in the configured layout mode. Best effort — never blocks spawning. */
function rebalanceTmuxLayoutForMode(parentPaneId: string): void {
  if (getSubagentLayoutMode() === "tiled") {
    rebalanceTmuxGridLayout(parentPaneId);
  } else {
    rebalanceTmuxSubagentLayout(parentPaneId);
  }
}

/**
 * Create a tmux subagent surface inside the group's own panel, so foreign panes
 * in a shared window are never split or resized. Columns mode splits the parent
 * once, then the rightmost tracked pane, keeping the parent at
 * `PI_SUBAGENT_TMUX_PARENT_RATIO` (default 0.4); tiled mode splits the pane
 * covering the next grid cell.
 */
export function createTmuxSubagentSurface(name: string): string {
  const parentPaneId = process.env.TMUX_PANE;
  const tiled = getSubagentLayoutMode() === "tiled";

  let anchorPaneId = parentPaneId ?? undefined;
  let splitDirection: "right" | "down" = "right";

  if (parentPaneId) {
    const panes = readTmuxPaneGeometry(parentPaneId);
    if (panes.length > 0) {
      const known = new Set(panes.map((pane) => pane.paneId));
      setTmuxSubagentPaneList(
        tmuxPanes.paneList().filter((id) => known.has(id)),
      );
      const parent = panes.find((pane) => pane.paneId === parentPaneId);
      if (parent) {
        const tracked = tmuxPanes.paneList();
        const placed = placedPanes(tracked, panes, TMUX_PANES);
        // Clipped to the group region so a shared-window spawn never lands in a
        // foreign pane. Tiled picks the pane covering the next grid cell,
        // columns the rightmost tracked pane; null splits the parent.
        const selection = selectSpawnAnchor(
          placed,
          tmuxSubagentArea(panes, parent, tracked),
          parent.left + parent.width,
          tiled,
          tracked.length + 1,
        );
        if (selection) {
          anchorPaneId = selection.anchorPaneId;
          splitDirection = selection.direction;
        }
      }
    }
  }

  const paneId = createTmuxSplitSurface(name, splitDirection, anchorPaneId);
  tmuxPanes.track(paneId);
  if (parentPaneId) {
    rebalanceTmuxLayoutForMode(parentPaneId);
  }
  return paneId;
}

export function createTmuxSplitSurface(
  _name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  const args = ["split-window", "-d"];
  if (direction === "left" || direction === "right") {
    args.push("-h");
  } else {
    args.push("-v");
  }
  if (direction === "left" || direction === "up") {
    args.push("-b");
  }
  if (fromSurface) {
    args.push("-t", fromSurface);
  }
  args.push("-P", "-F", "#{pane_id}");

  const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
  if (!pane.startsWith("%")) {
    throw new Error(`Unexpected tmux split-window output: ${pane}`);
  }

  return pane;
}

export function renameCurrentTab(title: string): void {
  if (process.env.PI_SUBAGENT_RENAME_TMUX_WINDOW !== "1") {
    return;
  }
  const paneId = process.env.TMUX_PANE;
  if (!paneId) throw new Error("TMUX_PANE not set");
  const windowId = execFileSync(
    "tmux",
    ["display-message", "-p", "-t", paneId, "#{window_id}"],
    {
      encoding: "utf8",
    },
  ).trim();
  execFileSync("tmux", ["rename-window", "-t", windowId, title], {
    encoding: "utf8",
  });
  return;
}

export function renameWorkspace(title: string): void {
  if (process.env.PI_SUBAGENT_RENAME_TMUX_SESSION !== "1") {
    return;
  }

  const paneId = process.env.TMUX_PANE;
  if (!paneId) throw new Error("TMUX_PANE not set");
  const sessionId = execFileSync(
    "tmux",
    ["display-message", "-p", "-t", paneId, "#{session_id}"],
    {
      encoding: "utf8",
    },
  ).trim();
  execFileSync("tmux", ["rename-session", "-t", sessionId, title], {
    encoding: "utf8",
  });
  return;
}

export function sendCommand(surface: string, command: string): void {
  execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], {
    encoding: "utf8",
  });
  execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], {
    encoding: "utf8",
  });
  return;
}

export function sendEscape(surface: string): void {
  execFileSync("tmux", ["send-keys", "-t", surface, "Escape"], {
    encoding: "utf8",
  });
  return;
}

export function closeSurface(surface: string): void {
  execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
  // Rebalance the remaining subagent panes so they share the freed space.
  if (tmuxPanes.paneList().includes(surface)) {
    tmuxPanes.untrack(surface);
    const parentPaneId = process.env.TMUX_PANE;
    if (parentPaneId) {
      rebalanceTmuxLayoutForMode(parentPaneId);
    }
  }
  return;
}
