import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseHerdrLayout,
  parseHerdrPaneId,
  planHerdrRebalance,
} from "../pi-extension/subagents/mux/herdr/layout.ts";
import "./helpers.ts";

describe("cmux.ts", () => {
  describe("parseHerdrPaneId", () => {
    it("extracts pane ids from pane split output", () => {
      const output = JSON.stringify({
        id: "cli:pane:split",
        result: {
          pane: { pane_id: "w1:pB", tab_id: "w1:t1" },
          type: "pane_info",
        },
      });
      assert.equal(parseHerdrPaneId(output, "pane split"), "w1:pB");
    });

    it("extracts pane ids from tab create output", () => {
      const output = JSON.stringify({
        id: "cli:tab:create",
        result: {
          root_pane: { pane_id: "w2:p1", tab_id: "w2:t1" },
          tab: { tab_id: "w2:t1" },
          type: "tab_created",
        },
      });
      assert.equal(parseHerdrPaneId(output, "tab create"), "w2:p1");
    });

    it("throws on malformed output", () => {
      assert.throws(
        () => parseHerdrPaneId("not json", "pane split"),
        /Unexpected herdr/,
      );
      assert.throws(
        () =>
          parseHerdrPaneId(
            JSON.stringify({ result: { pane: {} } }),
            "pane split",
          ),
        /Unexpected herdr/,
      );
      assert.throws(
        () => parseHerdrPaneId("", "tab create"),
        /Unexpected herdr/,
      );
    });
  });

  describe("herdr balanced layout", () => {
    const PARENT = "w1:p1";
    const C1 = "w1:p2";
    const C2 = "w1:p3";
    const C3 = "w1:p4";

    interface FixtureSplit {
      id: string;
      direction: "right" | "down";
      ratio: number;
      rect: { x: number; y: number; width: number; height: number };
    }

    /** Layout shaped like `herdr pane layout` output for a right-nested split row. */
    function makeLayout(
      totalWidth: number,
      panes: Array<{
        pane_id: string;
        x: number;
        width: number;
        height?: number;
        y?: number;
      }>,
      splits: FixtureSplit[] = [],
    ) {
      return parseHerdrLayout(
        JSON.stringify({
          id: "cli:pane:layout",
          result: {
            type: "pane_layout",
            layout: {
              area: { x: 0, y: 0, width: totalWidth, height: 50 },
              panes: panes.map((p) => ({
                pane_id: p.pane_id,
                rect: {
                  x: p.x,
                  y: p.y ?? 0,
                  width: p.width,
                  height: p.height ?? 50,
                },
              })),
              splits,
              tab_id: "w1:t1",
              zoomed: false,
            },
          },
        }),
      );
    }

    /**
     * Apply planned ops to a split-tree model and return each pane's final
     * width. Verifies the plan converges: herdr moves one divider per op, so
     * we adjust the matched split's ratio (innermost split containing the
     * anchor pane on the operated side), then propagate widths top-down.
     */
    function simulateFinalWidths(
      layout: NonNullable<ReturnType<typeof parseHerdrLayout>>,
      ops: ReturnType<typeof planHerdrRebalance>,
    ): Map<string, number> {
      const ratios = new Map(layout.splits.map((s) => [s.id, s.ratio]));
      const sides = new Map<string, { left: string[]; right: string[] }>();
      for (const s of layout.splits) {
        const divX = s.rect.x + s.rect.width * s.ratio;
        sides.set(s.id, {
          left: layout.panes
            .filter(
              (p) =>
                p.rect.x >= s.rect.x - 1.5 &&
                p.rect.x + p.rect.width <= divX + 1.5 &&
                p.rect.y >= s.rect.y - 1.5 &&
                p.rect.y + p.rect.height <= s.rect.y + s.rect.height + 1.5,
            )
            .map((p) => p.pane_id),
          right: layout.panes
            .filter(
              (p) =>
                p.rect.x >= divX - 1.5 &&
                p.rect.x + p.rect.width <= s.rect.x + s.rect.width + 1.5 &&
                p.rect.y >= s.rect.y - 1.5 &&
                p.rect.y + p.rect.height <= s.rect.y + s.rect.height + 1.5,
            )
            .map((p) => p.pane_id),
        });
      }
      for (const op of ops) {
        let best: (typeof layout.splits)[number] | null = null;
        let bestArea = Infinity;
        for (const s of layout.splits) {
          const side = sides.get(s.id)!;
          const onSide =
            op.direction === "right"
              ? side.left.includes(op.paneId)
              : side.right.includes(op.paneId);
          if (!onSide) continue;
          const area = s.rect.width * s.rect.height;
          if (area < bestArea) {
            best = s;
            bestArea = area;
          }
        }
        assert.ok(best, `no split matched op ${JSON.stringify(op)}`);
        const cur = ratios.get(best?.id)!;
        ratios.set(
          best?.id,
          op.direction === "right" ? cur + op.amount : cur - op.amount,
        );
      }
      const widths = new Map<string, number>();
      for (const leaf of layout.panes) {
        const chain = layout.splits
          .filter(
            (s) =>
              leaf.rect.x >= s.rect.x - 1.5 &&
              leaf.rect.x + leaf.rect.width <= s.rect.x + s.rect.width + 1.5 &&
              leaf.rect.y >= s.rect.y - 1.5 &&
              leaf.rect.y + leaf.rect.height <= s.rect.y + s.rect.height + 1.5,
          )
          .sort(
            (a, b) =>
              b.rect.width * b.rect.height - a.rect.width * a.rect.height,
          );
        let width = layout.area.width;
        for (const s of chain) {
          const ratio = ratios.get(s.id)!;
          const center = leaf.rect.x + leaf.rect.width / 2;
          const divX = s.rect.x + s.rect.width * s.ratio;
          width *= center <= divX ? ratio : 1 - ratio;
        }
        widths.set(leaf.pane_id, width);
      }
      return widths;
    }

    it("parses herdr pane layout output", () => {
      const layout = makeLayout(393, [{ pane_id: PARENT, x: 0, width: 393 }]);
      assert.ok(layout);
      assert.equal(layout.area.width, 393);
      assert.equal(layout.panes.length, 1);
      assert.equal(layout.panes[0]!.pane_id, PARENT);
    });

    it("returns null for malformed layout output", () => {
      assert.equal(parseHerdrLayout("not json"), null);
      assert.equal(parseHerdrLayout(JSON.stringify({ result: {} })), null);
    });

    it("grows the parent into its region share after the first spawn", () => {
      // Right after the first spawn the parent holds half the group region;
      // rebalancing moves it to the configured 0.4 share.
      const layout = makeLayout(
        393,
        [
          { pane_id: PARENT, x: 0, width: 197 },
          { pane_id: C1, x: 197, width: 196 },
        ],
        [
          {
            id: "s0",
            direction: "right",
            ratio: 197 / 393,
            rect: { x: 0, y: 0, width: 393, height: 50 },
          },
        ],
      );
      const ops = planHerdrRebalance(layout!, PARENT, 0.4, [C1]);
      // Root split's left subtree is just the parent (0.501 of the tab);
      // shrink it to 0.4 by moving the divider left, anchored on C1.
      assert.equal(ops.length, 1);
      assert.equal(ops[0]!.paneId, C1);
      assert.equal(ops[0]!.direction, "left");
      assert.ok(Math.abs(ops[0]!.amount - (197 / 393 - 0.4)) < 1e-9);
    });

    it("balances an unbalanced inner divider via the left neighbor", () => {
      const layout = makeLayout(
        400,
        [
          { pane_id: PARENT, x: 0, width: 160 },
          { pane_id: C1, x: 160, width: 100 },
          { pane_id: C2, x: 260, width: 140 },
        ],
        [
          {
            id: "s0",
            direction: "right",
            ratio: 0.4,
            rect: { x: 0, y: 0, width: 400, height: 50 },
          },
          {
            id: "s1",
            direction: "right",
            ratio: 100 / 240,
            rect: { x: 160, y: 0, width: 240, height: 50 },
          },
        ],
      );
      const ops = planHerdrRebalance(layout!, PARENT, 0.4, [C1, C2]);
      // Cell 1 holds 100/240 of the region but should hold 1/2 — grow it by
      // moving its own right divider (direction right, anchored on C1).
      assert.equal(ops.length, 1);
      assert.equal(ops[0]!.paneId, C1);
      assert.equal(ops[0]!.direction, "right");
      assert.ok(Math.abs(ops[0]!.amount - (1 / 2 - 100 / 240)) < 0.005);
    });

    it("emits no ops when the layout is already balanced", () => {
      const layout = makeLayout(
        400,
        [
          { pane_id: PARENT, x: 0, width: 160 },
          { pane_id: C1, x: 160, width: 120 },
          { pane_id: C2, x: 280, width: 120 },
        ],
        [
          {
            id: "s0",
            direction: "right",
            ratio: 0.4,
            rect: { x: 0, y: 0, width: 400, height: 50 },
          },
          {
            id: "s1",
            direction: "right",
            ratio: 0.5,
            rect: { x: 160, y: 0, width: 240, height: 50 },
          },
        ],
      );
      const ops = planHerdrRebalance(layout!, PARENT, 0.4, [C1, C2]);
      assert.equal(ops.length, 0);
    });

    it("leaves legacy degenerate layouts untouched (coincident dividers)", () => {
      // Reproduces the old "split the parent every time" mess: nested splits
      // put p7's right edge against BOTH the inner split (SC) and the root
      // divider at x=157. Resizing p7 is ambiguous - herdr could move either
      // divider - so the planner must bail rather than guess and possibly
      // shrink the parent. New code never creates this shape.
      const leaves = [
        { pane_id: PARENT, x: 0, width: 140 },
        { pane_id: "w1:p5", x: 140, width: 5 },
        { pane_id: "w1:p6", x: 145, width: 6 },
        { pane_id: "w1:p7", x: 151, width: 6 },
        { pane_id: "w1:p2", x: 157, width: 165 },
        { pane_id: "w1:p3", x: 322, width: 36 },
        { pane_id: "w1:p4", x: 358, width: 35 },
      ];
      const layout = makeLayout(393, leaves, [
        {
          id: "root",
          direction: "right",
          ratio: 157 / 393,
          rect: { x: 0, y: 0, width: 393, height: 50 },
        },
        {
          id: "A",
          direction: "right",
          ratio: 140 / 157,
          rect: { x: 0, y: 0, width: 157, height: 50 },
        },
        {
          id: "SA",
          direction: "right",
          ratio: 5 / 17,
          rect: { x: 140, y: 0, width: 17, height: 50 },
        },
        {
          id: "SB",
          direction: "right",
          ratio: 6 / 12,
          rect: { x: 145, y: 0, width: 12, height: 50 },
        },
        {
          id: "SC",
          direction: "right",
          ratio: 6 / 242,
          rect: { x: 151, y: 0, width: 242, height: 50 },
        },
        {
          id: "B1",
          direction: "right",
          ratio: 165 / 236,
          rect: { x: 157, y: 0, width: 236, height: 50 },
        },
        {
          id: "B2",
          direction: "right",
          ratio: 36 / 71,
          rect: { x: 322, y: 0, width: 71, height: 50 },
        },
      ]);
      const ops = planHerdrRebalance(layout!, PARENT, 0.4, [
        "w1:p5",
        "w1:p6",
        "w1:p7",
        "w1:p2",
        "w1:p3",
        "w1:p4",
      ]);
      assert.equal(ops.length, 0);
    });

    it("balances a clean four-cell tree of nested splits", () => {
      // The shape this extension actually produces: root [parent | row] with
      // row cells nested right. Targets: parent 40%, four equal cells.
      const leaves = [
        { pane_id: PARENT, x: 0, width: 98 },
        { pane_id: C1, x: 98, width: 98 },
        { pane_id: C2, x: 196, width: 98 },
        { pane_id: C3, x: 294, width: 49 },
        { pane_id: "w1:p6", x: 343, width: 50 },
      ];
      const layout = makeLayout(393, leaves, [
        {
          id: "root",
          direction: "right",
          ratio: 98 / 393,
          rect: { x: 0, y: 0, width: 393, height: 50 },
        },
        {
          id: "s1",
          direction: "right",
          ratio: 98 / 295,
          rect: { x: 98, y: 0, width: 295, height: 50 },
        },
        {
          id: "s2",
          direction: "right",
          ratio: 98 / 197,
          rect: { x: 196, y: 0, width: 197, height: 50 },
        },
        {
          id: "s3",
          direction: "right",
          ratio: 49 / 99,
          rect: { x: 294, y: 0, width: 99, height: 50 },
        },
      ]);
      const ops = planHerdrRebalance(layout!, PARENT, 0.4, [
        C1,
        C2,
        C3,
        "w1:p6",
      ]);
      assert.ok(ops.length > 0);
      const widths = simulateFinalWidths(layout!, ops);
      const parentTarget = 0.4 * 393;
      assert.ok(
        Math.abs(widths.get(PARENT)! - parentTarget) < 1.5,
        `parent ${widths.get(PARENT)}`,
      );
      const cellTarget = (393 - parentTarget) / 4;
      for (const cell of [C1, C2, C3, "w1:p6"]) {
        assert.ok(
          Math.abs(widths.get(cell)! - cellTarget) < 1.5,
          `cell ${cell} = ${widths.get(cell)}, want ~${cellTarget}`,
        );
      }
    });

    it("freezes panes that are not column cells (partial height)", () => {
      // A user-made stacked log pane below the first cell must keep its width
      // and its down-split untouched.
      const layout = makeLayout(
        400,
        [
          { pane_id: PARENT, x: 0, width: 160 },
          { pane_id: C1, x: 160, width: 120, height: 30 },
          { pane_id: "w1:log", x: 160, y: 30, width: 120, height: 20 },
        ],
        [
          {
            id: "s0",
            direction: "right",
            ratio: 0.4,
            rect: { x: 0, y: 0, width: 400, height: 50 },
          },
          {
            id: "s1",
            direction: "down",
            ratio: 0.6,
            rect: { x: 160, y: 0, width: 240, height: 50 },
          },
        ],
      );
      const ops = planHerdrRebalance(layout!, PARENT, 0.4, [C1]);
      assert.equal(ops.length, 0);
    });

    it("keeps a user-split tracked pane frozen when balancing the rest", () => {
      // A tracked pane the user later split below full height is no longer a
      // column cell: its current width feeds the frozen share (and the
      // divider targets) instead of being re-balanced. parent 80 = 0.4 of
      // the 200-wide group region, C1 70 is the only cell, C2 (user-split,
      // 50) + its log pane (50) are frozen: C1's target is 200−80−100 = 20.
      const layout = makeLayout(
        400,
        [
          { pane_id: PARENT, x: 0, width: 80 },
          { pane_id: C1, x: 80, width: 70 },
          { pane_id: C2, x: 150, width: 50, height: 30 },
          { pane_id: "w1:log", x: 150, y: 30, width: 50, height: 20 },
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
            ratio: 70 / 120,
            rect: { x: 80, y: 0, width: 120, height: 50 },
          },
        ],
      );
      const ops = planHerdrRebalance(layout!, PARENT, 0.4, [C1, C2]);
      // Only s1 moves: its low side (C1) must shrink 70 -> 20 of the 120-wide
      // split, anchored on C2 (flush against the divider). s0 is already at
      // its 0.4 ratio, so the parent keeps its width.
      assert.equal(ops.length, 1);
      assert.equal(ops[0]!.paneId, C2);
      assert.equal(ops[0]!.direction, "left");
      assert.ok(Math.abs(ops[0]!.amount - (70 / 120 - 1 / 6)) < 1e-9);
    });

    it("bails out when balanced cells cannot fit", () => {
      // Parent 300 + a frozen stacked pane of 236 columns leaves nothing to
      // balance into (remaining = 400 - 160 - 236 = 4).
      const layout = makeLayout(
        400,
        [
          { pane_id: PARENT, x: 0, width: 300 },
          { pane_id: C1, x: 300, width: 50, height: 30 },
          { pane_id: C2, x: 350, width: 50, height: 30 },
          { pane_id: "w1:log", x: 300, y: 30, width: 236, height: 20 },
        ],
        [
          {
            id: "s0",
            direction: "right",
            ratio: 0.75,
            rect: { x: 0, y: 0, width: 400, height: 50 },
          },
          {
            id: "s1",
            direction: "down",
            ratio: 0.6,
            rect: { x: 300, y: 0, width: 100, height: 50 },
          },
        ],
      );
      const ops = planHerdrRebalance(layout!, PARENT, 0.4, [C1, C2]);
      assert.equal(ops.length, 0);
    });

    it("returns no ops when the parent pane is missing from the layout", () => {
      const layout = makeLayout(400, [{ pane_id: C1, x: 0, width: 400 }]);
      const ops = planHerdrRebalance(layout!, PARENT, 0.4, [C1, C2]);
      assert.equal(ops.length, 0);
    });

    it("shared tab, parent on the left: never touches the foreign pane", () => {
      // Two agents share the tab: [parent 134][foreign 134]. After the first
      // spawn the group region is just the parent's own panel — the foreign
      // agent pane must keep its width.
      const layout = makeLayout(
        268,
        [
          { pane_id: PARENT, x: 0, width: 67 },
          { pane_id: C1, x: 67, width: 67 },
          { pane_id: "w1:foreign", x: 134, width: 134 },
        ],
        [
          {
            id: "root",
            direction: "right",
            ratio: 0.5,
            rect: { x: 0, y: 0, width: 268, height: 50 },
          },
          {
            id: "inner",
            direction: "right",
            ratio: 0.5,
            rect: { x: 0, y: 0, width: 134, height: 50 },
          },
        ],
      );
      const ops = planHerdrRebalance(layout!, PARENT, 0.4, [C1]);
      // One op inside the group's own split subtree: parent to 0.4 of 134.
      assert.equal(ops.length, 1);
      assert.equal(ops[0]!.paneId, C1);
      assert.equal(ops[0]!.direction, "left");
      assert.ok(Math.abs(ops[0]!.amount - (0.5 - 0.4)) < 1e-9);
      const widths = simulateFinalWidths(layout!, ops);
      assert.equal(widths.get("w1:foreign"), 134);
      assert.ok(Math.abs(widths.get(PARENT)! - 0.4 * 134) < 1.5);
      assert.ok(Math.abs(widths.get(C1)! - 0.6 * 134) < 1.5);
    });

    it("shared tab, parent on the right: never touches the foreign pane", () => {
      const layout = makeLayout(
        268,
        [
          { pane_id: "w1:foreign", x: 0, width: 134 },
          { pane_id: PARENT, x: 134, width: 67 },
          { pane_id: C1, x: 201, width: 67 },
        ],
        [
          {
            id: "root",
            direction: "right",
            ratio: 0.5,
            rect: { x: 0, y: 0, width: 268, height: 50 },
          },
          {
            id: "inner",
            direction: "right",
            ratio: 0.5,
            rect: { x: 134, y: 0, width: 134, height: 50 },
          },
        ],
      );
      const ops = planHerdrRebalance(layout!, PARENT, 0.4, [C1]);
      // The root divider (foreign pane | group) must not move — only the
      // group's inner split is rebalanced.
      assert.equal(ops.length, 1);
      assert.equal(ops[0]!.paneId, C1);
      assert.equal(ops[0]!.direction, "left");
      assert.ok(Math.abs(ops[0]!.amount - (0.5 - 0.4)) < 1e-9);
      const widths = simulateFinalWidths(layout!, ops);
      assert.equal(widths.get("w1:foreign"), 134);
      assert.ok(Math.abs(widths.get(PARENT)! - 0.4 * 134) < 1.5);
      assert.ok(Math.abs(widths.get(C1)! - 0.6 * 134) < 1.5);
    });

    it("shared tab: a foreign pane right of the parent is not a cell", () => {
      // Without tracking, a foreign pane right of the parent used to be
      // treated as a subagent column and split/resized. Now cells are
      // tracked-only, so nothing balances and nothing is touched.
      const layout = makeLayout(
        268,
        [
          { pane_id: PARENT, x: 0, width: 67 },
          { pane_id: C1, x: 67, width: 67 },
          { pane_id: "w1:foreign", x: 134, width: 134 },
        ],
        [
          {
            id: "root",
            direction: "right",
            ratio: 0.5,
            rect: { x: 0, y: 0, width: 268, height: 50 },
          },
          {
            id: "inner",
            direction: "right",
            ratio: 0.5,
            rect: { x: 0, y: 0, width: 134, height: 50 },
          },
        ],
      );
      const ops = planHerdrRebalance(layout!, PARENT, 0.4, []);
      assert.equal(ops.length, 0);
    });
  });
});
