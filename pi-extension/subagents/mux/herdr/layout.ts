import { parseCliJson } from "../cli.ts";
import {
  foreignPaneInGridArea,
  groupRegionOf,
  type PaneReader,
  planGridTargets,
  rectWithin,
  subagentArea,
} from "../layout-grid.ts";

/** How the grid helpers read a herdr pane. */
export const HERDR_PANES: PaneReader<HerdrLayoutPane> = {
  idOf: (pane) => pane.pane_id,
  rectOf: (pane) => pane.rect,
};

/** Envelope shape only; every field is verified where it is used. */
interface HerdrEnvelope {
  result?: {
    pane?: { pane_id?: unknown };
    root_pane?: { pane_id?: unknown };
    layout?: HerdrLayout;
  };
}

function parseHerdrEnvelope(output: string): HerdrEnvelope | null {
  const parsed = parseCliJson(output);
  if (!parsed || typeof parsed !== "object") return null;
  return parsed as HerdrEnvelope;
}

export function parseHerdrPaneId(output: string, context: string): string {
  const result = parseHerdrEnvelope(output)?.result;
  const paneId = result?.pane?.pane_id ?? result?.root_pane?.pane_id;
  if (typeof paneId !== "string" || paneId === "") {
    throw new Error(
      `Unexpected herdr ${context} output: ${output || "(empty)"}`,
    );
  }
  return paneId;
}

interface HerdrRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HerdrLayoutPane {
  pane_id: string;
  rect: HerdrRect;
}

export interface HerdrLayoutSplit {
  id: string;
  direction: "right" | "down";
  ratio: number;
  rect: HerdrRect;
}

export interface HerdrLayout {
  area: HerdrRect;
  panes: HerdrLayoutPane[];
  splits: HerdrLayoutSplit[];
  tab_id?: string;
  zoomed?: boolean;
}

export function parseHerdrLayout(output: string): HerdrLayout | null {
  const layout = parseHerdrEnvelope(output)?.result?.layout;
  if (!layout?.area || !Array.isArray(layout.panes)) return null;
  return layout;
}

/** Ratio deltas below this count as balanced; smaller moves only churn. */
const HERDR_RESIZE_EPSILON = 0.01;

/**
 * Move so the low side holds `lowTarget / (lowTarget + highTarget)`, or null
 * when the split is already balanced or both targets are zero.
 */
function dividerDelta(
  lowTarget: number,
  highTarget: number,
  ratio: number,
): number | null {
  if (!(lowTarget + highTarget > 0)) return null;
  const delta = lowTarget / (lowTarget + highTarget) - ratio;
  if (Math.abs(delta) < HERDR_RESIZE_EPSILON) return null;
  return delta;
}

/** The leaf flush against the divider on the side it moves away from. */
function dividerAnchor(
  axis: GridAxis,
  delta: number,
  lowLeaves: HerdrLayoutPane[],
  highLeaves: HerdrLayoutPane[],
): { anchor: HerdrLayoutPane; grow: boolean } | null {
  const grow = delta > 0;
  const leaves = grow ? lowLeaves : highLeaves;
  const anchor = leaves.reduce<HerdrLayoutPane | null>(
    (best, pane) =>
      best === null ||
      (grow
        ? axis.low(pane.rect) > axis.low(best.rect)
        : axis.low(pane.rect) < axis.low(best.rect))
        ? pane
        : best,
    null,
  );
  return anchor ? { anchor, grow } : null;
}

/** One `herdr pane resize` step; `amount` is a ratio delta. */
export interface HerdrResizeOp {
  paneId: string;
  direction: "left" | "right" | "up" | "down";
  amount: number;
}

/** Slack in cells: herdr rects are ratio-derived floats, so edges drift. */
const HERDR_RECT_TOLERANCE = 1.5;

function paneInRect(pane: HerdrLayoutPane, rect: HerdrRect): boolean {
  return rectWithin(pane.rect, rect, HERDR_RECT_TOLERANCE);
}

/**
 * Both rebalance planners assume a sane region and a full-height parent in it;
 * returns those two pieces, or null when rebalancing must be skipped.
 */
function herdrBalancePreflight(
  layout: HerdrLayout,
  parentPaneId: string,
  trackedPaneIds: string[],
): { region: HerdrRect; parent: HerdrLayoutPane } | null {
  const parent = layout.panes.find((pane) => pane.pane_id === parentPaneId);
  if (!parent) return null;

  const region = herdrGroupRegion(layout, parent, trackedPaneIds);
  if (!(region.width > 0) || !(region.height > 0)) return null;
  if (parent.rect.height < region.height - 2 || parent.rect.y > region.y + 2)
    return null;

  return { region, parent };
}

/**
 * Width targets for the single-row column layout: parent at `parentRatio`,
 * tracked cells sharing the rest equally, foreign panes keeping their width.
 * Null when there is nothing to balance or no room for it.
 */
function herdrColumnTargets(
  layout: HerdrLayout,
  parentPaneId: string,
  parent: HerdrLayoutPane,
  region: HerdrRect,
  parentRatio: number,
  trackedPaneIds: string[],
): ((pane: HerdrLayoutPane) => number) | null {
  const tracked = new Set(trackedPaneIds);
  // Column cells: tracked, full-height panes starting at/after the parent's
  // right edge.
  const parentRight = parent.rect.x + parent.rect.width;
  const cells = layout.panes
    .filter(
      (pane) =>
        tracked.has(pane.pane_id) &&
        pane.pane_id !== parentPaneId &&
        pane.rect.x >= parentRight - 1 &&
        pane.rect.height >= region.height - 2 &&
        pane.rect.y <= region.y + 2,
    )
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);

  // Foreign panes inside the region keep their width; the cells share what
  // they leave. Foreign panes outside it are not part of the layout at all.
  const cellIds = new Set(cells.map((cell) => cell.pane_id));
  if (cellIds.size === 0) return null; // nothing to balance
  const frozenSum = layout.panes
    .filter(
      (pane) =>
        pane.pane_id !== parentPaneId &&
        !cellIds.has(pane.pane_id) &&
        paneInRect(pane, region),
    )
    .reduce((sum, pane) => sum + pane.rect.width, 0);

  const parentTarget = parentRatio * region.width;
  const remaining = region.width - parentTarget - frozenSum;
  // cells is non-empty here; if their share shrinks to a sliver, leave it alone.
  if (!(remaining > 5)) return null;
  const cellTarget = remaining / cells.length;

  return (pane: HerdrLayoutPane): number => {
    if (pane.pane_id === parentPaneId) return parentTarget;
    if (cellIds.has(pane.pane_id)) return cellTarget;
    return pane.rect.width; // foreign: keep current width
  };
}

/**
 * Move each vertical split in `region` toward its width target, outermost first.
 * Any ambiguous move yields no ops at all; splits outside the region are never
 * walked, so foreign panes cannot move.
 */
function herdrColumnDividerOps(
  layout: HerdrLayout,
  region: HerdrRect,
  targetWidth: (pane: HerdrLayoutPane) => number,
): HerdrResizeOp[] {
  const rightSplits = layout.splits.filter(
    (split) =>
      split.direction === "right" &&
      rectWithin(split.rect, region, HERDR_RECT_TOLERANCE),
  );
  // Outermost first, so inner dividers are measured against settled geometry.
  const splits = [...rightSplits].sort(
    (a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height,
  );

  let ambiguous = false;
  const ops: HerdrResizeOp[] = [];

  for (const split of splits) {
    const dividerX = split.rect.x + split.rect.width * split.ratio;
    const leftRect: HerdrRect = {
      x: split.rect.x,
      y: split.rect.y,
      width: dividerX - split.rect.x,
      height: split.rect.height,
    };
    const rightRect: HerdrRect = {
      x: dividerX,
      y: split.rect.y,
      width: split.rect.x + split.rect.width - dividerX,
      height: split.rect.height,
    };
    const leftLeaves = layout.panes.filter((pane) =>
      paneInRect(pane, leftRect),
    );
    const rightLeaves = layout.panes.filter((pane) =>
      paneInRect(pane, rightRect),
    );
    if (leftLeaves.length === 0 || rightLeaves.length === 0) continue;

    const leftTarget = leftLeaves.reduce(
      (sum, pane) => sum + targetWidth(pane),
      0,
    );
    const rightTarget = rightLeaves.reduce(
      (sum, pane) => sum + targetWidth(pane),
      0,
    );
    const delta = dividerDelta(leftTarget, rightTarget, split.ratio);
    if (delta === null) continue;

    const anchored = dividerAnchor(AXIS_X, delta, leftLeaves, rightLeaves);
    if (!anchored) continue;
    const { anchor, grow } = anchored;

    // herdr resolves the op by the anchor pane, so a non-adjacent anchor would
    // move the wrong divider. Skip the split rather than guess.
    const anchorEdge = grow ? anchor.rect.x + anchor.rect.width : anchor.rect.x;
    if (Math.abs(anchorEdge - dividerX) > 1.5) continue;
    // Two coincident dividers mean herdr could push either one; abort the whole
    // plan instead of resizing an arbitrary pane.
    if (hasCoincidentDivider(rightSplits, split, anchor, dividerX)) {
      ambiguous = true;
      break;
    }

    ops.push({
      paneId: anchor.pane_id,
      direction: grow ? "right" : "left",
      amount: grow ? delta : -delta,
    });
  }
  return ambiguous ? [] : ops;
}

/**
 * Plan the column layout: parent at `parentRatio` on the left, tracked cells
 * sharing the rest equally. Each split is targeted independently, so nesting
 * depth does not matter. Pure — no CLI calls.
 */
export function planHerdrRebalance(
  layout: HerdrLayout,
  parentPaneId: string,
  parentRatio: number,
  trackedPaneIds: string[],
): HerdrResizeOp[] {
  const tracked = trackedPaneIds;
  const pre = herdrBalancePreflight(layout, parentPaneId, tracked);
  if (!pre) return [];
  const targetWidth = herdrColumnTargets(
    layout,
    parentPaneId,
    pre.parent,
    pre.region,
    parentRatio,
    tracked,
  );
  if (!targetWidth) return [];
  return herdrColumnDividerOps(layout, pre.region, targetWidth);
}

function hasCoincidentDivider(
  rightSplits: HerdrLayoutSplit[],
  split: HerdrLayoutSplit,
  anchor: HerdrLayoutPane,
  dividerX: number,
): boolean {
  const overlapsY = (rect: HerdrRect): boolean =>
    anchor.rect.y < rect.y + rect.height + 1.5 &&
    anchor.rect.y + anchor.rect.height > rect.y - 1.5;
  for (const other of rightSplits) {
    if (other === split) continue;
    if (!overlapsY(other.rect)) continue;
    const otherX = other.rect.x + other.rect.width * other.ratio;
    if (Math.abs(otherX - dividerX) <= 1.5) return true;
  }
  return false;
}

/** Axis-specific accessors, so one planner serves both orientations. */
interface GridAxis {
  low: (rect: HerdrRect) => number;
  size: (rect: HerdrRect) => number;
  /** Sub-rect of `split.rect` spanning `[low, low + size)` along this axis. */
  subRect: (split: HerdrLayoutSplit, low: number, size: number) => HerdrRect;
  growDirection: "right" | "down";
  shrinkDirection: "left" | "up";
}

const AXIS_X: GridAxis = {
  low: (rect) => rect.x,
  size: (rect) => rect.width,
  subRect: (split, low, size) => ({
    x: low,
    y: split.rect.y,
    width: size,
    height: split.rect.height,
  }),
  growDirection: "right",
  shrinkDirection: "left",
};

const AXIS_Y: GridAxis = {
  low: (rect) => rect.y,
  size: (rect) => rect.height,
  subRect: (split, low, size) => ({
    x: split.rect.x,
    y: low,
    width: split.rect.width,
    height: size,
  }),
  growDirection: "down",
  shrinkDirection: "up",
};

/**
 * Bounding-box extent of the leaves' target rects along `axis`: stacked panes
 * share columns/rows, so summing their extents would double-count.
 */
function dividerSideExtent(
  axis: GridAxis,
  leaves: HerdrLayoutPane[],
  targetRectOf: (pane: HerdrLayoutPane) => HerdrRect,
): number {
  let low = Infinity;
  let high = -Infinity;
  for (const leaf of leaves) {
    const rect = targetRectOf(leaf);
    low = Math.min(low, axis.low(rect));
    high = Math.max(high, axis.low(rect) + axis.size(rect));
  }
  return Number.isFinite(low) ? high - low : 0;
}

/**
 * Move each split's divider so its low side holds its share of the target
 * extent, skipping splits with no leaves, zero targets, or an anchor that is
 * not flush against the divider (herdr resolves ops by the anchor pane).
 */
function planDividerOps(
  axis: GridAxis,
  splits: HerdrLayoutSplit[],
  layout: HerdrLayout,
  targetRectOf: (pane: HerdrLayoutPane) => HerdrRect,
): HerdrResizeOp[] {
  const ops: HerdrResizeOp[] = [];

  for (const split of splits) {
    const start = axis.low(split.rect);
    const span = axis.size(split.rect);
    const divider = start + span * split.ratio;
    const lowLeaves = layout.panes.filter((pane) =>
      paneInRect(pane, axis.subRect(split, start, divider - start)),
    );
    const highLeaves = layout.panes.filter((pane) =>
      paneInRect(pane, axis.subRect(split, divider, start + span - divider)),
    );
    if (lowLeaves.length === 0 || highLeaves.length === 0) continue;

    const delta = dividerDelta(
      dividerSideExtent(axis, lowLeaves, targetRectOf),
      dividerSideExtent(axis, highLeaves, targetRectOf),
      split.ratio,
    );
    if (delta === null) continue;

    const anchored = dividerAnchor(axis, delta, lowLeaves, highLeaves);
    if (!anchored) continue;
    const { anchor, grow } = anchored;

    const anchorEdge = grow
      ? axis.low(anchor.rect) + axis.size(anchor.rect)
      : axis.low(anchor.rect);
    if (Math.abs(anchorEdge - divider) > 1.5) continue;

    ops.push({
      paneId: anchor.pane_id,
      direction: grow ? axis.growDirection : axis.shrinkDirection,
      amount: grow ? delta : -delta,
    });
  }
  return ops;
}

/**
 * Plan the tiled grid: parent at `parentRatio` on the left, tracked panes
 * (fill order) in equal grid cells to its right. A foreign pane right of the
 * parent inside the region bails the whole plan. Pure — no CLI calls.
 */
export function planHerdrGridRebalance(
  layout: HerdrLayout,
  parentPaneId: string,
  trackedPaneIds: string[],
  parentRatio: number,
): HerdrResizeOp[] {
  const pre = herdrBalancePreflight(layout, parentPaneId, trackedPaneIds);
  if (!pre) return [];
  const { region, parent } = pre;
  const ops: HerdrResizeOp[] = [];

  const tracked = trackedPaneIds.filter((id) =>
    layout.panes.some((pane) => pane.pane_id === id),
  );
  const parentRight = parent.rect.x + parent.rect.width;
  if (
    foreignPaneInGridArea({
      panes: layout.panes,
      parentPaneId,
      trackedPaneIds: tracked,
      parentRight,
      inRegion: (pane) => paneInRect(pane, region),
      reader: HERDR_PANES,
    })
  ) {
    return ops;
  }
  const targets = planGridTargets(tracked, region, parentRatio);
  if (!targets) return ops;

  const targetRectOf = (pane: HerdrLayoutPane): HerdrRect => {
    if (pane.pane_id === parentPaneId) return targets.parentRect;
    return targets.cells.get(pane.pane_id) ?? pane.rect; // foreign: frozen
  };

  const byAreaDesc = (a: HerdrLayoutSplit, b: HerdrLayoutSplit): number =>
    b.rect.width * b.rect.height - a.rect.width * a.rect.height;
  // Only the group's own split subtree; dividers shared with foreign panes
  // must never move.
  const inRegion = (split: HerdrLayoutSplit): boolean =>
    rectWithin(split.rect, region, HERDR_RECT_TOLERANCE);
  const verticalDividers = layout.splits
    .filter((split) => split.direction === "right" && inRegion(split))
    .sort(byAreaDesc);
  const horizontalDividers = layout.splits
    .filter((split) => split.direction === "down" && inRegion(split))
    .sort(byAreaDesc);

  ops.push(
    ...planDividerOps(AXIS_X, verticalDividers, layout, targetRectOf),
    ...planDividerOps(AXIS_Y, horizontalDividers, layout, targetRectOf),
  );
  return ops;
}

function herdrGroupRegion(
  layout: HerdrLayout,
  parent: HerdrLayoutPane,
  trackedPaneIds: string[],
): HerdrRect {
  return groupRegionOf(layout.panes, parent.rect, trackedPaneIds, HERDR_PANES);
}

export function herdrSubagentArea(
  layout: HerdrLayout,
  parent: HerdrLayoutPane,
  trackedPaneIds: string[],
): HerdrRect {
  return subagentArea(
    herdrGroupRegion(layout, parent, trackedPaneIds),
    parent.rect.x + parent.rect.width,
  );
}
