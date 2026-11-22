import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to `pi-extension/subagents`. https://github.com/nodejs/node/issues/37845 */
export const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

/** Filesystem-safe artifact name fragment, or `fallback` when nothing is left. */
export function safeFileName(name: string, fallback: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || fallback;
}

/** Timestamp fragment safe for file names, e.g. `2026-01-02T03-04-05`. */
export function fileTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/** Per-session artifact directory: `<sessionDir>/artifacts/<sessionId>/`. */
export function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

export function writeArtifactFile(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}
