import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { planHerdrGridRebalance } from "../pi-extension/subagents/mux/herdr/layout.ts";
import {
  gridDimsForCount,
  placedPanes,
  planGridTargets,
  rightmostAnchor,
  selectSpawnAnchor,
  selectTiledGridAnchor,
} from "../pi-extension/subagents/mux/layout-grid.ts";
import {
  getSubagentLayoutMode,
  setSubagentLayoutMode,
} from "../pi-extension/subagents/mux/layout-mode.ts";
import { planTmuxGridRebalance } from "../pi-extension/subagents/mux/tmux/layout.ts";
import "./helpers.ts";

describe("cmux.ts rightmostAnchor", () => {
  // Full-height column-shaped panes of the columns-mode layout.
  const rect = (x: number, y = 0) => ({ x, y, width: 67, height: 50 });

  it("picks the rightmost tracked pane at or right of the parent's edge", () => {
    const placed = [
      { paneId: "%1", rect: rect(67) },
      { paneId: "%2", rect: rect(134) },
    ];
    assert.equal(rightmostAnchor(placed, 67), "%2");
  });

  it("prefers the bottommost pane, then the rightmost, on ties", () => {
    // Columns-mode panes are full-height (same y), so the y tie-break only
    // decides odd layouts: the anchor is max y, then max x.
    const placed = [
      { paneId: "%1", rect: rect(67, 0) },
      { paneId: "%2", rect: rect(134, 25) },
      { paneId: "%3", rect: rect(134, 0) },
    ];
    assert.equal(rightmostAnchor(placed, 67), "%2");
  });

  it("ignores tracked panes left of the parent's right edge", () => {
    const placed = [
      { paneId: "%1", rect: rect(0) },
      { paneId: "%2", rect: rect(67) },
    ];
    assert.equal(rightmostAnchor(placed, 67), "%2");
    assert.equal(rightmostAnchor([{ paneId: "%1", rect: rect(0) }], 67), null);
  });

  it("accepts a pane flush against the parent within 1 cell", () => {
    assert.equal(rightmostAnchor([{ paneId: "%1", rect: rect(66) }], 67), "%1");
    assert.equal(rightmostAnchor([{ paneId: "%1", rect: rect(65) }], 67), null);
  });

  it("returns null when nothing is placed", () => {
    assert.equal(rightmostAnchor([], 67), null);
  });
});

describe("cmux.ts placedPanes", () => {
  const panes = [
    { id: "%1", x: 80, y: 0 },
    { id: "%2", x: 140, y: 25 },
    { id: "%3", x: 80, y: 25 },
  ];
  const rectOf = (pane: { x: number; y: number }) => ({
    x: pane.x,
    y: pane.y,
    width: 60,
    height: 25,
  });
  // Fixture panes read the way a backend adapter would.
  const PANE_READER = { idOf: (pane: { id: string }) => pane.id, rectOf };

  it("returns tracked panes with rects in tracked (fill) order", () => {
    assert.deepEqual(placedPanes(["%3", "%1"], panes, PANE_READER), [
      { paneId: "%3", rect: rectOf(panes[2]!) },
      { paneId: "%1", rect: rectOf(panes[0]!) },
    ]);
  });

  it("skips tracked panes missing from the layout (stale /reload list)", () => {
    assert.deepEqual(placedPanes(["%2", "%9"], panes, PANE_READER), [
      { paneId: "%2", rect: rectOf(panes[1]!) },
    ]);
  });

  it("returns empty when nothing tracked is placed", () => {
    assert.deepEqual(placedPanes([], panes, PANE_READER), []);
  });
});

describe("cmux.ts selectSpawnAnchor", () => {
  // Region right of a 0.4 parent: x 80..200, full height.
  const AREA = { x: 80, y: 0, width: 120, height: 50 };
  const column = (x: number, y = 0) => ({ x, y, width: 60, height: 50 });

  it("columns mode: splits the rightmost tracked pane (direction right)", () => {
    const placed = [
      { paneId: "%1", rect: column(80) },
      { paneId: "%2", rect: column(140) },
    ];
    assert.deepEqual(selectSpawnAnchor(placed, AREA, 80, false, 3), {
      anchorPaneId: "%2",
      direction: "right",
    });
  });

  it("columns mode with no tracked pane: null — caller splits the parent", () => {
    assert.equal(selectSpawnAnchor([], AREA, 80, false, 1), null);
  });

  it("tiled mode: picks the pane covering the next grid cell", () => {
    const placed = [{ paneId: "%1", rect: column(80) }];
    assert.deepEqual(selectSpawnAnchor(placed, AREA, 80, true, 3), {
      anchorPaneId: "%1",
      direction: "down",
    });
  });

  it("tiled fallback: rightmost tracked pane when tiling is impossible", () => {
    // Region too small for the 3-pane grid — falls back to the columns
    // anchor instead of forcing a cramped split.
    const placed = [{ paneId: "%1", rect: column(80) }];
    assert.deepEqual(
      selectSpawnAnchor(
        placed,
        { x: 80, y: 0, width: 30, height: 50 },
        80,
        true,
        3,
      ),
      { anchorPaneId: "%1", direction: "right" },
    );
  });

  it("tiled fallback with nothing tracked: null — caller splits the parent", () => {
    assert.equal(selectSpawnAnchor([], AREA, 80, true, 1), null);
  });
});

describe("tiled grid layout", () => {
  describe("gridDimsForCount", () => {
    it("picks ceil(sqrt(n)) columns and fills row-major", () => {
      assert.deepEqual(gridDimsForCount(1), { cols: 1, rows: 1 });
      assert.deepEqual(gridDimsForCount(2), { cols: 2, rows: 1 });
      assert.deepEqual(gridDimsForCount(3), { cols: 2, rows: 2 });
      assert.deepEqual(gridDimsForCount(4), { cols: 2, rows: 2 });
      assert.deepEqual(gridDimsForCount(5), { cols: 3, rows: 2 });
      assert.deepEqual(gridDimsForCount(6), { cols: 3, rows: 2 });
      assert.deepEqual(gridDimsForCount(7), { cols: 3, rows: 3 });
      assert.deepEqual(gridDimsForCount(9), { cols: 3, rows: 3 });
    });

    it("clamps degenerate inputs", () => {
      assert.deepEqual(gridDimsForCount(0), { cols: 1, rows: 1 });
      assert.deepEqual(gridDimsForCount(-3), { cols: 1, rows: 1 });
    });
  });

  describe("planGridTargets", () => {
    it("assigns the parent a left strip and equal row-major cells", () => {
      const targets = planGridTargets(
        ["%1", "%2", "%3", "%4"],
        { x: 0, y: 0, width: 200, height: 50 },
        0.4,
      );
      assert.ok(targets);
      assert.deepEqual(targets.parentRect, {
        x: 0,
        y: 0,
        width: 80,
        height: 50,
      });
      assert.deepEqual(targets.cells.get("%1"), {
        x: 80,
        y: 0,
        width: 60,
        height: 25,
      });
      assert.deepEqual(targets.cells.get("%2"), {
        x: 140,
        y: 0,
        width: 60,
        height: 25,
      });
      assert.deepEqual(targets.cells.get("%3"), {
        x: 80,
        y: 25,
        width: 60,
        height: 25,
      });
      assert.deepEqual(targets.cells.get("%4"), {
        x: 140,
        y: 25,
        width: 60,
        height: 25,
      });
    });

    it("returns null with no panes", () => {
      assert.equal(
        planGridTargets([], { x: 0, y: 0, width: 200, height: 50 }, 0.4),
        null,
      );
    });

    it("returns null when cells would be too small", () => {
      assert.equal(
        planGridTargets(
          ["%1", "%2", "%3", "%4"],
          { x: 0, y: 0, width: 30, height: 10 },
          0.4,
        ),
        null,
      );
    });

    it("absorbs the unclaimed cell below when the grid just grew a row", () => {
      // 3 panes in a 2×2 grid: pane 2 (top-right) stretches over the empty
      // bottom-right cell; pane 3 keeps a single bottom-left cell.
      const targets = planGridTargets(
        ["%1", "%2", "%3"],
        { x: 0, y: 0, width: 200, height: 50 },
        0.4,
      );
      assert.ok(targets);
      assert.deepEqual(targets.cells.get("%1"), {
        x: 80,
        y: 0,
        width: 60,
        height: 25,
      });
      assert.deepEqual(targets.cells.get("%2"), {
        x: 140,
        y: 0,
        width: 60,
        height: 50,
      });
      assert.deepEqual(targets.cells.get("%3"), {
        x: 80,
        y: 25,
        width: 60,
        height: 25,
      });
    });

    it("absorbs the unclaimed cell beside when the grid just grew a column", () => {
      // 5 panes in a 2×3 grid: pane 4 (bottom-middle) stretches over the empty
      // bottom-right cell; panes 1–3 and 5 keep single cells.
      const targets = planGridTargets(
        ["%1", "%2", "%3", "%4", "%5"],
        { x: 0, y: 0, width: 200, height: 50 },
        0.4,
      );
      assert.ok(targets);
      assert.deepEqual(targets.cells.get("%1"), {
        x: 80,
        y: 0,
        width: 40,
        height: 25,
      });
      assert.deepEqual(targets.cells.get("%2"), {
        x: 120,
        y: 0,
        width: 40,
        height: 25,
      });
      assert.deepEqual(targets.cells.get("%3"), {
        x: 80,
        y: 25,
        width: 40,
        height: 25,
      });
      assert.deepEqual(targets.cells.get("%4"), {
        x: 120,
        y: 25,
        width: 80,
        height: 25,
      });
      assert.deepEqual(targets.cells.get("%5"), {
        x: 160,
        y: 0,
        width: 40,
        height: 25,
      });
    });

    it("keeps every pane in the cell it was spawned into as the grid grows", () => {
      // 6 panes exactly fill the 2×3 grid; all cells are single-cell.
      const targets = planGridTargets(
        ["%1", "%2", "%3", "%4", "%5", "%6"],
        { x: 0, y: 0, width: 200, height: 50 },
        0.4,
      );
      assert.ok(targets);
      const paneIds = ["%1", "%2", "%3", "%4", "%5", "%6"];
      const expected = [
        { x: 80, y: 0, width: 40, height: 25 },
        { x: 120, y: 0, width: 40, height: 25 },
        { x: 80, y: 25, width: 40, height: 25 },
        { x: 120, y: 25, width: 40, height: 25 },
        { x: 160, y: 0, width: 40, height: 25 },
        { x: 160, y: 25, width: 40, height: 25 },
      ];
      for (const [i, paneId] of paneIds.entries()) {
        assert.deepEqual(targets.cells.get(paneId), expected[i], paneId);
      }
    });
  });

  describe("selectTiledGridAnchor", () => {
    // Region right of a 0.4 parent in a 200×50 tab: x 80..200, full height.
    const REGION = { x: 80, y: 0, width: 120, height: 50 };

    it("returns null when nothing is placed yet or count is not growing", () => {
      assert.equal(selectTiledGridAnchor([], REGION, 1), null);
      const placed = [
        { paneId: "%1", rect: { x: 80, y: 0, width: 120, height: 50 } },
      ];
      assert.equal(selectTiledGridAnchor(placed, REGION, 1), null);
    });

    it("returns null when the region is too small for the grid", () => {
      const placed = [
        { paneId: "%1", rect: { x: 80, y: 0, width: 120, height: 50 } },
      ];
      assert.equal(
        selectTiledGridAnchor(
          placed,
          { x: 80, y: 0, width: 30, height: 50 },
          9,
        ),
        null,
      );
    });

    it("returns null when the down split would leave a too-short half", () => {
      // 3 spawns in a 2×2 grid: the target cell is the bottom-left. A low
      // pane (10 tall, y18..28) overlaps it more with its bottom half, so
      // "down" wins the direction vote — but halving it leaves a 5-tall
      // half, below the usable minimum, so the spawn falls back to columns.
      const placed = [
        { paneId: "%1", rect: { x: 80, y: 18, width: 120, height: 10 } },
      ];
      assert.equal(selectTiledGridAnchor(placed, REGION, 3), null);
    });

    it("splits the lone full pane right for subagent 2", () => {
      const placed = [
        { paneId: "%1", rect: { x: 80, y: 0, width: 120, height: 50 } },
      ];
      assert.deepEqual(selectTiledGridAnchor(placed, REGION, 2), {
        anchorPaneId: "%1",
        direction: "right",
      });
    });

    it("splits down for subagent 3 (start of the second row)", () => {
      const placed = [
        { paneId: "%1", rect: { x: 80, y: 0, width: 120, height: 50 } },
      ];
      assert.deepEqual(selectTiledGridAnchor(placed, REGION, 3), {
        anchorPaneId: "%1",
        direction: "down",
      });
    });

    it("completes the 2×2 grid for subagent 4 via a down split", () => {
      // After 3 panes: top-left, bottom-left, and a full-height right column.
      const placed = [
        { paneId: "%1", rect: { x: 80, y: 0, width: 60, height: 25 } },
        { paneId: "%2", rect: { x: 140, y: 0, width: 60, height: 50 } },
        { paneId: "%3", rect: { x: 80, y: 25, width: 60, height: 25 } },
      ];
      assert.deepEqual(selectTiledGridAnchor(placed, REGION, 4), {
        anchorPaneId: "%2",
        direction: "down",
      });
    });

    it("grows a third column for subagent 5 on a full 2×2 grid", () => {
      const placed = [
        { paneId: "%1", rect: { x: 80, y: 0, width: 60, height: 25 } },
        { paneId: "%2", rect: { x: 140, y: 0, width: 60, height: 25 } },
        { paneId: "%3", rect: { x: 80, y: 25, width: 60, height: 25 } },
        { paneId: "%4", rect: { x: 140, y: 25, width: 60, height: 25 } },
      ];
      // Growth spawn: pane 5 claims the new column's top cell, carved out of
      // the pane beside the region's right edge (%2).
      assert.deepEqual(selectTiledGridAnchor(placed, REGION, 5), {
        anchorPaneId: "%2",
        direction: "right",
      });
    });

    it("fills the new column's bottom cell for subagent 6", () => {
      // After 5 panes: the bottom-right pane stretches across two cells.
      const placed = [
        { paneId: "%1", rect: { x: 80, y: 0, width: 40, height: 25 } },
        { paneId: "%2", rect: { x: 120, y: 0, width: 40, height: 25 } },
        { paneId: "%5", rect: { x: 160, y: 0, width: 40, height: 25 } },
        { paneId: "%3", rect: { x: 80, y: 25, width: 40, height: 25 } },
        { paneId: "%4", rect: { x: 120, y: 25, width: 80, height: 25 } },
      ];
      assert.deepEqual(selectTiledGridAnchor(placed, REGION, 6), {
        anchorPaneId: "%4",
        direction: "right",
      });
    });
  });

  describe("planHerdrGridRebalance", () => {
    const PARENT = "%0";

    function makeGridLayout(
      panes: Array<{
        pane_id: string;
        rect: { x: number; y: number; width: number; height: number };
      }>,
      splits: Array<{
        id: string;
        direction: "right" | "down";
        ratio: number;
        rect: { x: number; y: number; width: number; height: number };
      }>,
      areaWidth = 200,
    ) {
      return {
        area: { x: 0, y: 0, width: areaWidth, height: 50 },
        panes,
        splits,
        tab_id: "w1:t1",
        zoomed: false,
      } as any;
    }

    function quadrantLayout(ratioColSplit: number) {
      // 2×2 grid: parent | col A (S1 over S3) | col B (S2 over S4)
      const colARight = 80 + 120 * ratioColSplit;
      return makeGridLayout(
        [
          { pane_id: PARENT, rect: { x: 0, y: 0, width: 80, height: 50 } },
          {
            pane_id: "%1",
            rect: { x: 80, y: 0, width: colARight - 80, height: 25 },
          },
          {
            pane_id: "%3",
            rect: { x: 80, y: 25, width: colARight - 80, height: 25 },
          },
          {
            pane_id: "%2",
            rect: { x: colARight, y: 0, width: 200 - colARight, height: 25 },
          },
          {
            pane_id: "%4",
            rect: { x: colARight, y: 25, width: 200 - colARight, height: 25 },
          },
        ],
        [
          {
            id: "s0",
            direction: "right",
            ratio: 0.4,
            rect: { x: 0, y: 0, width: 200, height: 50 },
          },
          {
            id: "s1",
            direction: "right",
            ratio: ratioColSplit,
            rect: { x: 80, y: 0, width: 120, height: 50 },
          },
          {
            id: "s2",
            direction: "down",
            ratio: 0.5,
            rect: { x: 80, y: 0, width: colARight - 80, height: 50 },
          },
          {
            id: "s3",
            direction: "down",
            ratio: 0.5,
            rect: { x: colARight, y: 0, width: 200 - colARight, height: 50 },
          },
        ],
      );
    }

    it("emits no ops when the 2×2 grid is already balanced", () => {
      const layout = quadrantLayout(0.5);
      const ops = planHerdrGridRebalance(
        layout,
        PARENT,
        ["%1", "%2", "%3", "%4"],
        0.4,
      );
      assert.equal(ops.length, 0);
    });

    it("evens out unbalanced columns without touching a correct parent strip", () => {
      // Column split at 0.6: left column too wide (72), right too narrow (48);
      // parent is already at its 0.4 target, so no parent op is emitted.
      const layout = quadrantLayout(0.6);
      const ops = planHerdrGridRebalance(
        layout,
        PARENT,
        ["%1", "%2", "%3", "%4"],
        0.4,
      );
      assert.equal(ops.length, 1);
      assert.equal(ops[0]!.paneId, "%2");
      assert.equal(ops[0]!.direction, "left");
      assert.ok(Math.abs(ops[0]!.amount - 0.1) < 1e-9);
    });

    it("emits a vertical up op for an unbalanced row divider", () => {
      // Masonry after 3 spawns: S1a over S3 on the left, full-height S2 right.
      // Parent strip and column split are already at target; only the row
      // divider (ratio 0.6, y=30) needs to move to 0.5 (y=25).
      const layout = makeGridLayout(
        [
          { pane_id: PARENT, rect: { x: 0, y: 0, width: 80, height: 50 } },
          { pane_id: "%1", rect: { x: 80, y: 0, width: 60, height: 30 } },
          { pane_id: "%3", rect: { x: 80, y: 30, width: 60, height: 20 } },
          { pane_id: "%2", rect: { x: 140, y: 0, width: 60, height: 50 } },
        ],
        [
          {
            id: "s0",
            direction: "right",
            ratio: 0.4,
            rect: { x: 0, y: 0, width: 200, height: 50 },
          },
          {
            id: "s1",
            direction: "right",
            ratio: 0.5,
            rect: { x: 80, y: 0, width: 120, height: 50 },
          },
          {
            id: "s2",
            direction: "down",
            ratio: 0.6,
            rect: { x: 80, y: 0, width: 60, height: 50 },
          },
        ],
      );
      const ops = planHerdrGridRebalance(
        layout,
        PARENT,
        ["%1", "%2", "%3"],
        0.4,
      );
      assert.equal(ops.length, 1);
      assert.equal(ops[0]!.paneId, "%3");
      assert.equal(ops[0]!.direction, "up");
      assert.ok(Math.abs(ops[0]!.amount - 0.1) < 1e-9);
    });

    it("freezes foreign panes and returns no ops for an empty grid", () => {
      const layout = quadrantLayout(0.5);
      assert.equal(planHerdrGridRebalance(layout, PARENT, [], 0.4).length, 0);
    });

    it("shared tab: grid ops stay inside the group region", () => {
      // Two agents share the tab: foreign pane [0..134], group grid packed
      // into the parent's own panel [134..268]. The root split (foreign |
      // group) is outside the region and must never be walked.
      const layout = makeGridLayout(
        [
          {
            pane_id: "w1:foreign",
            rect: { x: 0, y: 0, width: 134, height: 50 },
          },
          { pane_id: PARENT, rect: { x: 134, y: 0, width: 54, height: 50 } },
          { pane_id: "%1", rect: { x: 188, y: 0, width: 48, height: 25 } },
          { pane_id: "%3", rect: { x: 188, y: 25, width: 48, height: 25 } },
          { pane_id: "%2", rect: { x: 236, y: 0, width: 32, height: 25 } },
          { pane_id: "%4", rect: { x: 236, y: 25, width: 32, height: 25 } },
        ],
        [
          {
            id: "root",
            direction: "right",
            ratio: 0.5,
            rect: { x: 0, y: 0, width: 268, height: 50 },
          },
          {
            id: "s0",
            direction: "right",
            ratio: 54 / 134,
            rect: { x: 134, y: 0, width: 134, height: 50 },
          },
          {
            id: "s1",
            direction: "right",
            ratio: 0.6,
            rect: { x: 188, y: 0, width: 80, height: 50 },
          },
          {
            id: "s2",
            direction: "down",
            ratio: 0.5,
            rect: { x: 188, y: 0, width: 48, height: 50 },
          },
          {
            id: "s3",
            direction: "down",
            ratio: 0.5,
            rect: { x: 236, y: 0, width: 32, height: 50 },
          },
        ],
        268,
      );
      const ops = planHerdrGridRebalance(
        layout as any,
        PARENT,
        ["%1", "%2", "%3", "%4"],
        0.4,
      );
      // Only the group's column divider moves; the root split (and with it
      // the foreign pane) is untouched.
      assert.equal(ops.length, 1);
      assert.equal(ops[0]!.paneId, "%2");
      assert.equal(ops[0]!.direction, "left");
      assert.ok(Math.abs(ops[0]!.amount - 0.1) < 1e-9);
    });
  });

  describe("planTmuxGridRebalance", () => {
    const PARENT = "%0";

    function makePanes2D(
      windowWidth: number,
      windowHeight: number,
      panes: Array<{
        paneId: string;
        left: number;
        top?: number;
        width: number;
        height?: number;
      }>,
    ) {
      return panes.map((p) => ({
        paneId: p.paneId,
        left: p.left,
        top: p.top ?? 0,
        width: p.width,
        height: p.height ?? windowHeight,
        windowWidth,
        windowHeight,
      }));
    }

    it("emits no ops when the 2×2 grid is already balanced", () => {
      const panes = makePanes2D(200, 50, [
        { paneId: PARENT, left: 0, width: 80 },
        { paneId: "%1", left: 80, width: 60, height: 25 },
        { paneId: "%2", left: 140, width: 60, height: 25 },
        { paneId: "%3", left: 80, top: 25, width: 60, height: 25 },
        { paneId: "%4", left: 140, top: 25, width: 60, height: 25 },
      ]);
      const ops = planTmuxGridRebalance(
        panes,
        PARENT,
        ["%1", "%2", "%3", "%4"],
        0.4,
      );
      assert.equal(ops.length, 0);
    });

    it("plans width and height ops toward equal cells", () => {
      const panes = makePanes2D(200, 50, [
        { paneId: PARENT, left: 0, width: 80 },
        { paneId: "%1", left: 80, width: 70, height: 30 },
        { paneId: "%2", left: 150, width: 50, height: 30 },
        { paneId: "%3", left: 80, top: 30, width: 70, height: 20 },
        { paneId: "%4", left: 150, top: 30, width: 50, height: 20 },
      ]);
      const ops = planTmuxGridRebalance(
        panes,
        PARENT,
        ["%1", "%2", "%3", "%4"],
        0.4,
      );
      assert.deepEqual(ops, [
        { paneId: "%1", width: 60, height: 25 },
        { paneId: "%2", width: 60, height: 25 },
        { paneId: "%3", width: 60, height: 25 },
        { paneId: "%4", width: 60, height: 25 },
      ]);
    });

    it("skips the masonry pane that runs to the region's bottom edge", () => {
      // 3 panes: two stacked on the left, one full-height on the right — the
      // tall pane's height target would shrink it toward the window edge.
      const panes = makePanes2D(200, 50, [
        { paneId: PARENT, left: 0, width: 80 },
        { paneId: "%1", left: 80, width: 60, height: 25 },
        { paneId: "%2", left: 140, width: 60 },
        { paneId: "%3", left: 80, top: 25, width: 60, height: 25 },
      ]);
      const ops = planTmuxGridRebalance(panes, PARENT, ["%1", "%2", "%3"], 0.4);
      assert.equal(ops.length, 0);
    });

    it("shared tab: rebalances inside the region and leaves foreign panes alone", () => {
      // Two agents share the window: [parent 96][sub 72][foreign 72]. The
      // foreign pane used to bail the whole rebalance; now the group only
      // claims its own panel [0..168] and %9 is not ours to care about.
      const panes = makePanes2D(240, 50, [
        { paneId: PARENT, left: 0, width: 96 },
        { paneId: "%1", left: 96, width: 72 },
        { paneId: "%9", left: 168, width: 72 },
      ]);
      const ops = planTmuxGridRebalance(panes, PARENT, ["%1"], 0.4);
      assert.deepEqual(ops, [
        { paneId: PARENT, width: 67 },
        { paneId: "%1", width: 101, height: undefined },
      ]);
    });

    it("bails when a foreign pane sits inside the grid area", () => {
      // A user-made pane inside the group region — resizing around it would
      // wreck the layout, so no ops are emitted.
      const panes = makePanes2D(240, 50, [
        { paneId: PARENT, left: 0, width: 96 },
        { paneId: "%9", left: 96, width: 20 },
        { paneId: "%1", left: 116, width: 52 },
      ]);
      const ops = planTmuxGridRebalance(panes, PARENT, ["%1"], 0.4);
      assert.equal(ops.length, 0);
    });

    it("returns no ops when the parent pane is missing", () => {
      const panes = makePanes2D(200, 50, [
        { paneId: "%1", left: 0, width: 200 },
      ]);
      assert.equal(planTmuxGridRebalance(panes, PARENT, ["%1"], 0.4).length, 0);
    });
  });

  describe("layout mode persistence", () => {
    const LAYOUT_KEY = Symbol.for("pi-subagents/layout-mode");

    it("defaults to columns, honors PI_SUBAGENT_LAYOUT, and persists toggles", () => {
      const store = globalThis as Record<symbol, unknown>;
      const prevConfigDir = process.env.PI_CODING_AGENT_DIR;
      const prevLayoutEnv = process.env.PI_SUBAGENT_LAYOUT;
      const prevMode = store[LAYOUT_KEY];
      const dir = mkdtempSync(join(tmpdir(), "subagents-layout-"));
      try {
        process.env.PI_CODING_AGENT_DIR = dir;
        delete process.env.PI_SUBAGENT_LAYOUT;
        delete store[LAYOUT_KEY];
        assert.equal(getSubagentLayoutMode(), "columns");

        process.env.PI_SUBAGENT_LAYOUT = "tiled";
        delete store[LAYOUT_KEY];
        assert.equal(getSubagentLayoutMode(), "tiled");

        // /subagent-layout persists — the file wins over the env default.
        setSubagentLayoutMode("columns");
        delete store[LAYOUT_KEY];
        assert.equal(getSubagentLayoutMode(), "columns");
        assert.deepEqual(
          JSON.parse(readFileSync(join(dir, "subagents-layout.json"), "utf8")),
          {
            mode: "columns",
          },
        );

        setSubagentLayoutMode("tiled");
        assert.equal(getSubagentLayoutMode(), "tiled");
      } finally {
        if (prevConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = prevConfigDir;
        if (prevLayoutEnv === undefined) delete process.env.PI_SUBAGENT_LAYOUT;
        else process.env.PI_SUBAGENT_LAYOUT = prevLayoutEnv;
        if (prevMode === undefined) delete store[LAYOUT_KEY];
        else store[LAYOUT_KEY] = prevMode;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
