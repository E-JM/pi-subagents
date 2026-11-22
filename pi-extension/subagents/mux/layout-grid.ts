// Tiled grid geometry and shared layout primitives (used by herdr and tmux).

/** Default fraction of the tab width reserved for the parent (main agent) pane. */
const DEFAULT_SUBAGENT_PARENT_RATIO = 0.4;

export function parentRatioFromEnv(envName: string): number {
  const value = Number(process.env[envName]);
  return Number.isFinite(value) && value >= 0.1 && value <= 0.9
    ? value
    : DEFAULT_SUBAGENT_PARENT_RATIO;
}

/** Rectangle in tab/window coordinates. */
export interface GridRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Smallest rectangle covering every input rect. Callers always seed it with
 * the parent pane's rect, so an empty fold never happens in practice. */
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

interface GridDims {
  cols: number;
  rows: number;
}

/**
 * Grid shape for `count` subagents. Rows = round(sqrt(count)), grown one axis at
 * a time: 1×1 → 1×2 → 2×2 → 2×3 → 3×3 …, so existing panes keep their cells
 * (a binary split tree can move dividers but not reflow panes).
 */
export function gridDimsForCount(count: number): GridDims {
  const n = Math.max(1, count);
  const rows = Math.max(1, Math.round(Math.sqrt(n)));
  const cols = Math.max(1, Math.ceil(n / rows));
  return { cols, rows };
}

/** Axis the grid grew on at exactly `count`, or null when the shape is unchanged. */
function gridGrowthAt(count: number): "col" | "row" | null {
  const prev = gridDimsForCount(count - 1);
  const cur = gridDimsForCount(count);
  if (cur.cols > prev.cols) return "col";
  if (cur.rows > prev.rows) return "row";
  return null;
}

/** Axis the grid last grew on at or before `count`, or null when exactly full. */
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
 * Cell claimed by each of the first `count` spawns, in order. A growth spawn
 * takes the new column's top cell or the new row's left cell; every other
 * spawn takes the first free cell in scan order, so no pane ever moves.
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

/** Smallest usable cell for rebalance targets; smaller areas bail. Spawn-time
 * anchors are stricter: a split must leave both halves usable. */
const GRID_MIN_CELL_WIDTH = 10;
const GRID_MIN_CELL_HEIGHT = 3;

interface GridTargets {
  /** Target rect for the parent pane (left strip at `parentRatio`). */
  parentRect: GridRect;
  /** Target cell rect per tracked pane, keyed by pane id (row-major fill). */
  cells: Map<string, GridRect>;
}

/**
 * Grid targets: the parent keeps `parentRatio` of `area` on the left; each
 * tracked pane keeps the cell it spawned into, plus the unclaimed cells beside
 * it right after a growth (below for a new row, right for a new column), which
 * matches how the incremental splits stretch their neighbors. Null when the
 * area is too small for usable cells.
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
    const slot = slots[index];
    if (slot) cellOf.set(paneId, slot);
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
 * How the shared helpers read a backend's pane shape: identity and geometry.
 * Each backend defines one of these, so call sites pass data instead of lambdas.
 */
export interface PaneReader<Pane> {
  idOf: (pane: Pane) => string;
  rectOf: (pane: Pane) => GridRect;
}

/** A pane with its current rect, for spawn-anchor selection. */
interface PlacedPane {
  paneId: string;
  rect: GridRect;
}

/**
 * The tracked panes present in `panes`, in tracked (fill) order. Skipping the
 * missing ones keeps a stale /reload pane list from wedging the spawn. Exported
 * for tests.
 */
export function placedPanes<Pane>(
  trackedPaneIds: string[],
  panes: readonly Pane[],
  reader: PaneReader<Pane>,
): PlacedPane[] {
  const byId = new Map(panes.map((pane) => [reader.idOf(pane), pane]));
  const placed: PlacedPane[] = [];
  for (const id of trackedPaneIds) {
    const pane = byId.get(id);
    if (pane) placed.push({ paneId: id, rect: reader.rectOf(pane) });
  }
  return placed;
}

/**
 * Columns-mode anchor: the rightmost tracked pane (bottommost first on ties) at
 * or right of `parentRight`. Foreign panes are never anchors, so a shared tab
 * splits the parent instead. Null means split the parent. Exported for tests.
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
 * Which pane a new subagent splits, and how: tiled takes the pane covering the
 * next grid cell, columns the rightmost tracked pane with a plain right split.
 * Null means split the parent rather than carving up a foreign pane.
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

interface TiledAnchorSelection {
  anchorPaneId: string;
  direction: "right" | "down";
}

/**
 * Which tracked pane to split for subagent #count (1-indexed) in tiled mode,
 * and in which direction. The anchor overlaps the target cell the most (ties:
 * smaller pane, then fill order); the direction is whichever half contains
 * more of the cell. Null when tiling is impossible — fall back to columns.
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

  const spawnCell = spawnSlots(count).at(count - 1);
  if (!spawnCell) return null;
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
 * The group's region: the bounding rect of the parent and its tracked panes. In
 * a shared tab that is the parent's own panel, so rebalancing never moves a
 * foreign pane; in an unshared tab it is the whole tab.
 */
export function groupRegionOf<Pane>(
  panes: readonly Pane[],
  parentRect: GridRect,
  trackedPaneIds: string[],
  reader: PaneReader<Pane>,
): GridRect {
  const tracked = new Set(trackedPaneIds);
  return boundingRect([
    parentRect,
    ...panes
      .filter((pane) => tracked.has(reader.idOf(pane)))
      .map((pane) => reader.rectOf(pane)),
  ]);
}

/**
 * True when a foreign pane sits right of the parent inside the group region: the
 * rebalance would wreck it, so both grid planners bail on the whole plan.
 */
export function foreignPaneInGridArea<Pane>(options: {
  panes: readonly Pane[];
  parentPaneId: string;
  trackedPaneIds: string[];
  parentRight: number;
  inRegion: (pane: Pane) => boolean;
  reader: PaneReader<Pane>;
}): boolean {
  const { panes, parentPaneId, trackedPaneIds, parentRight, inRegion, reader } =
    options;
  const tracked = new Set(trackedPaneIds);
  return panes.some(
    (pane) =>
      reader.idOf(pane) !== parentPaneId &&
      !tracked.has(reader.idOf(pane)) &&
      inRegion(pane) &&
      reader.rectOf(pane).x >= parentRight - 1,
  );
}

/** The group region minus the parent strip: where a tiled spawn carves. */
export function subagentArea(group: GridRect, parentRight: number): GridRect {
  return {
    x: parentRight,
    y: group.y,
    width: group.x + group.width - parentRight,
    height: group.height,
  };
}
