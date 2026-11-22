import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { elapsedSeconds } from "../format.ts";
import {
  clearStoredInterval,
  getLatestContext,
  getStoredInterval,
  globalStore,
  type RunningSubagent,
  registry,
  statusConfig,
  WIDGET_INTERVAL_KEY,
} from "../state.ts";
import { classifyStatus, type StatusSnapshot } from "../status/snapshot.ts";

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

function formatElapsedMMSS(startTime: number): string {
  const seconds = elapsedSeconds(startTime);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

/** Bordered content line: │left          right│; left truncates first. */
export function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;

  const contentWidth = Math.max(0, width - 2);
  const rightVis = visibleWidth(right);

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

/** Top border: ╭─ Title ──── info ─╮, sized to `width`. */
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

  if (registry.isEmpty()) {
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
          return renderSubagentWidgetLines(registry.all(), width);
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

export function startWidgetRefresh() {
  if (getStoredInterval(WIDGET_INTERVAL_KEY)) return;
  updateWidget();
  globalStore[WIDGET_INTERVAL_KEY] = setInterval(() => {
    updateWidget();
  }, 1000);
}
