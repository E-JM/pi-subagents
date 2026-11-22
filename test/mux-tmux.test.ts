import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCliJson } from "../pi-extension/subagents/mux/cli.ts";
import {
  parseCmuxFocusedSnapshot,
  parseCmuxFocusedSnapshotFromJson,
  parseCmuxPaneRefForSurface,
  parseCmuxPaneRefForSurfaceFromJson,
} from "../pi-extension/subagents/mux/cmux-backend.ts";
import {
  parseTmuxPaneGeometry,
  planTmuxRebalance,
} from "../pi-extension/subagents/mux/tmux/layout.ts";
import { shellEscape } from "../pi-extension/subagents/shell.ts";
import "./helpers.ts";

describe("cmux.ts", () => {
  describe("shellEscape", () => {
    it("wraps in single quotes", () => {
      assert.equal(shellEscape("hello"), "'hello'");
    });

    it("escapes single quotes", () => {
      assert.equal(shellEscape("it's"), "'it'\\''s'");
    });

    it("handles empty string", () => {
      assert.equal(shellEscape(""), "''");
    });

    it("handles special characters", () => {
      const input = 'echo "hello $world" && rm -rf /';
      const escaped = shellEscape(input);
      assert.ok(escaped.startsWith("'"));
      assert.ok(escaped.endsWith("'"));
      // Inside single quotes, everything is literal
      assert.ok(escaped.includes("$world"));
    });
  });

  describe("parseCmuxFocusedSnapshot", () => {
    it("parses focused surface and pane refs", () => {
      assert.deepEqual(
        parseCmuxFocusedSnapshot({
          focused: { surface_ref: "surface:3", pane_ref: "pane:2" },
        }),
        { surfaceRef: "surface:3", paneRef: "pane:2" },
      );
    });

    it("does not fall back to caller refs", () => {
      assert.equal(
        parseCmuxFocusedSnapshot({
          caller: { surface_ref: "surface:1", pane_ref: "pane:1" },
        }),
        null,
      );
    });

    it("returns null for malformed values", () => {
      assert.equal(parseCmuxFocusedSnapshot(null), null);
      assert.equal(parseCmuxFocusedSnapshot({ focused: {} }), null);
    });
  });

  describe("parseCliJson", () => {
    it("returns null for malformed JSON text", () => {
      assert.equal(parseCliJson("not json"), null);
    });

    it("parses valid JSON text", () => {
      assert.deepEqual(parseCliJson('{"ok":true}'), { ok: true });
    });
  });

  describe("parseCmuxFocusedSnapshotFromJson", () => {
    it("returns null for malformed JSON text", () => {
      assert.equal(parseCmuxFocusedSnapshotFromJson("not json"), null);
    });

    it("returns null when focused is absent or not an object", () => {
      assert.equal(
        parseCmuxFocusedSnapshotFromJson(
          '{"focused":null,"caller":{"surface_ref":"surface:1","pane_ref":"pane:1"}}',
        ),
        null,
      );
      assert.equal(
        parseCmuxFocusedSnapshotFromJson(
          '{"caller":{"surface_ref":"surface:1","pane_ref":"pane:1"}}',
        ),
        null,
      );
    });

    it("parses focused refs without falling back to caller refs", () => {
      assert.deepEqual(
        parseCmuxFocusedSnapshotFromJson(
          '{"caller":{"surface_ref":"surface:1","pane_ref":"pane:1"},"focused":{"surface_ref":"surface:2","pane_ref":"pane:3"}}',
        ),
        { surfaceRef: "surface:2", paneRef: "pane:3" },
      );
    });
  });

  describe("parseCmuxPaneRefForSurface", () => {
    it("parses top-level pane refs for a surface", () => {
      assert.equal(
        parseCmuxPaneRefForSurface(
          { surface_ref: "surface:7", pane_ref: "pane:4" },
          "surface:7",
        ),
        "pane:4",
      );
    });

    it("parses caller pane refs for identify --surface output", () => {
      assert.equal(
        parseCmuxPaneRefForSurface(
          { caller: { surface_ref: "surface:7", pane_ref: "pane:4" } },
          "surface:7",
        ),
        "pane:4",
      );
    });

    it("returns null when the surface does not match", () => {
      assert.equal(
        parseCmuxPaneRefForSurface(
          { surface_ref: "surface:8", pane_ref: "pane:4" },
          "surface:7",
        ),
        null,
      );
    });
  });

  describe("parseCmuxPaneRefForSurfaceFromJson", () => {
    it("returns null for malformed JSON text", () => {
      assert.equal(
        parseCmuxPaneRefForSurfaceFromJson("not json", "surface:7"),
        null,
      );
    });

    it("parses caller refs from cmux identify --surface JSON text", () => {
      assert.equal(
        parseCmuxPaneRefForSurfaceFromJson(
          '{"caller":{"surface_ref":"surface:7","pane_ref":"pane:4"}}',
          "surface:7",
        ),
        "pane:4",
      );
    });
  });

  describe("tmux balanced layout", () => {
    const PARENT = "%0";
    const C1 = "%1";
    const C2 = "%2";

    function makePanes(
      windowWidth: number,
      panes: Array<{
        paneId: string;
        left: number;
        width: number;
        height?: number;
        top?: number;
      }>,
      windowHeight = 50,
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

    it("parses tmux list-panes geometry output", () => {
      const output = "%0|0|0|80|50|200|50\n%1|80|0|120|50|200|50\n";
      const panes = parseTmuxPaneGeometry(output);
      assert.equal(panes.length, 2);
      assert.deepEqual(panes[0], {
        paneId: "%0",
        left: 0,
        top: 0,
        width: 80,
        height: 50,
        windowWidth: 200,
        windowHeight: 50,
      });
    });

    it("skips malformed and non-pane lines", () => {
      const panes = parseTmuxPaneGeometry(
        "garbage\n\n%1|80|0|120|50|200|50\nwindow|1|2|3|4|5|5",
      );
      assert.equal(panes.length, 1);
      assert.equal(panes[0]!.paneId, "%1");
    });

    it("plans parent and equal cell widths from absolute geometry", () => {
      const panes = makePanes(200, [
        { paneId: PARENT, left: 0, width: 100 },
        { paneId: C1, left: 100, width: 50 },
        { paneId: C2, left: 150, width: 50 },
      ]);
      const ops = planTmuxRebalance(panes, PARENT, 0.4, [C1, C2]);
      assert.deepEqual(ops, [
        { paneId: PARENT, width: 80 },
        { paneId: C1, width: 60 },
        { paneId: C2, width: 60 },
      ]);
    });

    it("emits no ops when already balanced", () => {
      const panes = makePanes(200, [
        { paneId: PARENT, left: 0, width: 80 },
        { paneId: C1, left: 80, width: 60 },
        { paneId: C2, left: 140, width: 60 },
      ]);
      const ops = planTmuxRebalance(panes, PARENT, 0.4, [C1, C2]);
      assert.equal(ops.length, 0);
    });

    it("only balances tracked full-height panes right of the parent", () => {
      const panes = makePanes(200, [
        { paneId: PARENT, left: 0, width: 100 },
        { paneId: C1, left: 100, width: 50 },
        { paneId: "partial", left: 150, width: 50, height: 30 },
      ]);
      // The partial-height tracked pane is not a column cell, so C1 absorbs
      // the remaining width; a foreign pane inside the region would bail
      // instead (absolute widths could not leave room for it).
      const ops = planTmuxRebalance(panes, PARENT, 0.4, [C1, "partial"]);
      assert.deepEqual(ops, [
        { paneId: PARENT, width: 80 },
        { paneId: C1, width: 120 },
      ]);
    });

    it("bails when a foreign pane sits inside the region", () => {
      // A user-made pane inside the group region: absolute-width resizes
      // cannot leave room for it, so nothing is balanced.
      const panes = makePanes(200, [
        { paneId: PARENT, left: 0, width: 100 },
        { paneId: C1, left: 100, width: 50 },
        { paneId: "lefty", left: 0, width: 100, height: 49 },
      ]);
      const ops = planTmuxRebalance(panes, PARENT, 0.4, [C1]);
      assert.equal(ops.length, 0);
    });

    it("shared tab: never touches the foreign pane", () => {
      // Two agents share the window: [parent 67][sub 67][foreign 134]. The
      // group region is the parent's own panel — the foreign pane keeps its
      // width and the parent moves to 0.4 of the region.
      const panes = makePanes(268, [
        { paneId: PARENT, left: 0, width: 67 },
        { paneId: C1, left: 67, width: 67 },
        { paneId: "%foreign", left: 134, width: 134 },
      ]);
      const ops = planTmuxRebalance(panes, PARENT, 0.4, [C1]);
      assert.deepEqual(ops, [
        { paneId: PARENT, width: 54 },
        { paneId: C1, width: 80 },
      ]);
    });

    it("bails out when cells cannot fit", () => {
      // Parent target 18 of 20 leaves 2 columns for two cells — fewer than
      // the two columns per cell the planner requires.
      const panes = makePanes(20, [
        { paneId: PARENT, left: 0, width: 18 },
        { paneId: C1, left: 18, width: 1 },
        { paneId: C2, left: 19, width: 1 },
      ]);
      assert.equal(planTmuxRebalance(panes, PARENT, 0.9, [C1, C2]).length, 0);
    });

    it("returns no ops when the parent pane is missing", () => {
      const panes = makePanes(200, [{ paneId: C1, left: 0, width: 200 }]);
      assert.equal(planTmuxRebalance(panes, PARENT, 0.4, [C1, C2]).length, 0);
    });
  });
});
