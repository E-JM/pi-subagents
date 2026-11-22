// Per-backend dispatch for the subagent surface API.

import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { shellEscape } from "../shell.ts";
import {
  getMuxBackend,
  type MuxBackend,
  requireMuxBackend,
} from "./backend.ts";
import { execFileAsync, tailLines } from "./cli.ts";
import * as cmuxBackend from "./cmux-backend.ts";
import * as herdr from "./herdr/ops.ts";
import * as tmux from "./tmux/ops.ts";
import * as wezterm from "./wezterm.ts";
import * as zellij from "./zellij.ts";
import { zellijActionArgs, zellijEnv } from "./zellij.ts";

/** One op set per backend; the Record annotation makes a missing entry a type error. */
const backendOps: Record<
  MuxBackend,
  {
    createSurface(name: string): string;
    createSplit(
      name: string,
      direction: "left" | "right" | "up" | "down",
      fromSurface?: string,
    ): string;
    renameCurrentTab(title: string): void;
    renameWorkspace(title: string): void;
    sendCommand(surface: string, command: string): void;
    sendEscape(surface: string): void;
    closeSurface(surface: string): void;
  }
> = {
  cmux: {
    createSurface: cmuxBackend.createCmuxSubagentSurface,
    createSplit: (name, direction, fromSurface) =>
      cmuxBackend.createCmuxSplitSurface(name, direction, fromSurface).surface,
    renameCurrentTab: cmuxBackend.renameCurrentTab,
    renameWorkspace: cmuxBackend.renameWorkspace,
    sendCommand: cmuxBackend.sendCommand,
    sendEscape: cmuxBackend.sendEscape,
    closeSurface: cmuxBackend.closeSurface,
  },
  zellij: {
    createSurface: zellij.createZellijSurface,
    createSplit: zellij.createZellijSplitSurface,
    renameCurrentTab: zellij.renameCurrentTab,
    renameWorkspace: zellij.renameWorkspace,
    sendCommand: zellij.sendCommand,
    sendEscape: zellij.sendEscape,
    closeSurface: zellij.closeSurface,
  },
  herdr: {
    createSurface: herdr.createHerdrSubagentSurface,
    createSplit: herdr.createHerdrSplitSurface,
    renameCurrentTab: herdr.renameCurrentTab,
    renameWorkspace: herdr.renameWorkspace,
    sendCommand: herdr.sendCommand,
    sendEscape: herdr.sendEscape,
    closeSurface: herdr.closeSurface,
  },
  tmux: {
    createSurface: tmux.createTmuxSubagentSurface,
    createSplit: tmux.createTmuxSplitSurface,
    renameCurrentTab: tmux.renameCurrentTab,
    renameWorkspace: tmux.renameWorkspace,
    sendCommand: tmux.sendCommand,
    sendEscape: tmux.sendEscape,
    closeSurface: tmux.closeSurface,
  },
  wezterm: {
    createSurface: wezterm.createWeztermSurface,
    createSplit: wezterm.createWeztermSplitSurface,
    renameCurrentTab: wezterm.renameCurrentTab,
    renameWorkspace: wezterm.renameWorkspace,
    sendCommand: wezterm.sendCommand,
    sendEscape: wezterm.sendEscape,
    closeSurface: wezterm.closeSurface,
  },
};

/** Create a subagent surface; returns a backend-specific pane id (`%12`, `pane:7`, `w1:p7`). */
export function createSurface(name: string): string {
  // Historical fallback: no detected backend routes to wezterm.
  const backend = getMuxBackend() ?? "wezterm";
  return backendOps[backend].createSurface(name);
}

export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  return backendOps[requireMuxBackend()].createSplit(
    name,
    direction,
    fromSurface,
  );
}

export function renameCurrentTab(title: string): void {
  backendOps[requireMuxBackend()].renameCurrentTab(title);
}

export function renameWorkspace(title: string): void {
  backendOps[requireMuxBackend()].renameWorkspace(title);
}

export function sendCommand(surface: string, command: string): void {
  backendOps[requireMuxBackend()].sendCommand(surface, command);
}

export function sendEscape(surface: string): void {
  backendOps[requireMuxBackend()].sendEscape(surface);
}

/** Assemble the launch script, scrubbing control characters from the preamble
 * so a crafted subagent name cannot break out of the comment. */
export function buildLaunchScript(
  command: string,
  scriptPreamble?: string,
): string {
  const scriptParts = ["#!/bin/bash"];
  if (scriptPreamble) {
    scriptParts.push(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: preamble lines must not smuggle control characters into the launch script
      scriptPreamble.replace(/[\x00-\x1f\x7f]+/g, " ").trimEnd(),
    );
  }
  scriptParts.push(command);
  return `${scriptParts.join("\n")}\n`;
}

/** Send a long command via a script file: sending it in-band breaks on wrapped
 * lines. Returns the script path. */
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

/** Shared read plan: cmux needs a shell string, zellij scopes ZELLIJ_PANE_ID. */
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
      // Zellij 0.44+: dump to stdout via --pane-id. The env var does not
      // reliably target other panes and --path may fail to create the file.
      return {
        file: "zellij",
        args: zellijActionArgs(["dump-screen"], surface),
        tail: true,
        env: zellijEnv(surface),
      };
  }
}

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
 * Close a pane. Idempotent: these calls race the user's own subagent_close, so
 * an unreachable pane is not an error.
 */
export function closeSurface(surface: string): void {
  try {
    backendOps[requireMuxBackend()].closeSurface(surface);
  } catch {
    // Already gone.
  }
}
