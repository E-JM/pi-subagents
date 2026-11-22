import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
 * History lines seeded into a forked child session: truncated before the
 * parent's latest user message (the child gets the task as its first prompt
 * instead), with prior `session` headers stripped so the child writes its own.
 */
function getForkContentLines(parentSessionFile: string): string[] {
  const raw = readFileSync(parentSessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());

  let truncateAt = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
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

/**
 * Pre-create the child's session file: header (with parent link) plus forked
 * entries, so the watcher can read before the child's first write.
 */
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
 * Find the last assistant message text, falling back to `errorMessage` when that
 * message is a `stopReason: "error"` turn with no usable text — otherwise the
 * parent would be handed a stale earlier message.
 */
export function findLastAssistantMessage(
  entries: SessionEntry[],
): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const msg = entry as MessageEntry;
    if (msg.message.role !== "assistant") continue;

    const texts = assistantTexts(msg);
    if (texts.length > 0 && texts.join("").trim()) return texts.join("\n");

    const error = assistantErrorText(msg);
    if (error) return error;
  }
  return null;
}
