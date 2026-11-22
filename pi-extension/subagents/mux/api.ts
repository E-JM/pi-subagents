// Public facade: per-backend dispatch for the subagent surface API.

import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  getMuxBackend,
  type MuxBackend,
  requireMuxBackend,
} from "./backend.ts";
import * as cmuxBackend from "./cmux-backend.ts";
import * as herdr from "./herdr.ts";
import * as tmux from "./tmux.ts";
import { execFileAsync, shellEscape, tailLines } from "./util.ts";
import * as wezterm from "./wezterm.ts";
import * as zellij from "./zellij.ts";
import { zellijActionArgs, zellijEnv } from "./zellij.ts";

/**
 * Create a new terminal surface for a subagent.
 *
 * For cmux: the first call creates a right-split pane; subsequent calls add
 * tabs to that same pane (avoiding ever-narrower splits).
 * For zellij: chooses a tab-aware tiled or stacked placement.
 * For herdr: splits the rightmost tracked subagent pane (no focus steal),
 * keeping the parent pane at a fixed share of the group region, then
 * rebalances so all subagent panes are equally wide
 * (`PI_SUBAGENT_HERDR_PARENT_RATIO`, default 0.4). When the tab is shared
 * with foreign panes (another agent, user splits), the group only claims
 * the parent's own panel — foreign panes are never split or resized. In
 * "tiled" mode both herdr and tmux instead fill a grid right of the parent —
 * see createHerdrSubagentSurface / createTmuxSubagentSurface.
 * For tmux: same balanced layout as herdr (`PI_SUBAGENT_TMUX_PARENT_RATIO`),
 * using absolute `resize-pane -x` widths.
 * For wezterm: falls back to split behavior.
 *
 * Returns an identifier (`surface:42` in cmux, `%12` in tmux, `pane:7` in zellij, `42` in wezterm, `w1:p7` in herdr).
 */
export function createSurface(name: string): string {
  const backend = getMuxBackend();

  if (backend === "cmux") {
    return cmuxBackend.createCmuxSubagentSurface(name);
  }

  if (backend === "zellij") {
    return zellij.createZellijSurface(name);
  }

  if (backend === "herdr") {
    return herdr.createHerdrSubagentSurface(name);
  }

  if (backend === "tmux") {
    return tmux.createTmuxSubagentSurface(name);
  }

  return wezterm.createWeztermSurface(name);
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns an identifier (`surface:42` in cmux, `%12` in tmux, `pane:7` in zellij, `42` in wezterm, `w1:p7` in herdr).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    return cmuxBackend.createCmuxSplitSurface(name, direction, fromSurface)
      .surface;
  }

  if (backend === "herdr") {
    return herdr.createHerdrSplitSurface(name, direction, fromSurface);
  }

  if (backend === "tmux") {
    return tmux.createTmuxSplitSurface(name, direction, fromSurface);
  }

  if (backend === "wezterm") {
    return wezterm.createWeztermSplitSurface(name, direction, fromSurface);
  }

  return zellij.createZellijSplitSurface(name, direction, fromSurface);
}

/**
 * Rename the current tab/window.
 */
export function renameCurrentTab(title: string): void {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    cmuxBackend.renameCurrentTab(title);
    return;
  }

  if (backend === "tmux") {
    tmux.renameCurrentTab(title);
    return;
  }

  if (backend === "wezterm") {
    wezterm.renameCurrentTab(title);
    return;
  }

  if (backend === "herdr") {
    herdr.renameCurrentTab(title);
    return;
  }

  zellij.renameCurrentTab(title);
}

/**
 * Rename the current workspace/session where supported.
 */
export function renameWorkspace(title: string): void {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    cmuxBackend.renameWorkspace(title);
    return;
  }

  if (backend === "tmux") {
    tmux.renameWorkspace(title);
    return;
  }

  if (backend === "wezterm") {
    wezterm.renameWorkspace(title);
    return;
  }

  if (backend === "herdr") {
    herdr.renameWorkspace(title);
    return;
  }

  zellij.renameWorkspace(title);
}

/**
 * Send a command string to a pane and execute it.
 */
export function sendCommand(surface: string, command: string): void {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    cmuxBackend.sendCommand(surface, command);
    return;
  }

  if (backend === "tmux") {
    tmux.sendCommand(surface, command);
    return;
  }

  if (backend === "herdr") {
    herdr.sendCommand(surface, command);
    return;
  }

  if (backend === "wezterm") {
    wezterm.sendCommand(surface, command);
    return;
  }

  zellij.sendCommand(surface, command);
}

/**
 * Send one Escape keypress to an active pane.
 */
export function sendEscape(surface: string): void {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    cmuxBackend.sendEscape(surface);
    return;
  }

  if (backend === "tmux") {
    tmux.sendEscape(surface);
    return;
  }

  if (backend === "herdr") {
    herdr.sendEscape(surface);
    return;
  }

  if (backend === "wezterm") {
    wezterm.sendEscape(surface);
    return;
  }

  zellij.sendEscape(surface);
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
/**
 * Assemble the launch-script text. Preamble lines are comments by contract:
 * any control character (newlines included) is scrubbed so a crafted
 * subagent name interpolated into a preamble can never break out of the
 * comment into live script lines.
 */
export function buildLaunchScript(
  command: string,
  scriptPreamble?: string,
): string {
  const scriptParts = ["#!/bin/bash"];
  if (scriptPreamble) {
    scriptParts.push(
      scriptPreamble.replace(/[\x00-\x1f\x7f]+/g, " ").trimEnd(),
    );
  }
  scriptParts.push(command);
  return `${scriptParts.join("\n")}\n`;
}

export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  writeFileSync(
    scriptPath,
    buildLaunchScript(command, options?.scriptPreamble),
    {
      mode: 0o755,
    },
  );
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/**
 * One spec for sync and async screen reads — the five backends differ only
 * in argv and whether the output needs tailing. Two sync-only quirks are
 * preserved deliberately: cmux reads via a shell string (historical shape)
 * and zellij scopes ZELLIJ_PANE_ID into the env.
 */
function screenReadPlan(
  backend: MuxBackend,
  surface: string,
  lines: number,
): {
  file: string;
  args: string[];
  tail: boolean;
  shell?: string;
  env?: NodeJS.ProcessEnv;
} {
  switch (backend) {
    case "cmux":
      return {
        file: "cmux",
        args: ["read-screen", "--surface", surface, "--lines", String(lines)],
        tail: false,
        shell: `cmux read-screen --surface ${shellEscape(surface)} --lines ${lines}`,
      };
    case "tmux":
      return {
        file: "tmux",
        args: [
          "capture-pane",
          "-p",
          "-t",
          surface,
          "-S",
          `-${Math.max(1, lines)}`,
        ],
        tail: false,
      };
    case "herdr":
      return {
        file: "herdr",
        args: ["pane", "read", surface, "--lines", String(Math.max(1, lines))],
        tail: false,
      };
    case "wezterm":
      return {
        file: "wezterm",
        args: ["cli", "get-text", "--pane-id", surface],
        tail: true,
      };
    case "zellij":
      // Zellij 0.44+: dump-screen to stdout via --pane-id instead of env var
      // + temp file. The ZELLIJ_PANE_ID env var doesn't reliably target other
      // panes for dump-screen, and --path may silently fail to create the
      // file. Stdout capture is robust.
      return {
        file: "zellij",
        args: zellijActionArgs(["dump-screen"], surface),
        tail: true,
        env: zellijEnv(surface),
      };
  }
}

/**
 * Read the screen contents of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  const plan = screenReadPlan(requireMuxBackend(), surface, lines);
  const raw =
    plan.shell !== undefined
      ? execSync(plan.shell, { encoding: "utf8" })
      : execFileSync(plan.file, plan.args, {
          encoding: "utf8",
          env: plan.env,
        });
  return plan.tail ? tailLines(raw, lines) : raw;
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(
  surface: string,
  lines = 50,
): Promise<string> {
  const plan = screenReadPlan(requireMuxBackend(), surface, lines);
  const { stdout } = await execFileAsync(plan.file, plan.args, {
    encoding: "utf8",
  });
  return plan.tail ? tailLines(stdout, lines) : stdout;
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    cmuxBackend.closeSurface(surface);
    return;
  }

  if (backend === "tmux") {
    tmux.closeSurface(surface);
    return;
  }

  if (backend === "herdr") {
    herdr.closeSurface(surface);
    return;
  }

  if (backend === "wezterm") {
    wezterm.closeSurface(surface);
    return;
  }

  zellij.closeSurface(surface);
}
