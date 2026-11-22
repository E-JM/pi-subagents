import {
  foreignPaneInGridArea,
  type GridRect,
  groupRegionOf,
  type PaneReader,
  planGridTargets,
  rectWithin,
  subagentArea,
} from "../layout-grid.ts";

export interface TmuxPaneGeometry {
  paneId: string;
  left: number;
  top: number;
  width: number;
  height: number;
  windowWidth: number;
  windowHeight: number;
}

/** How the grid helpers read a tmux pane. */
export const TMUX_PANES: PaneReader<TmuxPaneGeometry> = {
  idOf: (pane) => pane.paneId,
  rectOf: tmuxPaneRect,
};

export function parseTmuxPaneGeometry(output: string): TmuxPaneGeometry[] {
  const panes: TmuxPaneGeometry[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("|");
    if (parts.length < 7) continue;
    const [paneId = "", left, top, width, height, windowWidth, windowHeight] =
      parts;
    if (!paneId.startsWith("%")) continue;
    const nums = [
      Number(left),
      Number(top),
      Number(width),
      Number(height),
      Number(windowWidth),
      Number(windowHeight),
    ] as const;
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

/** One `tmux resize-pane -x` step: set the pane's absolute column count. */
export interface TmuxResizeOp {
  paneId: string;
  width: number;
}

export function tmuxPaneRect(pane: TmuxPaneGeometry): GridRect {
  return {
    x: pane.left,
    y: pane.top,
    width: pane.width,
    height: pane.height,
  };
}

/** The group's region: the bounding rect of the parent and its tracked panes. */
function tmuxGroupRegion(
  panes: TmuxPaneGeometry[],
  parent: TmuxPaneGeometry,
  trackedPaneIds: string[],
): GridRect {
  return groupRegionOf(panes, tmuxPaneRect(parent), trackedPaneIds, TMUX_PANES);
}

export function tmuxSubagentArea(
  panes: TmuxPaneGeometry[],
  parent: TmuxPaneGeometry,
  trackedPaneIds: string[],
): GridRect {
  return subagentArea(
    tmuxGroupRegion(panes, parent, trackedPaneIds),
    parent.left + parent.width,
  );
}

/** Slack in cells: pane geometry is integer columns/rows, nudged by resizes. */
const TMUX_RECT_TOLERANCE = 1;

function tmuxPaneInRegion(pane: TmuxPaneGeometry, region: GridRect): boolean {
  return rectWithin(tmuxPaneRect(pane), region, TMUX_RECT_TOLERANCE);
}

/**
 * Parent, group region, and the tracked full-height column cells right of it,
 * or null when there is nothing to balance or a foreign pane sits inside the
 * region (absolute widths cannot be honored around it).
 */
function tmuxColumnLayout(
  panes: TmuxPaneGeometry[],
  parentPaneId: string,
  trackedPaneIds: string[],
): {
  parent: TmuxPaneGeometry;
  region: GridRect;
  cells: TmuxPaneGeometry[];
} | null {
  const parent = panes.find((pane) => pane.paneId === parentPaneId);
  if (!parent) return null;
  const region = tmuxGroupRegion(panes, parent, trackedPaneIds);
  if (!(region.width > 0)) return null;

  const tracked = new Set(trackedPaneIds);
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

  // Absolute widths cannot leave room for a foreign pane in the region.
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
 * Plan the column layout: parent at `parentRatio` of the region, tracked
 * full-height cells sharing the rest equally. Pure — no CLI calls.
 */
export function planTmuxRebalance(
  panes: TmuxPaneGeometry[],
  parentPaneId: string,
  parentRatio: number,
  trackedPaneIds: string[],
): TmuxResizeOp[] {
  const layout = tmuxColumnLayout(panes, parentPaneId, trackedPaneIds);
  if (!layout) return [];
  const { parent, region, cells } = layout;

  const parentTarget = Math.round(parentRatio * region.width);
  const remaining = region.width - parentTarget;
  // Each cell needs at least two columns to be worth resizing.
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

/** One tmux resize step for the tiled grid: absolute width and/or height. */
export interface TmuxGridResizeOp {
  paneId: string;
  width?: number;
  height?: number;
}

/**
 * Target size along one axis, or undefined when no resize is needed: within 1
 * of the target, or already past it toward the region's far edge (masonry
 * panes tmux cannot shrink away from the edge).
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
 * Plan the tiled grid: parent at `parentRatio` on the left, tracked panes in
 * equal cells to its right. Foreign panes are never touched; one right of the
 * parent inside the region bails the plan. Masonry panes tmux cannot shrink
 * away from the far edge are left alone. Pure — no CLI calls.
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
  const region = tmuxGroupRegion(panes, parent, tracked);
  if (!(region.width > 0) || !(region.height > 0)) return [];
  if (!(parent.width > 0)) return [];

  const parentRight = parent.left + parent.width;
  if (
    foreignPaneInGridArea({
      panes,
      parentPaneId,
      trackedPaneIds: tracked,
      parentRight,
      inRegion: (pane) => tmuxPaneInRegion(pane, region),
      reader: TMUX_PANES,
    })
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
