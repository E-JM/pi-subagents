import {
  type AgentToolResult,
  type ExtensionAPI,
  keyHint,
  type Theme,
} from "@mariozechner/pi-coding-agent";
import { Box, Text, truncateToWidth } from "@mariozechner/pi-tui";
import type { AgentSource } from "../agents.ts";
import { formatElapsed } from "../format.ts";
import { isPlainObject } from "../guards.ts";

/** Shared by result producers and the renderer that strips them, so wording can't drift. */
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

export function renderTargetCall(
  args: { id?: string; name?: string },
  theme: Theme,
  action: string,
) {
  const target = args.id ? `${args.id}` : (args.name ?? "(unknown)");
  return targetCallText(target, theme, action);
}

export function renderResultFallback(
  result: AgentToolResult<unknown>,
  theme: Theme,
) {
  const first = result.content[0];
  const text = first?.type === "text" ? first.text : "";
  return new Text(theme.fg("dim", text), 0, 0);
}

function expandHint(theme: Theme): string {
  return theme.fg("muted", keyHint("app.tools.expand", "to expand"));
}

/** Content lines in a padded box, preceded by a blank separator line. */
function renderBoxLines(
  contentLines: string[],
  bgFn: (text: string) => string,
  width: number,
): string[] {
  const box = new Box(1, 1, bgFn);
  box.addChild(new Text(contentLines.join("\n"), 0, 0));
  return ["", ...box.render(width)];
}

/** Loose view of the opaque `details` records pi attaches to messages. */
interface SubagentDetailsPayload {
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
  return (isPlainObject(value) ? value : {}) as SubagentDetailsPayload;
}

type RendererFactory = Parameters<ExtensionAPI["registerMessageRenderer"]>[1];

export function registerSubagentMessageRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer("subagent_result", renderResultMessage);
  pi.registerMessageRenderer("subagent_status", renderStatusMessage);
  pi.registerMessageRenderer("subagent_ask", renderAskMessage);
}

/** Finished run: icon, status, elapsed, and a summary preview. */
const renderResultMessage: RendererFactory = (message, options, theme) => {
  if (message.details == null) return undefined;
  const details = detailsOf(message.details);

  return {
    invalidate(): void {},
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

      // Strip the session trailer and the label lines added above.
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
          contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
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
};

/** One aggregated batch of status transitions. */
const renderStatusMessage: RendererFactory = (message, options, theme) => {
  const details = detailsOf(message.details);
  const lines = Array.isArray(details.lines) ? details.lines : [];
  const overflow = typeof details.overflow === "number" ? details.overflow : 0;
  if (lines.length === 0 && overflow === 0) return undefined;

  return {
    invalidate(): void {},
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
};

/** A child's ask_question, steered to the parent. */
const renderAskMessage: RendererFactory = (message, options, theme) => {
  if (message.details == null) return undefined;
  const details = detailsOf(message.details);

  return {
    invalidate(): void {},
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
          contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
        }
      } else {
        const [firstLine = ""] = (details.message ?? "").split("\n");
        const preview = firstLine.slice(0, width - 10);
        contentLines.push(theme.fg("dim", preview));
        contentLines.push(expandHint(theme));
      }

      return renderBoxLines(contentLines, bgFn, width);
    },
  };
};
