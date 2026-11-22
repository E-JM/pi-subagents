import { execFileSync } from "node:child_process";
import { execFileAsync, sleepSync } from "../cli.ts";
import {
  parentRatioFromEnv,
  placedPanes,
  selectSpawnAnchor,
} from "../layout-grid.ts";
import { getSubagentLayoutMode } from "../layout-mode.ts";
import { createTrackedPaneList } from "../tracked-panes.ts";
import {
  HERDR_PANES,
  type HerdrLayout,
  type HerdrResizeOp,
  herdrSubagentArea,
  parseHerdrLayout,
  parseHerdrPaneId,
  planHerdrGridRebalance,
  planHerdrRebalance,
} from "./layout.ts";

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

/** Exported for tests only. */
export function setHerdrSubagentPaneList(paneIds: string[]): void {
  herdrPanes.setPaneList(paneIds);
}

function herdrParentRatio(): number {
  return parentRatioFromEnv("PI_SUBAGENT_HERDR_PARENT_RATIO");
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

/** Parent width fixed, cells equal; three passes absorb rounding. Best effort. */
function rebalanceHerdrSubagentLayout(parentPaneId: string): void {
  for (let pass = 0; pass < 3; pass++) {
    const layout = readHerdrLayout(parentPaneId);
    if (!layout) return;
    const ops = planHerdrRebalance(
      layout,
      parentPaneId,
      herdrParentRatio(),
      herdrPanes.paneList(),
    );
    if (ops.length === 0) return;
    applyHerdrResizeOps(ops);
  }
}

/**
 * Read the layout until every tracked pane appears: under load `pane layout`
 * can lag a split, and a stale plan yields zero ops.
 */
function waitForHerdrTrackedPanes(
  parentPaneId: string,
  timeoutMs = 500,
): HerdrLayout | null {
  const tracked = herdrPanes.paneList();
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

/** Same passes as the column rebalance, targeting the tiled grid. */
function rebalanceHerdrGridLayout(parentPaneId: string): void {
  const tracked = herdrPanes.paneList();
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
 * Trailing rebalances ~400ms apart: a race safety net for what the synchronous
 * pass missed. Stops after 5 passes, or 10 ticks of unreadable layout.
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
      const tracked = herdrPanes.paneList();
      // Zero ops only means converged when the layout shows every tracked pane;
      // a stale read must keep retrying.
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
        : planHerdrRebalance(layout, parentPaneId, herdrParentRatio(), tracked);
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

/** Rebalance in the configured layout mode. Best effort — never blocks spawning. */
function rebalanceHerdrLayoutForMode(parentPaneId: string): void {
  if (getSubagentLayoutMode() === "tiled") {
    rebalanceHerdrGridLayout(parentPaneId);
  } else {
    rebalanceHerdrSubagentLayout(parentPaneId);
  }
}

/**
 * Create a herdr subagent surface inside the group's own panel, so foreign
 * panes in a shared tab are never split or resized. Columns mode splits the
 * parent once, then the rightmost tracked pane, keeping the parent at
 * `PI_SUBAGENT_HERDR_PARENT_RATIO` (default 0.4); tiled mode splits the pane
 * covering the next grid cell.
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
        herdrPanes.paneList().filter((id) => known.has(id)),
      );
      const parent = layout.panes.find((pane) => pane.pane_id === parentPaneId);
      if (parent) {
        const tracked = herdrPanes.paneList();
        const placed = placedPanes(tracked, layout.panes, HERDR_PANES);
        // Tiled: the pane covering the next grid cell. Otherwise the rightmost
        // tracked pane. Null means split the parent, never a foreign pane.
        const selection = selectSpawnAnchor(
          placed,
          herdrSubagentArea(layout, parent, tracked),
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
  herdrPanes.track(paneId);
  if (parentPaneId) {
    rebalanceHerdrLayoutForMode(parentPaneId);
    scheduleHerdrDeferredRebalance(parentPaneId);
  }
  return paneId;
}

export function isHerdrAgentWorking(surface: string): Promise<boolean> {
  return execFileAsync("herdr", ["agent", "get", surface], { encoding: "utf8" })
    .then(
      ({ stdout }) =>
        JSON.parse(stdout)?.result?.agent?.agent_status === "working",
    )
    .catch(() => false);
}

/**
 * Block on `herdr agent wait` until the agent settles or the timeout elapses —
 * no hot sample loop. Abort kills the waiter: a dead caller must not leave one
 * attached to the pane.
 */
export function waitHerdrAgentSettled(
  surface: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const wait = execFileAsync(
    "herdr",
    [
      "agent",
      "wait",
      surface,
      "--until",
      "idle",
      "--until",
      "blocked",
      "--until",
      "unknown",
      "--timeout",
      String(timeoutMs),
    ],
    { encoding: "utf8" },
  );
  const abort = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      wait.child?.kill();
      return reject(new Error("Aborted"));
    }
    signal.addEventListener(
      "abort",
      () => {
        wait.child?.kill();
        reject(new Error("Aborted"));
      },
      { once: true },
    );
  });
  return Promise.race([
    wait.then(
      () => undefined,
      () => undefined,
    ),
    abort,
  ]);
}

/** Split a herdr pane; left/up fall back to the nearest equivalent (right/down). */
export function createHerdrSplitSurface(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
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
  if (herdrPanes.paneList().includes(surface)) {
    herdrPanes.untrack(surface);
    const parentPaneId = process.env.HERDR_PANE_ID;
    if (parentPaneId) {
      rebalanceHerdrLayoutForMode(parentPaneId);
      scheduleHerdrDeferredRebalance(parentPaneId);
    }
  }
  return;
}
