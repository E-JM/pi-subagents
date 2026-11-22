// Integration harness: detect mux backends, build envs, drive real pi sessions.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  closeSurface,
  createSurface,
  createSurfaceSplit,
  readScreen,
  readScreenAsync,
  sendLongCommand,
} from "../../pi-extension/subagents/mux/api.ts";
import {
  getMuxBackend,
  type MuxBackend,
} from "../../pi-extension/subagents/mux/backend.ts";
import {
  parseCmuxFocusedSnapshotFromJson,
  parseCmuxPaneRefForSurfaceFromJson,
} from "../../pi-extension/subagents/mux/cmux-backend.ts";
import { shellEscape } from "../../pi-extension/subagents/shell.ts";

export {
  closeSurface,
  createSurface,
  createSurfaceSplit,
  readScreen,
  readScreenAsync,
  sendCommand,
  sendEscape,
  sendLongCommand,
} from "../../pi-extension/subagents/mux/api.ts";
export { shellEscape } from "../../pi-extension/subagents/shell.ts";
export type { MuxBackend };

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HARNESS_DIR, "../..");
const TEST_AGENTS_SRC = join(HARNESS_DIR, "agents");

// Force-loaded via `pi -ne -e` so tests exercise the working tree, never an
// installed pi-package pinned to the last release.
const EXTENSION_SOURCE = join(
  PROJECT_ROOT,
  "pi-extension",
  "subagents",
  "index.ts",
);

export const TEST_MODEL =
  process.env.PI_TEST_MODEL ?? "anthropic/claude-haiku-4-5";

export const PI_TIMEOUT = Number(process.env.PI_TEST_TIMEOUT ?? "120000");

const POLL_INTERVAL_FAST_MS = 200;
/** Screen reads are expensive, so subprocess output polls slowly. */
const POLL_INTERVAL_SLOW_MS = 2000;

/** Keep in sync with mux/backend.ts's MuxBackend union. */
const ALL_BACKENDS: MuxBackend[] = [
  "cmux",
  "tmux",
  "zellij",
  "wezterm",
  "herdr",
];

export function getAvailableBackends(): MuxBackend[] {
  const backends: MuxBackend[] = [];
  const orig = process.env.PI_SUBAGENT_MUX;

  for (const backend of ALL_BACKENDS) {
    process.env.PI_SUBAGENT_MUX = backend;
    try {
      if (getMuxBackend() === backend) backends.push(backend);
    } catch {}
  }

  if (orig === undefined) delete process.env.PI_SUBAGENT_MUX;
  else process.env.PI_SUBAGENT_MUX = orig;

  return backends;
}

export function setBackend(backend: MuxBackend): string | undefined {
  const prev = process.env.PI_SUBAGENT_MUX;
  process.env.PI_SUBAGENT_MUX = backend;
  return prev;
}

export function restoreBackend(prev: string | undefined): void {
  if (prev === undefined) delete process.env.PI_SUBAGENT_MUX;
  else process.env.PI_SUBAGENT_MUX = prev;
}

export function focusSurface(backend: MuxBackend, surface: string): void {
  if (backend === "cmux") {
    const pane = getSurfacePane(backend, surface);
    if (pane)
      execFileSync("cmux", ["focus-pane", "--pane", pane], {
        encoding: "utf8",
      });
    execFileSync("cmux", ["focus-panel", "--panel", surface], {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "tmux") {
    execFileSync("tmux", ["select-pane", "-t", surface], { encoding: "utf8" });
    return;
  }

  throw new Error(`Focus helpers are not implemented for ${backend}`);
}

export function getFocusedSurface(backend: MuxBackend): string | null {
  if (backend === "cmux") {
    const info = execFileSync("cmux", ["identify", "--json"], {
      encoding: "utf8",
    });
    return parseCmuxFocusedSnapshotFromJson(info)?.surfaceRef ?? null;
  }

  if (backend === "herdr") {
    try {
      const output = execFileSync("herdr", ["pane", "list"], {
        encoding: "utf8",
      });
      const panes = JSON.parse(output)?.result?.panes as
        | { pane_id?: string; focused?: boolean }[]
        | undefined;
      if (!Array.isArray(panes)) return null;
      const focused = panes.find((pane) => pane?.focused === true);
      return focused?.pane_id ?? null;
    } catch {
      return null;
    }
  }

  if (backend === "tmux") {
    try {
      const panes = execFileSync(
        "tmux",
        ["list-panes", "-F", "#{pane_id} #{pane_active}"],
        {
          encoding: "utf8",
        },
      );
      const activeLine = panes.split("\n").find((line) => line.endsWith(" 1"));
      return activeLine?.split(" ")[0] ?? null;
    } catch {
      return null;
    }
  }

  throw new Error(`Focus helpers are not implemented for ${backend}`);
}

export function getSurfacePane(
  backend: MuxBackend,
  surface: string,
): string | null {
  if (backend === "cmux") {
    const info = execFileSync("cmux", ["identify", "--surface", surface], {
      encoding: "utf8",
    });
    return parseCmuxPaneRefForSurfaceFromJson(info, surface);
  }

  if (backend === "tmux") return surface;

  throw new Error(`Pane lookup is not implemented for ${backend}`);
}

export async function waitForFocusedSurface(
  backend: MuxBackend,
  surface: string,
  timeout: number = PI_TIMEOUT,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (getFocusedSurface(backend) === surface) return;
    await sleep(POLL_INTERVAL_FAST_MS);
  }

  throw new Error(
    `Timeout (${timeout}ms) waiting for focused ${backend} surface ${surface}; ` +
      `current focus is ${getFocusedSurface(backend) ?? "unknown"}`,
  );
}

export interface TestEnv {
  dir: string;
  backend: MuxBackend;
  surfaces: string[];
  tempFiles: string[];
}

/** PI_TEST_MODEL rewrites each test agent's `model:` frontmatter. */
function copyTestAgents(agentsDir: string): void {
  if (!existsSync(TEST_AGENTS_SRC)) return;
  for (const file of readdirSync(TEST_AGENTS_SRC)) {
    if (!file.endsWith(".md")) continue;
    const src = join(TEST_AGENTS_SRC, file);
    const dest = join(agentsDir, file);
    const model = process.env.PI_TEST_MODEL;
    if (!model) {
      cpSync(src, dest);
      continue;
    }
    const content = readFileSync(src, "utf8").replace(
      /^(model:).*$/m,
      `$1 ${model}`,
    );
    writeFileSync(dest, content, "utf8");
  }
}

export function createTestEnv(backend: MuxBackend): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "pi-integ-"));
  const agentsDir = join(dir, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });

  copyTestAgents(agentsDir);

  return { dir, backend, surfaces: [], tempFiles: [] };
}

export function cleanupTestEnv(env: TestEnv): void {
  for (const surface of env.surfaces) {
    try {
      closeSurface(surface);
    } catch {}
  }
  for (const file of env.tempFiles) {
    try {
      unlinkSync(file);
    } catch {}
  }
  try {
    rmSync(env.dir, { recursive: true, force: true });
  } catch {}
}

export function createTrackedSurface(env: TestEnv, name: string): string {
  const surface = createSurface(name);
  env.surfaces.push(surface);
  return surface;
}

export function createTrackedSurfaceSplit(
  env: TestEnv,
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  const surface = createSurfaceSplit(name, direction, fromSurface);
  env.surfaces.push(surface);
  return surface;
}

export function untrackSurface(env: TestEnv, surface: string): void {
  env.surfaces = env.surfaces.filter((s) => s !== surface);
}

export function startPi(
  surface: string,
  testDir: string,
  task: string,
  opts?: { model?: string; extraArgs?: string },
): void {
  const model = opts?.model ?? TEST_MODEL;
  const extra = opts?.extraArgs ?? "";

  // herdr cannot read alt-screen background panes; use regular TUI mode there.
  const tuiMode = getMuxBackend() === "herdr" ? "--tui-mode regular" : "";

  const cmd = [
    `cd ${shellEscape(testDir)} &&`,
    `pi`,
    `-ne`,
    `-e ${shellEscape(EXTENSION_SOURCE)}`,
    `--model ${shellEscape(model)}`,
    tuiMode,
    extra,
    shellEscape(task),
  ]
    .filter(Boolean)
    .join(" ");

  sendLongCommand(surface, cmd, {
    scriptPath: join(testDir, `test-launch-${Date.now()}.sh`),
  });
}

export async function waitForScreen(
  surface: string,
  pattern: RegExp,
  timeout: number = PI_TIMEOUT,
  lines: number = 200,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const screen = await readScreenAsync(surface, lines);
      if (pattern.test(screen)) return screen;
    } catch {}
    await sleep(POLL_INTERVAL_SLOW_MS);
  }

  let finalScreen = "";
  try {
    finalScreen = readScreen(surface, lines);
  } catch {}
  throw new Error(
    `Timeout (${timeout}ms) waiting for pattern ${pattern}.\nLast screen:\n${finalScreen.slice(-1000)}`,
  );
}

export async function waitForFile(
  path: string,
  timeout: number = PI_TIMEOUT,
  contentPattern?: RegExp,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (existsSync(path)) {
      const content = readFileSync(path, "utf8");
      if (!contentPattern || contentPattern.test(content)) return content;
    }
    await sleep(POLL_INTERVAL_SLOW_MS);
  }
  throw new Error(
    `Timeout (${timeout}ms) waiting for file: ${path}` +
      (contentPattern ? ` matching ${contentPattern}` : ""),
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function uniqueId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function trackTempFile(env: TestEnv, path: string): void {
  env.tempFiles.push(path);
}
