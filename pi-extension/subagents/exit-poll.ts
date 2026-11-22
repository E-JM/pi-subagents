// Exit polling via the `.exit` sidecar, screen-sentinel crash fallback, and `.ask` questions.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { isPlainObject } from "./guards.ts";
import { readScreenAsync } from "./mux/api.ts";
import { getMuxBackend } from "./mux/backend.ts";
import { isHerdrAgentWorking, waitHerdrAgentSettled } from "./mux/herdr/ops.ts";

export interface PollResult {
  reason: "done" | "sentinel" | "error";
  /** Shell exit code from the sentinel; 0 for file-based exits. */
  exitCode: number;
  errorMessage?: string;
}

export interface AskPayload {
  name: string;
  message: string;
}

/** Read and consume the `.exit` sidecar; null if absent or unreadable. */
function readExitSidecar(sessionFile: string): PollResult | null {
  const exitFile = `${sessionFile}.exit`;
  try {
    if (!existsSync(exitFile)) return null;
    const data = JSON.parse(readFileSync(exitFile, "utf8"));
    rmSync(exitFile, { force: true });
    return interpretExitSidecar(data);
  } catch {
    return null;
  }
}

// One decoder so the fast and slow poll paths agree.
function interpretExitSidecar(data: unknown): PollResult {
  const payload = isPlainObject(data) ? data : {};

  if (payload.type === "error") {
    const errorMessage =
      typeof payload.errorMessage === "string" &&
      payload.errorMessage.trim() !== ""
        ? payload.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

// Consuming (deleting) the file is what makes `.ask` a one-shot channel.
function readAskSidecar(sessionFile: string): AskPayload | null {
  const askFile = `${sessionFile}.ask`;
  if (!existsSync(askFile)) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(askFile, "utf8"));
  } catch (error) {
    // Consumed between the existsSync probe and this read: nothing to deliver.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    // Corrupt (killed mid-write): unlink so it cannot poison every tick, and
    // surface a synthetic ask.
    rmSync(askFile, { force: true });
    return {
      name: "subagent",
      message:
        "(unreadable .ask sidecar — the subagent may be blocked awaiting a reply it will never see)",
    };
  }
  rmSync(askFile, { force: true });
  const payload = isPlainObject(data) ? data : {};
  return {
    name: typeof payload.name === "string" ? payload.name : "subagent",
    message: typeof payload.message === "string" ? payload.message : "",
  };
}

// The echo emits the sentinel as a whole line, so only a full-line match counts:
// a literal pasted mid-text must not read as completion.
export function matchScreenSentinel(screen: string): number | null {
  const match = screen.match(/^[ \t]*__SUBAGENT_DONE_(\d+)__[ \t\r]*$/m);
  const code = match?.[1];
  return code ? Number.parseInt(code, 10) : null;
}

export const __pollForExitTest__ = {
  interpretExitSidecar,
  readAskSidecar,
  matchScreenSentinel,
};

// Poll until exit: `.exit` sidecar first, then the screen sentinel for crashes.
// `.ask` is consumed non-terminally via onAsk.
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onAsk?: (ask: AskPayload) => void;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written at turn-end exit)
    if (options.sessionFile) {
      const sidecar = readExitSidecar(options.sessionFile);
      if (sidecar) return sidecar;
    }

    // Non-terminal ask channel: surface the question, keep polling.
    if (options.sessionFile) {
      const ask = readAskSidecar(options.sessionFile);
      if (ask) options.onAsk?.(ask);
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {
        // Unreadable sentinel path: fall through to the screen check.
      }
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      const exitCode = matchScreenSentinel(screen);
      if (exitCode != null) {
        return { reason: "sentinel", exitCode };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        const sidecar = readExitSidecar(options.sessionFile);
        if (sidecar) return sidecar;
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    // herdr: block on `agent wait` instead of blind sampling — it returns as
    // soon as the agent settles (idle/blocked/gone), avoiding a hot loop.
    if (getMuxBackend() === "herdr" && (await isHerdrAgentWorking(surface))) {
      await waitHerdrAgentSettled(surface, options.interval, signal);
      continue;
    }

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
