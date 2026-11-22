// cmux backend: focus snapshots, surface/split creation, and pane ops.

import { execFileSync, execSync, spawnSync } from "node:child_process";
import { shellEscape, sleepSync } from "./util.ts";

/** Tracked subagent pane for cmux — reused across subagent launches. */
let cmuxSubagentPane: string | null = null;

type CmuxFocusSnapshot = {
  surfaceRef?: string;
  paneRef?: string;
};

type CmuxCreatedSurface = {
  surface: string;
  paneRef?: string;
};

type CmuxIdentifySnapshot = {
  focused: CmuxFocusSnapshot | null;
  caller: CmuxFocusSnapshot | null;
};

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Read `{ [key]: { surface_ref?, pane_ref? } }` from a parsed cmux identify
 * payload, rejecting entries without at least one usable ref.
 */
function parseCmuxFocusSnapshotField(
  value: unknown,
  key: "focused" | "caller",
): CmuxFocusSnapshot | null {
  if (!value || typeof value !== "object") return null;

  const field = (value as Record<string, unknown>)[key];
  if (!field || typeof field !== "object") return null;

  const record = field as { surface_ref?: unknown; pane_ref?: unknown };
  const surfaceRef = nonEmptyString(record.surface_ref)
    ? record.surface_ref
    : undefined;
  const paneRef = nonEmptyString(record.pane_ref) ? record.pane_ref : undefined;

  if (!surfaceRef && !paneRef) return null;
  return { surfaceRef, paneRef };
}

export function parseCmuxFocusedSnapshot(
  value: unknown,
): CmuxFocusSnapshot | null {
  return parseCmuxFocusSnapshotField(value, "focused");
}

export function parseCmuxJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function parseCmuxFocusedSnapshotFromJson(
  value: string,
): CmuxFocusSnapshot | null {
  return parseCmuxFocusedSnapshot(parseCmuxJson(value));
}

function parseCmuxCallerSnapshot(value: unknown): CmuxFocusSnapshot | null {
  return parseCmuxFocusSnapshotField(value, "caller");
}

export function parseCmuxPaneRefForSurface(
  value: unknown,
  surface: string,
): string | null {
  if (!value || typeof value !== "object") return null;

  const record = value as {
    surface_ref?: unknown;
    pane_ref?: unknown;
    caller?: unknown;
  };
  const direct = paneRefForSurface(record, surface);
  if (direct) return direct;

  const caller = record.caller;
  if (!caller || typeof caller !== "object") return null;
  return paneRefForSurface(
    caller as { surface_ref?: unknown; pane_ref?: unknown },
    surface,
  );
}

/** The pane ref when `record` is for `surface` and carries a non-empty pane_ref. */
function paneRefForSurface(
  record: { surface_ref?: unknown; pane_ref?: unknown },
  surface: string,
): string | null {
  return record.surface_ref === surface && nonEmptyString(record.pane_ref)
    ? (record.pane_ref as string)
    : null;
}

export function parseCmuxPaneRefForSurfaceFromJson(
  value: string,
  surface: string,
): string | null {
  return parseCmuxPaneRefForSurface(parseCmuxJson(value), surface);
}

function readCmux(args: string[]): string | null {
  const result = spawnSync("cmux", args, { encoding: "utf8" });
  if (result.error || result.status !== 0 || !result.stdout.trim()) return null;
  return result.stdout;
}

function parseCmuxIdentifySnapshot(value: string | null): CmuxIdentifySnapshot {
  const parsed = value ? parseCmuxJson(value) : null;
  return {
    focused: parseCmuxFocusedSnapshot(parsed),
    caller: parseCmuxCallerSnapshot(parsed),
  };
}

function captureCmuxIdentifySnapshot(): CmuxIdentifySnapshot {
  return parseCmuxIdentifySnapshot(readCmux(["identify", "--json"]));
}

function captureCmuxFocusSnapshot(): CmuxFocusSnapshot | null {
  return captureCmuxIdentifySnapshot().focused;
}

function readCmuxPaneRefForSurface(surface: string): string | null {
  const info = readCmux(["identify", "--surface", surface]);
  return info ? parseCmuxPaneRefForSurfaceFromJson(info, surface) : null;
}

function restoreCmuxFocusSnapshot(snapshot: CmuxFocusSnapshot | null): void {
  if (!snapshot) return;

  if (snapshot.paneRef) {
    spawnSync("cmux", ["focus-pane", "--pane", snapshot.paneRef], {
      encoding: "utf8",
    });
  }

  if (snapshot.surfaceRef) {
    spawnSync("cmux", ["focus-panel", "--panel", snapshot.surfaceRef], {
      encoding: "utf8",
    });
  }
}

/** Give cmux a moment to apply focus changes before reading focus back. */
function waitForCmuxFocusSettle(): void {
  sleepSync(100);
}

function cmuxFocusMatchesChild(
  currentFocus: CmuxFocusSnapshot | null,
  child: CmuxCreatedSurface,
): boolean {
  if (!currentFocus) return false;
  if (currentFocus.surfaceRef === child.surface) return true;
  return !!currentFocus.paneRef && currentFocus.paneRef === child.paneRef;
}

function cmuxFocusMatchesSurfaceRef(
  currentFocus: CmuxFocusSnapshot | null,
  surfaceRef: string | undefined,
): boolean {
  return !!surfaceRef && currentFocus?.surfaceRef === surfaceRef;
}

function cmuxFocusMatchesPaneRef(
  currentFocus: CmuxFocusSnapshot | null,
  paneRef: string | undefined,
): boolean {
  return !!paneRef && currentFocus?.paneRef === paneRef;
}

function restoreCmuxFocusIfLaunchSurfaceFocused(
  snapshot: CmuxFocusSnapshot | null,
  child: CmuxCreatedSurface,
  options?: {
    sourceSurfaceRef?: string;
    callerSnapshot?: CmuxFocusSnapshot | null;
  },
): void {
  if (!snapshot) return;

  waitForCmuxFocusSettle();
  const currentFocus = captureCmuxFocusSnapshot();
  if (
    cmuxFocusMatchesChild(currentFocus, child) ||
    cmuxFocusMatchesSurfaceRef(currentFocus, options?.sourceSurfaceRef) ||
    cmuxFocusMatchesSurfaceRef(
      currentFocus,
      options?.callerSnapshot?.surfaceRef,
    ) ||
    // cmux can settle focus onto another active surface in the caller pane after creating a split/surface.
    cmuxFocusMatchesPaneRef(currentFocus, options?.callerSnapshot?.paneRef)
  ) {
    restoreCmuxFocusSnapshot(snapshot);
  }
}

function parseCmuxCreatedSurface(
  output: string,
  command: string,
): CmuxCreatedSurface {
  const surfaceMatch = output.match(/surface:\d+/);
  if (!surfaceMatch) {
    throw new Error(`Unexpected cmux ${command} output: ${output}`);
  }

  return {
    surface: surfaceMatch[0],
    paneRef: output.match(/pane:\d+/)?.[0],
  };
}

function renameCmuxSurface(surface: string, name: string): void {
  execFileSync("cmux", ["rename-tab", "--surface", surface, name], {
    encoding: "utf8",
  });
}

export function createCmuxSplitSurface(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): CmuxCreatedSurface {
  const identifySnapshot = captureCmuxIdentifySnapshot();
  const focusSnapshot = identifySnapshot.focused;
  const callerSnapshot = identifySnapshot.caller;
  let child: CmuxCreatedSurface | null = null;

  try {
    const args = ["new-split", direction];
    if (fromSurface) args.push("--surface", fromSurface);

    const output = execFileSync("cmux", args, { encoding: "utf8" }).trim();
    child = parseCmuxCreatedSurface(output, "new-split");
    child.paneRef ??= readCmuxPaneRefForSurface(child.surface) ?? undefined;
    renameCmuxSurface(child.surface, name);
    return child;
  } finally {
    if (child) {
      restoreCmuxFocusIfLaunchSurfaceFocused(focusSnapshot, child, {
        sourceSurfaceRef: fromSurface,
        callerSnapshot,
      });
    } else {
      restoreCmuxFocusSnapshot(focusSnapshot);
    }
  }
}

/**
 * Create a new surface (tab) in an existing cmux pane.
 */
function createSurfaceInPane(name: string, pane: string): string {
  const identifySnapshot = captureCmuxIdentifySnapshot();
  const focusSnapshot = identifySnapshot.focused;
  const callerSnapshot = identifySnapshot.caller;
  let child: CmuxCreatedSurface | null = null;

  try {
    const output = execFileSync("cmux", ["new-surface", "--pane", pane], {
      encoding: "utf8",
    }).trim();
    child = parseCmuxCreatedSurface(output, "new-surface");
    child.paneRef ??= pane;
    renameCmuxSurface(child.surface, name);
    return child.surface;
  } finally {
    if (child) {
      restoreCmuxFocusIfLaunchSurfaceFocused(focusSnapshot, child, {
        callerSnapshot,
      });
    } else {
      restoreCmuxFocusSnapshot(focusSnapshot);
    }
  }
}

/**
 * Create a cmux surface for a subagent: reuse the tracked split pane (new
 * tab within it) while it exists, otherwise create a fresh right split.
 */
export function createCmuxSubagentSurface(name: string): string {
  if (cmuxSubagentPane) {
    try {
      const tree = execSync(`cmux tree`, { encoding: "utf8" });
      if (tree.includes(cmuxSubagentPane)) {
        return createSurfaceInPane(name, cmuxSubagentPane);
      }
    } catch {}
    // Pane is gone — fall through to create a new split
    cmuxSubagentPane = null;
  }

  const created = createCmuxSplitSurface(
    name,
    "right",
    process.env.CMUX_SURFACE_ID,
  );
  cmuxSubagentPane = created.paneRef ?? null;
  return created.surface;
}

export function renameCurrentTab(title: string): void {
  const surfaceId = process.env.CMUX_SURFACE_ID;
  if (!surfaceId) throw new Error("CMUX_SURFACE_ID not set");
  execSync(
    `cmux rename-tab --surface ${shellEscape(surfaceId)} ${shellEscape(title)}`,
    {
      encoding: "utf8",
    },
  );
  return;
}

export function renameWorkspace(title: string): void {
  execSync(
    `cmux workspace-action --action rename --title ${shellEscape(title)}`,
    {
      encoding: "utf8",
    },
  );
  return;
}

export function sendCommand(surface: string, command: string): void {
  execSync(
    `cmux send --surface ${shellEscape(surface)} ${shellEscape(`${command}\n`)}`,
    {
      encoding: "utf8",
    },
  );
  return;
}

export function sendEscape(surface: string): void {
  execFileSync("cmux", ["send", "--surface", surface, "\u001b"], {
    encoding: "utf8",
  });
  return;
}

export function closeSurface(surface: string): void {
  execSync(`cmux close-surface --surface ${shellEscape(surface)}`, {
    encoding: "utf8",
  });
  return;
}
