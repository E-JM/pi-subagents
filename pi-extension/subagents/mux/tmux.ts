// tmux backend: geometry, rebalancing, and pane ops.

import { execFileSync } from "node:child_process";
import {
  foreignPaneInGridArea,
  type GridRect,
  groupRegionOf,
  parentRatioFromEnv,
  placedPanes,
  planGridTargets,
  rectWithin,
  selectSpawnAnchor,
  subagentArea,
} from "./layout-grid.ts";
import { getSubagentLayoutMode } from "./layout-mode.ts";
import { createTrackedPaneList } from "./tracked-panes.ts";

export interface TmuxPaneGeometry {
  paneId: string;
  left: number;
  top: number;
  width: number;
  height: number;
  windowWidth: number;
  windowHeight: number;
}

const TMUX_GEOMETRY_FORMAT =
  "#{pane_id}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}|#{window_width}|#{window_height}";

export function parseTmuxPaneGeometry(output: string): TmuxPaneGeometry[] {
  const panes: TmuxPaneGeometry[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("|");
    if (parts.length < 7) continue;
    const [paneId, left, top, width, height, windowWidth, windowHeight] = parts;
    if (!paneId.startsWith("%")) continue;
    const nums = [left, top, width, height, windowWidth, windowHeight].map(
      Number,
    );
    if (nums.some((n) => !Number.isFinite(n))) continue;
    panes.push({
      paneId,
      left: nums[0],
      top: nums[1],
      width: nums[2],
      height: nums[3],
      windowWidth: nums[4],
      windowHeight: nums[5],
    });
  }
  return panes;
}

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

/** Tracked tmux subagent pane ids, in spawn order (defines grid fill order). */
function tmuxSubagentPaneList(): string[] {
  return tmuxPanes.paneList();
}

/** Replace the tracked tmux subagent pane list. Exported for tests. */
export function setTmuxSubagentPaneList(paneIds: string[]): void {
  tmuxPanes.setPaneList(paneIds);
}

const tmuxTrackPane = tmuxPanes.track;
const tmuxUntrackPane = tmuxPanes.untrack;

function tmuxParentRatio(): number {
  return parentRatioFromEnv("PI_SUBAGENT_TMUX_PARENT_RATIO");
}

/** One `tmux resize-pane -x` step: set the pane's absolute column count. */
export interface TmuxResizeOp {
  paneId: string;
  width: number;
}

/** A pane's geometry as a window-relative rect. */
function tmuxPaneRect(pane: TmuxPaneGeometry): GridRect {
  return {
    x: pane.left,
    y: pane.top,
    width: pane.width,
    height: pane.height,
  };
}

/**
 * The region this agent group owns: the bounding rect (window-relative) of
 * the parent pane and its tracked subagent panes, folded by boundingRect.
 * Foreign panes (another agent, user splits) are never split or resized;
 * the rebalance planners only ever measure and move inside this region.
 */
function tmuxGroupRegion(
  panes: TmuxPaneGeometry[],
  parent: TmuxPaneGeometry,
  trackedPaneIds?: string[],
): GridRect {
  return groupRegionOf(
    panes,
    tmuxPaneRect(parent),
    (pane) => pane.paneId,
    tmuxPaneRect,
    trackedPaneIds ?? tmuxSubagentPaneList(),
  );
}

/** Subagent area for tmux: right of the parent, inside the group region. */
function tmuxSubagentArea(
  panes: TmuxPaneGeometry[],
  parent: TmuxPaneGeometry,
): GridRect {
  return subagentArea(
    tmuxGroupRegion(panes, parent),
    parent.left + parent.width,
  );
}

/**
 * Slack (window cells) for tmux containment checks: pane geometry is integer
 * columns/rows, nudged by absolute resizes.
 */
const TMUX_RECT_TOLERANCE = 1;

/**
 * True when a pane lies fully inside `region` within tmux's integer-geometry
 * tolerance — the tmux pane adapter over rectWithin.
 */
function tmuxPaneInRegion(pane: TmuxPaneGeometry, region: GridRect): boolean {
  return rectWithin(tmuxPaneRect(pane), region, TMUX_RECT_TOLERANCE);
}

/**
 * Parent pane, group region, and the tracked full-height column cells right
 * of the parent for the single-row column layout, or null when there is
 * nothing to balance or a foreign pane sits inside the region (absolute
 * widths could not be honored without moving it).
 */
function tmuxColumnLayout(
  panes: TmuxPaneGeometry[],
  parentPaneId: string,
  trackedPaneIds?: string[],
): {
  parent: TmuxPaneGeometry;
  region: GridRect;
  cells: TmuxPaneGeometry[];
} | null {
  const parent = panes.find((pane) => pane.paneId === parentPaneId);
  if (!parent) return null;
  const region = tmuxGroupRegion(panes, parent, trackedPaneIds);
  if (!(region.width > 0)) return null;

  const tracked = new Set(trackedPaneIds ?? tmuxSubagentPaneList());
  const parentRight = parent.left + parent.width;
  const cells = panes
    .filter(
      (pane) =>
        tracked.has(pane.paneId) &&
        pane.paneId !== parentPaneId &&
        pane.left >= parentRight - 1 &&
        pane.height >= parent.height - 1 &&
        pane.top <= parent.top + 1,
    )
    .sort((a, b) => a.top - b.top || a.left - b.left);
  if (cells.length === 0) return null;
  // Absolute-width resizes cannot leave room for a foreign pane inside the
  // region — bail instead of squeezing it.
  const foreignInside = panes.some(
    (pane) =>
      pane.paneId !== parentPaneId &&
      !tracked.has(pane.paneId) &&
      tmuxPaneInRegion(pane, region),
  );
  if (foreignInside) return null;
  return { parent, region, cells };
}

/** Absolute-width resize toward `target`, or undefined when within 1 column. */
function tmuxWidthOp(
  paneId: string,
  current: number,
  target: number,
): TmuxResizeOp | undefined {
  if (Math.abs(current - target) <= 1) return undefined;
  return { paneId, width: target };
}

/**
 * Plan absolute-width resizes that lay the group region out as: parent at
 * `parentRatio` of the region on the left, every tracked full-height pane to
 * its right sharing the rest equally. `trackedPaneIds` defaults to the
 * process's tracked tmux panes. Returns no ops when the layout cannot be
 * balanced (see tmuxColumnLayout). Pure — no CLI calls.
 */
export function planTmuxRebalance(
  panes: TmuxPaneGeometry[],
  parentPaneId: string,
  parentRatio: number,
  trackedPaneIds?: string[],
): TmuxResizeOp[] {
  const layout = tmuxColumnLayout(panes, parentPaneId, trackedPaneIds);
  if (!layout) return [];
  const { parent, region, cells } = layout;

  const parentTarget = Math.round(parentRatio * region.width);
  const remaining = region.width - parentTarget;
  // Every cell needs at least two columns to be worth resizing.
  if (remaining < cells.length * 2) return [];

  const cellTarget = Math.floor(remaining / cells.length);
  const ops: TmuxResizeOp[] = [];
  const parentOp = tmuxWidthOp(parentPaneId, parent.width, parentTarget);
  if (parentOp) ops.push(parentOp);
  for (const cell of cells) {
    const op = tmuxWidthOp(cell.paneId, cell.width, cellTarget);
    if (op) ops.push(op);
  }
  return ops;
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
 * Rebalance: parent fixed width, subagents equal width. Second pass absorbs
 * any drift from tmux's size clamps. Best effort — never blocks spawning.
 */
function rebalanceTmuxSubagentLayout(parentPaneId: string): void {
  for (let pass = 0; pass < 2; pass++) {
    const panes = readTmuxPaneGeometry(parentPaneId);
    if (panes.length === 0) return;
    const ops = planTmuxRebalance(panes, parentPaneId, tmuxParentRatio());
    if (ops.length === 0) return;
    applyTmuxResizeOps(ops);
  }
}

/** One tmux resize step for the tiled grid: absolute width and/or height. */
export interface TmuxGridResizeOp {
  paneId: string;
  width?: number;
  height?: number;
}

/**
 * Target size along one axis, or undefined when no resize is needed: the pane
 * is within 1 of the target, or it already reaches past its target toward the
 * region's far edge (masonry panes tmux cannot shrink away from the edge).
 */
function tmuxAxisTarget(
  current: number,
  target: number,
  paneAtFarEdge: boolean,
  targetAtFarEdge: boolean,
): number | undefined {
  if (Math.abs(current - target) <= 1) return undefined;
  if (paneAtFarEdge && !targetAtFarEdge) return undefined;
  return Math.round(target);
}

/** Absolute width/height resize toward `cell`, or undefined when balanced. */
function tmuxGridPaneOp(
  pane: TmuxPaneGeometry,
  cell: GridRect,
  region: GridRect,
): TmuxGridResizeOp | undefined {
  const regionRight = region.x + region.width;
  const regionBottom = region.y + region.height;
  const width = tmuxAxisTarget(
    pane.width,
    cell.width,
    pane.left + pane.width >= regionRight - 1,
    cell.x + cell.width >= regionRight - 1,
  );
  const height = tmuxAxisTarget(
    pane.height,
    cell.height,
    pane.top + pane.height >= regionBottom - 1,
    cell.y + cell.height >= regionBottom - 1,
  );
  if (width === undefined && height === undefined) return undefined;
  return { paneId: pane.paneId, width, height };
}

/**
 * Plan absolute resizes that lay the group's region out as a tiled grid:
 * parent at `parentRatio` width on the left (full height), tracked panes
 * (fill order) in equal cells to its right. Foreign panes are never touched;
 * a foreign pane right of the parent inside the region bails the whole plan
 * (absolute widths cannot be honored around it). Masonry panes tmux cannot
 * shrink away from the region's far edge are left alone. Pure — no CLI calls.
 */
export function planTmuxGridRebalance(
  panes: TmuxPaneGeometry[],
  parentPaneId: string,
  trackedPaneIds: string[],
  parentRatio: number,
): TmuxGridResizeOp[] {
  const parent = panes.find((pane) => pane.paneId === parentPaneId);
  if (!parent) return [];
  const tracked = trackedPaneIds.filter((id) =>
    panes.some((pane) => pane.paneId === id),
  );
  // The group's own region: parent + tracked panes — never the whole window
  // when the tab is shared with foreign panes.
  const region = tmuxGroupRegion(panes, parent, tracked);
  if (!(region.width > 0) || !(region.height > 0)) return [];
  if (!(parent.width > 0)) return [];

  // A foreign pane right of the parent inside the region would get wrecked by
  // the rebalance — bail (see foreignPaneInGridArea).
  const parentRight = parent.left + parent.width;
  if (
    foreignPaneInGridArea(
      panes,
      parentPaneId,
      tracked,
      region,
      parentRight,
      (pane) => pane.paneId,
      (pane) => pane.left,
      (pane) => tmuxPaneInRegion(pane, region),
    )
  ) {
    return [];
  }
  const targets = planGridTargets(tracked, region, parentRatio);
  if (!targets) return [];

  const ops: TmuxGridResizeOp[] = [];
  if (Math.abs(parent.width - targets.parentRect.width) > 1) {
    ops.push({
      paneId: parentPaneId,
      width: Math.round(targets.parentRect.width),
    });
  }
  for (const [paneId, cell] of targets.cells) {
    const pane = panes.find((p) => p.paneId === paneId);
    const op = pane ? tmuxGridPaneOp(pane, cell, region) : undefined;
    if (op) ops.push(op);
  }
  return ops;
}

function applyTmuxGridResizeOps(ops: TmuxGridResizeOp[]): void {
  for (const op of ops) {
    try {
      // tmux resizes one axis at a time: `-x` sets columns, `-y` sets rows.
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

/**
 * Rebalance into the tiled grid: parent fixed width, tracked panes in equal
 * cells. Second pass absorbs any drift from tmux's size clamps. Best effort
 * — never blocks spawning.
 */
function rebalanceTmuxGridLayout(parentPaneId: string): void {
  const tracked = tmuxSubagentPaneList();
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

/**
 * Rebalance the tmux window in the configured layout mode (tiled grid or
 * equal-width columns). Best effort — never blocks spawning.
 */
function rebalanceTmuxLayoutForMode(parentPaneId: string): void {
  if (getSubagentLayoutMode() === "tiled") {
    rebalanceTmuxGridLayout(parentPaneId);
  } else {
    rebalanceTmuxSubagentLayout(parentPaneId);
  }
}

/**
 * Create a tmux subagent surface. The group (parent + tracked subagent
 * panes) only ever claims the parent's own panel: when the window is shared
 * with foreign panes, splits and rebalancing stay inside the group region.
 * In "columns" mode (default) the first subagent splits the parent and new
 * subagents split the rightmost tracked subagent pane; rebalancing keeps the
 * parent at `PI_SUBAGENT_TMUX_PARENT_RATIO` (default 0.4) of the group
 * region and all subagent panes equally wide. In "tiled" mode subagents fill
 * the gridDimsForCount grid (round(sqrt(n)) rows × ceil(n/rows) columns)
 * right of the parent: each spawn splits the pane covering the next grid
 * cell (right/down) and the grid is rebalanced afterwards.
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
        tmuxSubagentPaneList().filter((id) => known.has(id)),
      );
      const parent = panes.find((pane) => pane.paneId === parentPaneId);
      if (parent) {
        const tracked = tmuxSubagentPaneList();
        const placed = placedPanes(
          tracked,
          panes,
          (pane) => pane.paneId,
          tmuxPaneRect,
        );
        // Subagent area: right of the parent, clipped to the group region so
        // a shared-tab spawn never lands in a foreign pane. Tiled picks the
        // pane covering the next grid cell, columns the rightmost tracked
        // pane; null splits the parent.
        const selection = selectSpawnAnchor(
          placed,
          tmuxSubagentArea(panes, parent),
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
  tmuxTrackPane(paneId);
  if (parentPaneId) {
    rebalanceTmuxLayoutForMode(parentPaneId);
  }
  return paneId;
}

/**
 * Create a new tmux pane (split window) in the given direction.
 */
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
  if (tmuxSubagentPaneList().includes(surface)) {
    tmuxUntrackPane(surface);
    const parentPaneId = process.env.TMUX_PANE;
    if (parentPaneId) {
      rebalanceTmuxLayoutForMode(parentPaneId);
    }
  }
  return;
}
