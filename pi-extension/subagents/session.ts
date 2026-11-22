import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface SessionEntry {
  type: string;
  id: string;
  parentId?: string;
  [key: string]: unknown;
}

interface MessageEntry extends SessionEntry {
  type: "message";
  message: {
    role: "user" | "assistant" | "toolResult";
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  };
}

export type SeededSubagentSessionMode = "lineage-only" | "fork";

/**
 * History lines seeded into a forked child session.
 *
 * Two rules: (1) the seeded history is truncated BEFORE (excluding) the
 * parent's most recent user message — the child must not see its own task
 * twice, since the task is delivered separately as the child's first prompt;
 * (2) prior `session` header lines are stripped because the child writes its
 * own header (seedSubagentSessionFile prepends it).
 */
function getForkContentLines(parentSessionFile: string): string[] {
  const raw = readFileSync(parentSessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());

  let truncateAt = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === "message" && entry.message?.role === "user") {
        truncateAt = i;
        break;
      }
    } catch {
      // ignore malformed lines
    }
  }

  return lines.slice(0, truncateAt).filter((line) => {
    try {
      return JSON.parse(line).type !== "session";
    } catch {
      return true;
    }
  });
}

export function seedSubagentSessionFile(params: {
  mode: SeededSubagentSessionMode;
  parentSessionFile: string;
  childSessionFile: string;
  childCwd: string;
}): void {
  const header = {
    type: "session",
    version: 3,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: params.childCwd,
    parentSession: params.parentSessionFile,
  };
  const contentLines =
    params.mode === "fork" ? getForkContentLines(params.parentSessionFile) : [];
  const lines = [JSON.stringify(header), ...contentLines];

  mkdirSync(dirname(params.childSessionFile), { recursive: true });
  writeFileSync(params.childSessionFile, `${lines.join("\n")}\n`, "utf8");
}

/**
 * Return entries after skipping the first `afterLine` lines (a previously
 * recorded entry count). `0` returns all entries.
 */
export function getNewEntries(
  sessionFile: string,
  afterLine: number,
): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());
  return lines.slice(afterLine).map((line) => JSON.parse(line) as SessionEntry);
}

/** Non-empty text blocks of an assistant message, in order. */
function assistantTexts(msg: MessageEntry): string[] {
  return msg.message.content
    .filter(
      (block) =>
        block.type === "text" &&
        typeof block.text === "string" &&
        block.text.trim() !== "",
    )
    .map((block) => block.text as string);
}

/** Error text when the assistant turn ended with a surfaced error. */
function assistantErrorText(msg: MessageEntry): string | null {
  const stopReason = (msg.message as { stopReason?: unknown }).stopReason;
  const errorMessage = (msg.message as { errorMessage?: unknown }).errorMessage;
  if (
    stopReason === "error" &&
    typeof errorMessage === "string" &&
    errorMessage.trim() !== ""
  ) {
    return `Subagent error: ${errorMessage.trim()}`;
  }
  return null;
}

/**
 * Find the last assistant message text in a list of entries.
 *
 * Falls back to the `errorMessage` field when the last assistant message has
 * `stopReason: "error"` and no usable text content — this happens when
 * auto-retry exhausts on a provider overload / rate limit / server error, and
 * without this fallback the parent would silently see a stale earlier message.
 */
export function findLastAssistantMessage(
  entries: SessionEntry[],
): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const msg = entry as MessageEntry;
    if (msg.message.role !== "assistant") continue;

    const texts = assistantTexts(msg);
    if (texts.length > 0 && texts.join("").trim()) return texts.join("\n");

    const error = assistantErrorText(msg);
    if (error) return error;
  }
  return null;
}

/**
 * Return the index of the last assistant message entry, or -1 when the
 * session has none. The waiting-delivery lane uses it as its growth guard:
 * a re-delivery is only allowed when a NEW assistant message exists (growth
 * from user entries alone must not re-steer the previous closing text).
 */
export function findLastAssistantIndex(entries: SessionEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    if ((entry as MessageEntry).message?.role === "assistant") return i;
  }
  return -1;
}
