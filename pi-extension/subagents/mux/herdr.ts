// herdr backend: layout parsing, rebalancing, and pane ops.

import { execFileSync } from "node:child_process";
import { parseCmuxJson } from "./cmux-backend.ts";
import {
  foreignPaneInGridArea,
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
import { execFileAsync, sleepSync } from "./util.ts";

/** Extract the pane id from a herdr CLI JSON envelope (`pane split` / `tab create` output). */
export function parseHerdrPaneId(output: string, context: string): string {
  const parsed = parseCmuxJson(output);
  const paneId =
    parsed?.result?.pane?.pane_id ?? parsed?.result?.root_pane?.pane_id;
  if (typeof paneId !== "string" || paneId === "") {
    throw new Error(
      `Unexpected herdr ${context} output: ${output || "(empty)"}`,
    );
  }
  return paneId;
}

export interface HerdrRect {
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
  const parsed = parseCmuxJson(output) as {
    result?: { layout?: HerdrLayout };
  } | null;
  const layout = parsed?.result?.layout;
  if (!layout?.area || !Array.isArray(layout.panes)) return null;
  return layout;
}

function readHerdrLayout(paneId?: string): HerdrLayout | null {
  const args = ["pane", "layout"];
  if (paneId) args.push("--pane", paneId);
  try {
    return parseHerdrLayout(execFileSync("herdr", args, { encoding: "utf8" }));
  } catch {
    return null;
  }
}

/** Tracked herdr subagent panes; globalThis + Symbol.for so it survives /reload. */
const HERDR_SUBAGENT_PANES_KEY = Symbol.for(
  "pi-subagents/herdr-subagent-panes",
);

const herdrPanes = createTrackedPaneList(HERDR_SUBAGENT_PANES_KEY);

/** Tracked herdr subagent pane ids, in spawn order (grid fill order). */
function herdrSubagentPaneList(): string[] {
  return herdrPanes.paneList();
}

/** Replace the tracked herdr subagent pane list. Exported for tests. */
export function setHerdrSubagentPaneList(paneIds: string[]): void {
  herdrPanes.setPaneList(paneIds);
}

const herdrTrackPane = herdrPanes.track;
const herdrUntrackPane = herdrPanes.untrack;

function herdrParentRatio(): number {
  return parentRatioFromEnv("PI_SUBAGENT_HERDR_PARENT_RATIO");
}

/** Ratio deltas below this are treated as already-balanced (avoids rounding churn). */
const HERDR_RESIZE_EPSILON = 0.01;

/**
 * Divider movement so the low side holds `lowTarget / (lowTarget + highTarget)`;
 * null when the split is already balanced or the targets sum to zero.
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

/**
 * Pane a divider move is anchored on (herdr resolves ops by the anchor pane):
 * the leaf flush against the divider on the side the divider moves away from.
 */
function dividerAnchor(
  axis: GridAxis,
  delta: number,
  lowLeaves: HerdrLayoutPane[],
  highLeaves: HerdrLayoutPane[],
): { anchor: HerdrLayoutPane; grow: boolean } {
  const anchor =
    delta > 0
      ? [...lowLeaves].sort((a, b) => axis.low(b.rect) - axis.low(a.rect))[0]
      : [...highLeaves].sort((a, b) => axis.low(a.rect) - axis.low(b.rect))[0];
  return { anchor, grow: delta > 0 };
}

/** One `herdr pane resize` step: move the divider on the pane's `direction` side by `amount` (a ratio delta). */
export interface HerdrResizeOp {
  paneId: string;
  direction: "left" | "right" | "up" | "down";
  amount: number;
}

/**
 * Slack (cells) for herdr containment checks: herdr rect coordinates are
 * ratio-derived floats, so edges can drift off an integer cell grid.
 */
const HERDR_RECT_TOLERANCE = 1.5;

/**
 * True when a layout pane lies fully inside `rect` within herdr's
 * float-drift tolerance. The herdr pane adapter over rectWithin, shared by
 * the columns and grid rebalance planners.
 */
function paneInRect(pane: HerdrLayoutPane, rect: HerdrRect): boolean {
  return rectWithin(pane.rect, rect, HERDR_RECT_TOLERANCE);
}

/**
 * Shared guard for the herdr rebalance planners: sane region dimensions and a
 * full-height parent pane within the region (within tolerance — true for the
 * single-row column layout and the left parent grid strip alike). Returns the
 * pieces both planners start from, or null when rebalancing must be skipped.
 */
function herdrBalancePreflight(
  layout: HerdrLayout,
  parentPaneId: string,
  trackedPaneIds?: string[],
): { region: HerdrRect; parent: HerdrLayoutPane } | null {
  const parent = layout.panes.find((pane) => pane.pane_id === parentPaneId);
  if (!parent) return null;

  const region = herdrGroupRegion(layout, parent, trackedPaneIds);
  if (!(region.width > 0) || !(region.height > 0)) return null;
  // Balancing assumes the parent fills the region's full height.
  if (parent.rect.height < region.height - 2 || parent.rect.y > region.y + 2)
    return null;

  return { region, parent };
}

/**
 * Width target per pane for the single-row column layout: parent at
 * `parentRatio` of the group region, each tracked column cell sharing the
 * rest equally, foreign panes inside the region keeping their width.
 * Returns null when there is nothing to balance or the targets cannot fit.
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

  // Foreign panes inside the region (user splits, another agent's panes)
  // keep their width — the cells share what they leave. Foreign panes
  // outside the region are not part of the group's layout at all.
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
  // cells is non-empty here (cellIds.size === 0 returned above). If their
  // combined share shrinks to a sliver, the layout cannot be balanced —
  // leave it alone.
  if (!(remaining > 5)) return null;
  const cellTarget = remaining / cells.length;

  return (pane: HerdrLayoutPane): number => {
    if (pane.pane_id === parentPaneId) return parentTarget;
    if (cellIds.has(pane.pane_id)) return cellTarget;
    return pane.rect.width; // anything else is foreign: keep current width
  };
}

/**
 * Walk the vertical splits inside `region` outermost-first, moving each
 * divider toward its side's width target. Empty when any divider move is
 * ambiguous — herdr could move either of two coincident dividers, so no op
 * can be trusted. Splits outside the region (dividers shared with foreign
 * panes) are never walked, so foreign panes cannot move.
 */
function herdrColumnDividerOps(
  layout: HerdrLayout,
  region: HerdrRect,
  targetWidth: (pane: HerdrLayoutPane) => number,
): HerdrResizeOp[] {
  // Outermost splits first, restricted to the group's own split subtree.
  const rightSplits = layout.splits.filter(
    (split) =>
      split.direction === "right" &&
      rectWithin(split.rect, region, HERDR_RECT_TOLERANCE),
  );
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

    const { anchor, grow } = dividerAnchor(
      AXIS_X,
      delta,
      leftLeaves,
      rightLeaves,
    );

    // The divider anchor must be flush against the divider — herdr resolves
    // the op by the anchor pane, so a non-adjacent pane would move the wrong
    // divider. Skip this split rather than guess.
    const anchorEdge = grow ? anchor.rect.x + anchor.rect.width : anchor.rect.x;
    if (Math.abs(anchorEdge - dividerX) > 1.5) continue;
    // A coincident divider from another split (possible in nested layouts,
    // e.g. a user split inside a column) makes the move ambiguous — herdr
    // could push either one — so abort the whole plan instead of resizing
    // an arbitrary pane.
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
 * Plan resizes that lay the group's region out as: parent at `parentRatio`
 * width on the left, every tracked column cell to its right sharing the rest
 * equally. Each split's ratio is targeted independently, so nesting depth
 * doesn't matter. The region is the bounding rect of the parent and its
 * tracked subagent panes; foreign panes (another agent, user splits — inside
 * or outside the region) are never moved. `trackedPaneIds` defaults to the
 * process's tracked herdr panes. Pure — no CLI calls.
 */
export function planHerdrRebalance(
  layout: HerdrLayout,
  parentPaneId: string,
  parentRatio: number,
  trackedPaneIds?: string[],
): HerdrResizeOp[] {
  const tracked = trackedPaneIds ?? herdrSubagentPaneList();
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

/**
 * True when another split's divider is coincident with `dividerX` while
 * overlapping `anchor` vertically — herdr could move either one, so the
 * resize is ambiguous and the whole plan must abort.
 */
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

/** Axis-specific accessors, so one planner serves both divider orientations. */
interface GridAxis {
  /** Low edge of a rect along this axis. */
  low: (rect: HerdrRect) => number;
  /** Extent of a rect along this axis. */
  size: (rect: HerdrRect) => number;
  /** Sub-rect of `split.rect` spanning `[low, low + size)` along this axis. */
  subRect: (split: HerdrLayoutSplit, low: number, size: number) => HerdrRect;
  /** herdr resize direction that moves the divider toward larger coordinates. */
  growDirection: "right" | "down";
  /** herdr resize direction that moves the divider toward smaller coordinates. */
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
 * Bounding-box extent of the leaves' target rects along `axis` (stacked panes
 * share columns/rows, so summing extents would double-count).
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
 * Plan resize ops for one axis's dividers: each divider moves so its low side
 * holds `lowTarget / (lowTarget + highTarget)` of the split ratio, where the
 * side targets are bounding-box extents of the leaves' target rects (stacked
 * panes share columns/rows, so summing extents would double-count). Splits
 * are processed largest-area first. A split is skipped when either side has
 * no leaves, the targets sum to zero, or the chosen anchor pane isn't flush
 * against the divider — herdr resolves ops by the anchor pane, so aligned
 * grids with coincident dividers across columns are safe; a non-adjacent
 * anchor is not.
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

    const { anchor, grow } = dividerAnchor(axis, delta, lowLeaves, highLeaves);

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
 * Plan resizes that lay the group's region out as a tiled grid: parent at
 * `parentRatio` width on the left, tracked panes (fill order) in the
 * `gridDimsForCount` grid (round(sqrt(n)) rows × ceil(n/rows) columns) of
 * equal cells to its right. The region is the bounding rect of the parent
 * and its tracked panes — foreign panes are never touched, and a foreign
 * pane right of the parent inside the region bails the whole plan. Handles
 * both right-splits (vertical dividers) and down-splits (horizontal
 * dividers). Pure — no CLI calls.
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
    foreignPaneInGridArea(
      layout.panes,
      parentPaneId,
      tracked,
      region,
      parentRight,
      (pane) => pane.pane_id,
      (pane) => pane.rect.x,
      (pane) => paneInRect(pane, region),
    )
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
  // Only the group's own split subtree: dividers shared with foreign panes
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

function applyHerdrResizeOps(ops: HerdrResizeOp[]): void {
  for (const op of ops) {
    try {
      execFileSync(
        "herdr",
        [
          "pane",
          "resize",
          "--pane",
          op.paneId,
          "--direction",
          op.direction,
          "--amount",
          op.amount.toFixed(4),
        ],
        { encoding: "utf8" },
      );
    } catch {
      // Best effort — herdr clamps ratios and refuses tiny moves.
    }
  }
}

/**
 * Rebalance: parent fixed width, subagents equal width. Runs up to three
 * plan→apply passes against a fresh layout to absorb rounding and clamp
 * residuals. Best effort — never blocks spawning.
 */
function rebalanceHerdrSubagentLayout(parentPaneId: string): void {
  for (let pass = 0; pass < 3; pass++) {
    const layout = readHerdrLayout(parentPaneId);
    if (!layout) return;
    const ops = planHerdrRebalance(layout, parentPaneId, herdrParentRatio());
    if (ops.length === 0) return;
    applyHerdrResizeOps(ops);
  }
}

function herdrGroupRegion(
  layout: HerdrLayout,
  parent: HerdrLayoutPane,
  trackedPaneIds?: string[],
): HerdrRect {
  return groupRegionOf(
    layout.panes,
    parent.rect,
    (pane) => pane.pane_id,
    (pane) => pane.rect,
    trackedPaneIds ?? herdrSubagentPaneList(),
  );
}

/** Subagent area for herdr: right of the parent, inside the group region. */
function herdrSubagentArea(
  layout: HerdrLayout,
  parent: HerdrLayoutPane,
): HerdrRect {
  return subagentArea(
    herdrGroupRegion(layout, parent),
    parent.rect.x + parent.rect.width,
  );
}

/**
 * Read the layout, waiting briefly for herdr to materialize all tracked panes.
 * Under load (several pi instances launching at once), `pane layout` can lag a
 * split by a few ms — planning against a layout that is missing the new pane
 * would compute zero ops and leave the raw split geometry in place. Returns
 * null while the layout is incomplete or unreadable.
 */
function waitForHerdrTrackedPanes(
  parentPaneId: string,
  timeoutMs = 500,
): HerdrLayout | null {
  const tracked = herdrSubagentPaneList();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const layout = readHerdrLayout(parentPaneId);
    if (layout) {
      const present = new Set(layout.panes.map((pane) => pane.pane_id));
      if (tracked.every((id) => present.has(id))) return layout;
    }
    sleepSync(50);
  }
  return null;
}

/**
 * Rebalance into the tiled grid. Runs up to three plan→apply passes against a
 * fresh layout to absorb rounding and clamp residuals. Best effort — never
 * blocks spawning.
 */
function rebalanceHerdrGridLayout(parentPaneId: string): void {
  const tracked = herdrSubagentPaneList();
  if (tracked.length === 0) return;
  for (let pass = 0; pass < 3; pass++) {
    const layout =
      pass === 0
        ? waitForHerdrTrackedPanes(parentPaneId)
        : readHerdrLayout(parentPaneId);
    if (!layout) return;
    const ops = planHerdrGridRebalance(
      layout,
      parentPaneId,
      tracked,
      herdrParentRatio(),
    );
    if (ops.length === 0) return;
    applyHerdrResizeOps(ops);
  }
}

const HERDR_DEFERRED_REBALANCE_KEY = Symbol.for(
  "pi-subagents/herdr-deferred-rebalance",
);

/**
 * Schedule trailing rebalances ~400ms apart (coalesced). Safety net for races:
 * whichever spawn or close ran last, these passes re-read the settled layout
 * and equalize anything the synchronous rebalance missed. Stops after 5 passes
 * once the plan reports nothing left to do; while the layout keeps failing to
 * read, retries up to 10 ticks before giving up.
 */
function scheduleHerdrDeferredRebalance(parentPaneId: string): void {
  const store = globalThis as Record<symbol, unknown>;
  const existing = store[HERDR_DEFERRED_REBALANCE_KEY] as
    | NodeJS.Timeout
    | undefined;
  if (existing) clearTimeout(existing);

  let attempts = 0;

  function tick(): void {
    attempts += 1;
    try {
      const tiled = getSubagentLayoutMode() === "tiled";
      const tracked = herdrSubagentPaneList();
      // "Zero ops" only counts as converged when the layout actually shows
      // every tracked pane — a stale read must keep retrying, not stop.
      const layout =
        tiled && tracked.length > 0
          ? waitForHerdrTrackedPanes(parentPaneId, 300)
          : readHerdrLayout(parentPaneId);
      if (!layout) {
        if (attempts >= 10) stop();
        else scheduleNext();
        return;
      }
      const ops = tiled
        ? planHerdrGridRebalance(
            layout,
            parentPaneId,
            tracked,
            herdrParentRatio(),
          )
        : planHerdrRebalance(layout, parentPaneId, herdrParentRatio());
      if (ops.length > 0) applyHerdrResizeOps(ops);
      if (ops.length === 0 || attempts >= 5) {
        stop();
        return;
      }
    } catch {
      // Best effort — never surface deferred-rebalance failures.
    }
    scheduleNext();
  }

  function scheduleNext(): void {
    const timer = setTimeout(tick, 400);
    timer.unref?.();
    store[HERDR_DEFERRED_REBALANCE_KEY] = timer;
  }

  function stop(): void {
    delete store[HERDR_DEFERRED_REBALANCE_KEY];
  }

  scheduleNext();
}

/**
 * Rebalance the herdr tab in the configured layout mode (tiled grid or
 * equal-width columns). Best effort — never blocks spawning.
 */
function rebalanceHerdrLayoutForMode(parentPaneId: string): void {
  if (getSubagentLayoutMode() === "tiled") {
    rebalanceHerdrGridLayout(parentPaneId);
  } else {
    rebalanceHerdrSubagentLayout(parentPaneId);
  }
}

/**
 * Create a herdr subagent surface. The group (parent + tracked subagent
 * panes) only ever claims the parent's own panel: when the tab is shared
 * with foreign panes, splits and rebalancing stay inside the group region.
 * In "columns" mode (default) the first subagent splits the parent and new
 * subagents split the rightmost tracked subagent pane; rebalancing keeps the
 * parent at `PI_SUBAGENT_HERDR_PARENT_RATIO` (default 0.4) of the group
 * region and all subagent panes equally wide. In "tiled" mode subagents fill
 * the gridDimsForCount grid (round(sqrt(n)) rows × ceil(n/rows) columns)
 * right of the parent: each spawn splits the pane covering the next grid
 * cell (right/down) and the grid is rebalanced afterwards.
 */
export function createHerdrSubagentSurface(name: string): string {
  const parentPaneId = process.env.HERDR_PANE_ID;
  const tiled = getSubagentLayoutMode() === "tiled";

  let anchorPaneId = parentPaneId ?? undefined;
  let splitDirection: "right" | "down" = "right";

  if (parentPaneId) {
    const layout = readHerdrLayout(parentPaneId);
    if (layout) {
      const known = new Set(layout.panes.map((pane) => pane.pane_id));
      setHerdrSubagentPaneList(
        herdrSubagentPaneList().filter((id) => known.has(id)),
      );
      const parent = layout.panes.find((pane) => pane.pane_id === parentPaneId);
      if (parent) {
        const tracked = herdrSubagentPaneList();
        const placed = placedPanes(
          tracked,
          layout.panes,
          (pane) => pane.pane_id,
          (pane) => pane.rect,
        );
        // Tiled: the pane covering the next grid cell. Columns (or tiled
        // fallback): the rightmost tracked pane. Null: split the parent —
        // never a foreign pane.
        const selection = selectSpawnAnchor(
          placed,
          herdrSubagentArea(layout, parent),
          parent.rect.x + parent.rect.width,
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

  const paneId = createHerdrSplitSurface(name, splitDirection, anchorPaneId);
  herdrTrackPane(paneId);
  if (parentPaneId) {
    rebalanceHerdrLayoutForMode(parentPaneId);
    scheduleHerdrDeferredRebalance(parentPaneId);
  }
  return paneId;
}

/** Whether herdr currently detects a working agent turn in the given pane. */
export function isHerdrAgentWorking(surface: string): Promise<boolean> {
  return execFileAsync("herdr", ["agent", "get", surface], { encoding: "utf8" })
    .then(
      ({ stdout }) =>
        JSON.parse(stdout)?.result?.agent?.agent_status === "working",
    )
    .catch(() => false);
}

/**
 * Create a new herdr pane (split) in the given direction; left/up fall back
 * to the nearest equivalent (right/down).
 */
export function createHerdrSplitSurface(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  // herdr supports only right/down splits; left/up fall back to the nearest equivalent.
  const herdrDirection =
    direction === "left" || direction === "right" ? "right" : "down";
  const args = [
    "pane",
    "split",
    "--direction",
    herdrDirection,
    "--no-focus",
    "--cwd",
    process.cwd(),
  ];
  const anchor = fromSurface ?? process.env.HERDR_PANE_ID;
  if (anchor) {
    args.push("--pane", anchor);
  }
  const output = execFileSync("herdr", args, { encoding: "utf8" }).trim();
  const paneId = parseHerdrPaneId(output, "pane split");
  execFileSync("herdr", ["pane", "rename", paneId, name], {
    encoding: "utf8",
  });
  return paneId;
}

export function renameCurrentTab(title: string): void {
  const paneId = process.env.HERDR_PANE_ID;
  if (!paneId) throw new Error("HERDR_PANE_ID not set");
  execFileSync("herdr", ["pane", "rename", paneId, title], {
    encoding: "utf8",
  });
  return;
}

export function renameWorkspace(title: string): void {
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  if (!workspaceId) throw new Error("HERDR_WORKSPACE_ID not set");
  execFileSync("herdr", ["workspace", "rename", workspaceId, title], {
    encoding: "utf8",
  });
  return;
}

export function sendCommand(surface: string, command: string): void {
  execFileSync("herdr", ["pane", "send-text", surface, command], {
    encoding: "utf8",
  });
  execFileSync("herdr", ["pane", "send-keys", surface, "Enter"], {
    encoding: "utf8",
  });
  return;
}

export function sendEscape(surface: string): void {
  execFileSync("herdr", ["pane", "send-keys", surface, "esc"], {
    encoding: "utf8",
  });
  return;
}

export function closeSurface(surface: string): void {
  execFileSync("herdr", ["pane", "close", surface], { encoding: "utf8" });
  // Rebalance the remaining subagent panes so they share the freed space.
  if (herdrSubagentPaneList().includes(surface)) {
    herdrUntrackPane(surface);
    const parentPaneId = process.env.HERDR_PANE_ID;
    if (parentPaneId) {
      rebalanceHerdrLayoutForMode(parentPaneId);
      scheduleHerdrDeferredRebalance(parentPaneId);
    }
  }
  return;
}
