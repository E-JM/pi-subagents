// Widget + custom-message rendering for the subagents extension.
import {
  type ExtensionAPI,
  keyHint,
  type Theme,
} from "@mariozechner/pi-coding-agent";
import { Box, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { AgentSource } from "./agents.ts";
import {
  clearStoredInterval,
  getLatestContext,
  getStoredInterval,
  globalStore,
  runningSubagents,
  statusConfig,
  WIDGET_INTERVAL_KEY,
  type RunningSubagent,
} from "./state.ts";
import { classifyStatus, type StatusSnapshot } from "./status.ts";
import { elapsedSeconds, formatElapsed } from "./util.ts";

export function formatWidgetRightLabel(snapshot: StatusSnapshot): string {
  if (snapshot.kind === "starting") return " starting… ";
  if (snapshot.kind === "running") return ` running ${snapshot.elapsedText} `;
  if (snapshot.kind === "active") {
    const label = snapshot.activityLabel ?? snapshot.activeScope;
    const duration = snapshot.activeDurationText
      ? ` ${snapshot.activeDurationText}`
      : "";
    return label ? ` active · ${label}${duration} ` : " active ";
  }
  if (snapshot.kind === "waiting") {
    const duration = snapshot.waitingDurationText
      ? ` ${snapshot.waitingDurationText}`
      : "";
    const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
    return ` waiting${duration}${detail} `;
  }

  const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
  const duration = snapshot.snapshotProblemText
    ? ` ${snapshot.snapshotProblemText}`
    : "";
  return ` stalled${detail}${duration} `;
}

/**
 * Label lines shared between the subagent_result producers and the collapsing
 * renderer (which strips them off to display a clean summary). Both sides
 * derive from these helpers so the wording can never drift apart.
 */
export function resultLabelCompleted(
  name: string,
  elapsedText: string,
): string {
  return `Sub-agent "${name}" completed (${elapsedText}).`;
}

export function resultLabelFailedExit(name: string, exitCode: number): string {
  return `Sub-agent "${name}" failed (exit code ${exitCode}).`;
}

export function resultLabelProviderError(
  name: string,
  elapsedText: string,
): string {
  return `Sub-agent "${name}" failed after ${elapsedText} (provider/agent error — auto-retry exhausted).`;
}

/** "▸ <target> — <action>" line shared by the target-taking tools' renderers. */
export function targetCallText(
  target: string,
  theme: Theme,
  action: string,
): Text {
  return new Text(
    theme.fg("accent", "▸") +
      " " +
      theme.fg("toolTitle", theme.bold(target)) +
      theme.fg("dim", ` — ${action}`),
    0,
    0,
  );
}

/** Call header variant resolving the target from tool-call args. */
export function renderTargetCall(
  args: { id?: string; name?: string },
  theme: Theme,
  action: string,
) {
  const target = args.id ? `${args.id}` : (args.name ?? "(unknown)");
  return targetCallText(target, theme, action);
}

/** Dim text fallback when a tool result carries no presentable details. */
export function renderResultFallback(
  result: { content: Array<{ text?: unknown }> },
  theme: Theme,
) {
  const text =
    typeof result.content[0]?.text === "string" ? result.content[0].text : "";
  return new Text(theme.fg("dim", text as string), 0, 0);
}

/** Collapsed-view hint line shared by the subagent message renderers. */
function expandHint(theme: Theme): string {
  return theme.fg("muted", keyHint("app.tools.expand", "to expand"));
}

/** Message-renderer tail: content lines in a padded, backgrounded box with a blank separator line. */
function renderBoxLines(
  contentLines: string[],
  bgFn: (text: string) => string,
  width: number,
): string[] {
  const box = new Box(1, 1, bgFn);
  box.addChild(new Text(contentLines.join("\n"), 0, 0));
  return ["", ...box.render(width)];
}

function formatElapsedMMSS(startTime: number): string {
  const seconds = elapsedSeconds(startTime);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left is truncated first when both need space; right is truncated only when
 * it alone exceeds the line width.
 */
export function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;

  const contentWidth = Math.max(0, width - 2);
  const rightVis = visibleWidth(right);

  // Prefer a compact right chunk over overflowing the terminal.
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${ACCENT}│${RST}${truncRight}${" ".repeat(rightPad)}${ACCENT}│${RST}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

/** Top border: ╭─ Title ──── info ─╮ — all chars accounted for within `width`. */
function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╭${RST}`;

  const inner = Math.max(0, width - 2);
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`
    .slice(0, inner)
    .padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;

  const inner = Math.max(0, width - 2);
  return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

export function renderSubagentWidgetLines(
  agents: RunningSubagent[],
  width: number,
): string[] {
  const count = agents.length;
  const title = "Subagents";
  const info = `${count} running`;

  const lines: string[] = [borderTop(title, info, width)];

  for (const agent of agents) {
    const elapsed = formatElapsedMMSS(agent.startTime);
    const agentTag = agent.agent ? ` (${agent.agent})` : "";
    const left = ` ${elapsed}  ${agent.name}${agentTag} `;
    const snapshot = classifyStatus(agent.statusState, Date.now());
    const right = statusConfig.enabled
      ? formatWidgetRightLabel(snapshot)
      : agent.cli === "claude"
        ? " running… "
        : " starting… ";

    lines.push(borderLine(left, right, width));
  }

  lines.push(borderBottom(width));
  return lines;
}

export function updateWidget() {
  const latestCtx = getLatestContext();
  if (!latestCtx?.hasUI) return;

  if (runningSubagents.size === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    clearStoredInterval(WIDGET_INTERVAL_KEY);
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui, _theme) => {
      return {
        invalidate() {},
        render(width: number) {
          return renderSubagentWidgetLines(
            Array.from(runningSubagents.values()),
            width,
          );
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

export function startWidgetRefresh() {
  if (getStoredInterval(WIDGET_INTERVAL_KEY)) return;
  updateWidget(); // immediate first render
  globalStore[WIDGET_INTERVAL_KEY] = setInterval(() => {
    updateWidget();
  }, 1000);
}

/**
 * Loose view of the `details` payloads this extension attaches to custom
 * messages and tool results. The pi API types them only as opaque records,
 * so renderers narrow them through this interface.
 */
export interface SubagentDetailsPayload {
  name?: string;
  id?: string;
  agent?: string;
  status?: string;
  error?: string;
  exitCode?: number;
  elapsed?: number;
  errorMessage?: string;
  sessionFile?: string;
  message?: string;
  agents?: Array<{
    name: string;
    source?: AgentSource;
    description?: string;
    model?: string;
  }>;
  lines?: string[];
  overflow?: number;
}

export function detailsOf(value: unknown): SubagentDetailsPayload {
  return (
    typeof value === "object" && value !== null ? value : {}
  ) as SubagentDetailsPayload;
}

export function registerSubagentMessageRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    if (message.details == null) return undefined;
    const details = detailsOf(message.details);

    return {
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const errorText =
          typeof details.errorMessage === "string" ? details.errorMessage : "";
        const failed = exitCode !== 0 || !!errorText;
        const elapsed =
          details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgFn = failed
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
        const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const status = errorText
          ? "failed (provider/agent error)"
          : failed
            ? `failed (exit ${exitCode})`
            : "completed";
        const agentTag = details.agent
          ? theme.fg("dim", ` (${details.agent})`)
          : "";

        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
        const rawContent =
          typeof message.content === "string" ? message.content : "";

        // Clean summary (remove session ref and leading label for display).
        // The label lines come from the resultLabel* helpers above.
        const summary = rawContent
          .replace(/\n\nSession: .+\nResume with subagent_message[^\n]*$/, "")
          .replace(`${resultLabelCompleted(name, elapsed)}\n\n`, "")
          .replace(`${resultLabelFailedExit(name, exitCode)}\n\n`, "")
          .replace(`${resultLabelProviderError(name, elapsed)}\n\n`, "");

        const contentLines = [header];

        if (options.expanded) {
          if (summary) {
            for (const line of summary.split("\n")) {
              contentLines.push(line.slice(0, width - 6));
            }
          }
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(
              theme.fg("dim", `Session: ${details.sessionFile}`),
            );
            contentLines.push(
              theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`),
            );
          }
        } else {
          if (summary) {
            const previewLines = summary.split("\n").slice(0, 5);
            for (const line of previewLines) {
              contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
            }
            const totalLines = summary.split("\n").length;
            if (totalLines > 5) {
              contentLines.push(
                theme.fg("muted", `… ${totalLines - 5} more lines`),
              );
            }
          }
          contentLines.push(expandHint(theme));
        }

        return renderBoxLines(contentLines, bgFn, width);
      },
    };
  });

  pi.registerMessageRenderer("subagent_status", (message, options, theme) => {
    const details = detailsOf(message.details);
    const lines = Array.isArray(details.lines) ? details.lines : [];
    const overflow =
      typeof details.overflow === "number" ? details.overflow : 0;
    if (lines.length === 0 && overflow === 0) return undefined;

    return {
      render(width: number): string[] {
        const lineWidth = Math.max(0, width - 6);
        const contentLines = [
          `${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
          ...lines.map((line: string) =>
            theme.fg("dim", truncateToWidth(line, lineWidth)),
          ),
        ];

        if (overflow > 0) {
          contentLines.push(theme.fg("muted", `+${overflow} more running.`));
        }
        if (!options.expanded) {
          contentLines.push(expandHint(theme));
        }

        return renderBoxLines(
          contentLines,
          (text: string) => theme.bg("customMessageBg", text),
          width,
        );
      },
    };
  });

  pi.registerMessageRenderer("subagent_ask", (message, options, theme) => {
    if (message.details == null) return undefined;
    const details = detailsOf(message.details);

    return {
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const agentTag = details.agent
          ? theme.fg("dim", ` (${details.agent})`)
          : "";
        const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

        const icon = theme.fg("accent", "?");
        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— asks")}`;

        const contentLines = [header];

        if (options.expanded) {
          contentLines.push("");
          contentLines.push(details.message ?? "");
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(
              theme.fg("dim", `Session: ${details.sessionFile}`),
            );
          }
        } else {
          const preview = (details.message ?? "")
            .split("\n")[0]
            .slice(0, width - 10);
          contentLines.push(theme.fg("dim", preview));
          contentLines.push(expandHint(theme));
        }

        return renderBoxLines(contentLines, bgFn, width);
      },
    };
  });
}
