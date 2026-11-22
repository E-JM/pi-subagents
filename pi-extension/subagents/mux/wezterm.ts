import { execFileSync } from "node:child_process";

export function createWeztermSurface(name: string): string {
  // wezterm: split the parent (no pane-position API for a balanced layout yet).
  return createWeztermSplitSurface(name, "right", process.env.WEZTERM_PANE);
}

export function createWeztermSplitSurface(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  const args = ["cli", "split-pane"];
  if (direction === "left") args.push("--left");
  else if (direction === "right") args.push("--right");
  else if (direction === "up") args.push("--top");
  else args.push("--bottom");
  args.push("--cwd", process.cwd());
  if (fromSurface) {
    args.push("--pane-id", fromSurface);
  }
  const paneId = execFileSync("wezterm", args, { encoding: "utf8" }).trim();
  if (!paneId || !/^\d+$/.test(paneId)) {
    throw new Error(
      `Unexpected wezterm split-pane output: ${paneId || "(empty)"}`,
    );
  }
  try {
    execFileSync(
      "wezterm",
      ["cli", "set-tab-title", "--pane-id", paneId, name],
      {
        encoding: "utf8",
      },
    );
  } catch {
    // Optional — tab title is cosmetic.
  }
  return paneId;
}

export function renameCurrentTab(title: string): void {
  const paneId = process.env.WEZTERM_PANE;
  const args = ["cli", "set-tab-title"];
  if (paneId) args.push("--pane-id", paneId);
  args.push(title);
  execFileSync("wezterm", args, { encoding: "utf8" });
  return;
}

export function renameWorkspace(title: string): void {
  const paneId = process.env.WEZTERM_PANE;
  const args = ["cli", "set-window-title"];
  if (paneId) args.push("--pane-id", paneId);
  args.push(title);
  try {
    execFileSync("wezterm", args, { encoding: "utf8" });
  } catch {
    // Optional — window title is cosmetic.
  }
  return;
}

export function sendCommand(surface: string, command: string): void {
  execFileSync(
    "wezterm",
    ["cli", "send-text", "--pane-id", surface, "--no-paste", `${command}\n`],
    { encoding: "utf8" },
  );
  return;
}

export function sendEscape(surface: string): void {
  execFileSync(
    "wezterm",
    ["cli", "send-text", "--pane-id", surface, "--no-paste", "\u001b"],
    {
      encoding: "utf8",
    },
  );
  return;
}

export function closeSurface(surface: string): void {
  execFileSync("wezterm", ["cli", "kill-pane", "--pane-id", surface], {
    encoding: "utf8",
  });
  return;
}
