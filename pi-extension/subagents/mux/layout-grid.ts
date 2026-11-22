// Tiled grid geometry and shared layout primitives (used by herdr and tmux).

/** Default fraction of the tab width reserved for the parent (main agent) pane. */
export const DEFAULT_SUBAGENT_PARENT_RATIO = 0.4;

export function parentRatioFromEnv(envName: string): number {
  const value = Number(process.env[envName]);
  return Number.isFinite(value) && value >= 0.1 && value <= 0.9
    ? value
    : DEFAULT_SUBAGENT_PARENT_RATIO;
}

// --- Tiled grid geometry (shared by herdr and tmux) ---

/** Rectangle in tab/window coordinates. */
export interface GridRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Smallest rectangle covering every input rect. The one bounding fold behind
 * both backends' group regions: callers always seed it with the parent pane's
 * rect, so a solo parent yields exactly its own rect (the whole tab only when
 * nothing else is in it). Input is never empty in practice; the Infinity
 * edges of an empty fold are garbage by contract.
 */
function boundingRect(rects: GridRect[]): GridRect {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export interface GridDims {
  cols: number;
  rows: number;
}

/**
 * Grid shape for `count` subagents. Rows = round(sqrt(count)), grown one axis
 * at a time: 1×1 → 1×2 → 2×2 → 2×3 → 3×3 → 3×4 → 4×4 … so existing panes
 * never need to change cells when the grid grows (binary split trees can
 * only move dividers, not reflow panes).
 */
export function gridDimsForCount(count: number): GridDims {
  const n = Math.max(1, count);
  const rows = Math.max(1, Math.round(Math.sqrt(n)));
  const cols = Math.max(1, Math.ceil(n / rows));
  return { cols, rows };
}

/**
 * How the grid grew at exactly `count` (compared to `count - 1`): "col" when
 * a column was added, "row" when a row was added, null when the shape is
 * unchanged (and for count < 2).
 */
function gridGrowthAt(count: number): "col" | "row" | null {
  const prev = gridDimsForCount(count - 1);
  const cur = gridDimsForCount(count);
  if (cur.cols > prev.cols) return "col";
  if (cur.rows > prev.rows) return "row";
  return null;
}

/**
 * Which axis the grid last grew on at or before `count`: "col" (2,5,10,17…),
 * "row" (3,7,13…), or null when the grid is exactly full. Unclaimed cells
 * left by a growth are absorbed by the neighbor pane on that axis.
 */
function lastGridGrowth(count: number): "col" | "row" | null {
  for (let n = count; n >= 2; n--) {
    const growth = gridGrowthAt(n);
    if (growth) return growth;
  }
  return null;
}

/** First unclaimed cell in row-major scan order (origin as the fallback). */
function firstFreeCell(
  claimed: Set<string>,
  rows: number,
  cols: number,
): { row: number; col: number } {
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (!claimed.has(`${row},${col}`)) return { row, col };
    }
  }
  return { row: 0, col: 0 };
}

/**
 * Cell (row, col) claimed by each of the first `count` spawns, in order.
 * Every pane keeps its cell as the grid grows: a growth spawn claims the new
 * column's top cell or the new row's left cell; other spawns take the first
 * free cell in scan order.
 */
function spawnSlots(count: number): { row: number; col: number }[] {
  const slots: { row: number; col: number }[] = [];
  const claimed = new Set<string>();
  for (let k = 1; k <= count; k++) {
    const { cols, rows } = gridDimsForCount(k);
    let slot: { row: number; col: number };
    switch (gridGrowthAt(k)) {
      case "col":
        slot = { row: 0, col: cols - 1 };
        break;
      case "row":
        slot = { row: rows - 1, col: 0 };
        break;
      default:
        slot = firstFreeCell(claimed, rows, cols);
    }
    claimed.add(`${slot.row},${slot.col}`);
    slots.push(slot);
  }
  return slots;
}

/**
 * Minimum usable cell size for rebalance targets — smaller grids bail out
 * instead of squeezing. (Spawn-time anchor selection uses stricter minimums,
 * since a split must leave both halves usable.)
 */
const GRID_MIN_CELL_WIDTH = 10;
const GRID_MIN_CELL_HEIGHT = 3;

export interface GridTargets {
  /** Target rect for the parent pane (left strip at `parentRatio`). */
  parentRect: GridRect;
  /** Target cell rect per tracked pane, keyed by pane id (row-major fill). */
  cells: Map<string, GridRect>;
}

/**
 * Grid targets: the parent keeps `parentRatio` of `area` width on the left;
 * each tracked pane keeps the cell it was spawned into (spawn order), and —
 * right after a grid growth — absorbs the unclaimed cells beside it (below
 * for new rows, to the right for new columns), matching how the incremental
 * splits actually stretch the neighboring panes. Returns null when the area
 * is too small for usable cells.
 */
export function planGridTargets(
  paneIds: string[],
  area: GridRect,
  parentRatio: number,
): GridTargets | null {
  if (paneIds.length === 0) return null;
  const parentWidth = Math.round(parentRatio * area.width);
  const regionWidth = area.width - parentWidth;
  const count = paneIds.length;
  const { cols, rows } = gridDimsForCount(count);
  const cellWidth = regionWidth / cols;
  const cellHeight = area.height / rows;
  if (cellWidth < GRID_MIN_CELL_WIDTH || cellHeight < GRID_MIN_CELL_HEIGHT)
    return null;

  const slots = spawnSlots(count);
  const cellOf = new Map<string, { row: number; col: number }>();
  paneIds.forEach((paneId, index) => {
    cellOf.set(paneId, slots[index]);
  });
  const growth = lastGridGrowth(count);
  const isUnclaimed = (row: number, col: number): boolean =>
    row < rows &&
    col < cols &&
    !slots.some((s) => s.row === row && s.col === col);

  const cells = new Map<string, GridRect>();
  for (const [paneId, cell] of cellOf) {
    let widthCells = 1;
    let heightCells = 1;
    if (growth === "col") {
      while (isUnclaimed(cell.row, cell.col + widthCells)) widthCells++;
    } else if (growth === "row") {
      while (isUnclaimed(cell.row + heightCells, cell.col)) heightCells++;
    }
    cells.set(paneId, {
      x: area.x + parentWidth + cell.col * cellWidth,
      y: area.y + cell.row * cellHeight,
      width: widthCells * cellWidth,
      height: heightCells * cellHeight,
    });
  }
  return {
    parentRect: {
      x: area.x,
      y: area.y,
      width: parentWidth,
      height: area.height,
    },
    cells,
  };
}

/**
 * A pane with its current rect — the input for spawn-anchor selection, both
 * the tiled grid (selectTiledGridAnchor) and the columns rightmost anchor.
 */
interface PlacedPane {
  paneId: string;
  rect: GridRect;
}

/**
 * Rects of the tracked panes present in `panes`, in tracked (fill) order;
 * tracked panes missing from `panes` are skipped. The single input shaper
 * for spawn-anchor selection in both backends — skipping keeps a stale
 * /reload pane list from wedging the spawn. Exported for tests.
 */
export function placedPanes<Pane>(
  trackedPaneIds: string[],
  panes: readonly Pane[],
  paneIdOf: (pane: Pane) => string,
  rectOf: (pane: Pane) => GridRect,
): PlacedPane[] {
  const byId = new Map(panes.map((pane) => [paneIdOf(pane), pane]));
  const placed: PlacedPane[] = [];
  for (const id of trackedPaneIds) {
    const pane = byId.get(id);
    if (pane) placed.push({ paneId: id, rect: rectOf(pane) });
  }
  return placed;
}

/**
 * Columns-mode spawn anchor: the rightmost tracked pane (bottommost, then
 * rightmost, on ties — columns-mode panes are full-height, so the y
 * tie-break only decides odd layouts) at or right of `parentRight` within 1
 * cell. Foreign panes are never anchors — when the tab is shared, the first
 * spawn splits the parent itself rather than carving up a foreign pane.
 * `placed` holds the tracked panes (see placedPanes); null when none
 * qualifies, and callers then split the parent. Exported for tests.
 */
export function rightmostAnchor(
  placed: PlacedPane[],
  parentRight: number,
): string | null {
  const anchor = placed
    .filter((pane) => pane.rect.x >= parentRight - 1)
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
    .pop();
  return anchor?.paneId ?? null;
}

/**
 * Resolve which pane a new subagent splits, and how: in tiled mode the pane
 * covering the next grid cell (selectTiledGridAnchor over the subagent
 * `area`), in columns mode the rightmost tracked pane (rightmostAnchor) with
 * a plain right split. Null means nothing qualifies — the caller splits the
 * parent itself rather than carving up a foreign pane. Exported for tests.
 */
export function selectSpawnAnchor(
  placed: PlacedPane[],
  area: GridRect,
  parentRight: number,
  tiled: boolean,
  count: number,
): TiledAnchorSelection | null {
  const tiledSelection = tiled
    ? selectTiledGridAnchor(placed, area, count)
    : null;
  if (tiledSelection) return tiledSelection;
  const anchor = rightmostAnchor(placed, parentRight);
  return anchor ? { anchorPaneId: anchor, direction: "right" } : null;
}

export interface TiledAnchorSelection {
  anchorPaneId: string;
  direction: "right" | "down";
}

/**
 * Pick which tracked pane to split for subagent #count (1-indexed) in tiled
 * mode, and in which direction. `placed` holds the tracked panes with their
 * current rects in fill order; `region` is the subagent area — right of the
 * parent, inside the group region. The anchor is the pane overlapping the
 * target cell the most (ties: smaller pane, then fill order); the direction
 * is whichever half-split of the anchor contains more of the target cell.
 * Returns null when tiling isn't possible and the caller should fall back
 * to columns.
 */
export function selectTiledGridAnchor(
  placed: PlacedPane[],
  region: GridRect,
  count: number,
  minCellWidth = 20,
  minCellHeight = 6,
): TiledAnchorSelection | null {
  if (placed.length === 0 || count <= placed.length) return null;
  const { cols, rows } = gridDimsForCount(count);
  const cellWidth = region.width / cols;
  const cellHeight = region.height / rows;
  if (cellWidth < minCellWidth || cellHeight < minCellHeight) return null;

  const spawnCell = spawnSlots(count)[count - 1];
  const target: GridRect = {
    x: region.x + spawnCell.col * cellWidth,
    y: region.y + spawnCell.row * cellHeight,
    width: cellWidth,
    height: cellHeight,
  };

  const overlapArea = (a: GridRect, b: GridRect): number => {
    const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const height =
      Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return width > 0 && height > 0 ? width * height : 0;
  };

  const anchor = [...placed].sort((a, b) => {
    const overlapDiff =
      overlapArea(b.rect, target) - overlapArea(a.rect, target);
    if (Math.abs(overlapDiff) > 1) return overlapDiff;
    return a.rect.width * a.rect.height - b.rect.width * b.rect.height;
  })[0];
  if (!anchor) return null;

  const rightSlice: GridRect = {
    x: anchor.rect.x + anchor.rect.width / 2,
    y: anchor.rect.y,
    width: anchor.rect.width / 2,
    height: anchor.rect.height,
  };
  const downSlice: GridRect = {
    x: anchor.rect.x,
    y: anchor.rect.y + anchor.rect.height / 2,
    width: anchor.rect.width,
    height: anchor.rect.height / 2,
  };
  // Prefer "down" only when the bottom half clearly contains more of the cell.
  const direction: "right" | "down" =
    overlapArea(downSlice, target) > overlapArea(rightSlice, target)
      ? "down"
      : "right";

  // Both halves of the anchor must stay usable after the split.
  if (direction === "right") {
    if (anchor.rect.width / 2 < minCellWidth) return null;
  } else if (anchor.rect.height / 2 < minCellHeight) {
    return null;
  }
  return { anchorPaneId: anchor.paneId, direction };
}

/**
 * True when `rect` lies fully inside `bounds` within a ±`tolerance`-cell
 * slack. The one containment primitive behind both backends' region checks:
 * herdr passes HERDR_RECT_TOLERANCE (float drift), tmux passes
 * TMUX_RECT_TOLERANCE (integer geometry).
 */
export function rectWithin(
  rect: GridRect,
  bounds: GridRect,
  tolerance: number,
): boolean {
  return (
    rect.x >= bounds.x - tolerance &&
    rect.y >= bounds.y - tolerance &&
    rect.x + rect.width <= bounds.x + bounds.width + tolerance &&
    rect.y + rect.height <= bounds.y + bounds.height + tolerance
  );
}

/**
 * The region this agent group owns: the bounding rect of the parent pane and
 * its tracked subagent panes present in the layout. When the tab is shared
 * with foreign panes (another agent, user splits), the group only claims the
 * parent's own panel — subagents split within it and rebalancing never moves
 * panes outside it. A solo parent's region is exactly its own rect; in an
 * unshared tab that is the whole tab, so the layout math is unchanged.
 */
export function groupRegionOf<P>(
  panes: P[],
  parentRect: GridRect,
  idOf: (pane: P) => string,
  rectOf: (pane: P) => GridRect,
  trackedPaneIds: string[],
): GridRect {
  const tracked = new Set(trackedPaneIds);
  return boundingRect([
    parentRect,
    ...panes.filter((pane) => tracked.has(idOf(pane))).map(rectOf),
  ]);
}

/**
 * One bail decision for both grid planners: a foreign pane right of the
 * parent inside the group's region (a user split in the grid area) would get
 * wrecked by the rebalance — bail the whole plan. Foreign panes elsewhere
 * are not ours to care about.
 */
export function foreignPaneInGridArea<P>(
  panes: P[],
  parentPaneId: string,
  trackedPaneIds: string[],
  region: GridRect,
  parentRight: number,
  idOf: (pane: P) => string,
  leftOf: (pane: P) => number,
  inRegion: (pane: P) => boolean,
): boolean {
  const tracked = new Set(trackedPaneIds);
  return panes.some(
    (pane) =>
      idOf(pane) !== parentPaneId &&
      !tracked.has(idOf(pane)) &&
      inRegion(pane) &&
      leftOf(pane) >= parentRight - 1,
  );
}

/**
 * The subagent area a tiled spawn carves from: the group region minus the
 * parent strip — right of the parent, within the group's own region, so a
 * shared-tab spawn never reaches into foreign panes.
 */
export function subagentArea(group: GridRect, parentRight: number): GridRect {
  return {
    x: parentRight,
    y: group.y,
    width: group.x + group.width - parentRight,
    height: group.height,
  };
}
