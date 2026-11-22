/**
 * Exit-polling for a running subagent pane: the `.exit` sidecar protocol
 * (written by the child's child.ts extension) with a screen-sentinel
 * fallback for crash detection, plus the non-terminal `.ask` sidecar that
 * surfaces ask_question payloads to the parent while the child keeps
 * running.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { promisify } from "node:util";
import { getMuxBackend, isHerdrAgentWorking, readScreenAsync } from "./cmux.ts";

const execFileAsync = promisify(execFile);

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/** An ask_question payload written by the child's `.ask` sidecar. */
export interface AskPayload {
  name: string;
  message: string;
}

/** Shape of the `.exit` sidecar JSON written by the child extension. */
interface ExitSidecarPayload {
  type?: unknown;
  errorMessage?: unknown;
}

/**
 * Read + consume the `.exit` sidecar for a session file. Returns the decoded
 * PollResult, or null when the sidecar does not exist / is not yet readable.
 */
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

/**
 * Interpret an `.exit` sidecar payload (written by the child extension on
 * turn-end auto-exit). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way.
 */
function interpretExitSidecar(data: unknown): PollResult {
  const payload = (
    typeof data === "object" && data !== null ? data : {}
  ) as ExitSidecarPayload;

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

/**
 * Read + consume the non-terminal `.ask` sidecar for a session file.
 * Returns the ask payload, or null when the sidecar does not exist / is not
 * yet readable. Consuming (deleting) the file is what makes it a one-shot
 * channel — the child writes a fresh file per ask_question call.
 */
function readAskSidecar(sessionFile: string): AskPayload | null {
  const askFile = `${sessionFile}.ask`;
  if (!existsSync(askFile)) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(askFile, "utf8"));
  } catch (error) {
    // Consumed between the existsSync probe and this read (e.g. the resume
    // path's stale-sidecar cleanup): not corrupt, nothing to deliver.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    // Corrupt sidecar (killed mid-write): unlink it so this tick cannot
    // become a permanent poison pill, and surface a synthetic ask so the
    // failure is visible instead of the question silently vanishing while
    // the child sits in awaiting-reply forever.
    rmSync(askFile, { force: true });
    return {
      name: "subagent",
      message:
        "(unreadable .ask sidecar — the subagent may be blocked awaiting a reply it will never see)",
    };
  }
  rmSync(askFile, { force: true });
  const payload = (typeof data === "object" && data !== null ? data : {}) as {
    name?: unknown;
    message?: unknown;
  };
  return {
    name: typeof payload.name === "string" ? payload.name : "subagent",
    message: typeof payload.message === "string" ? payload.message : "",
  };
}

/**
 * Match the screen sentinel the launch command echoes on completion. The
 * echo emits the sentinel as a whole line (a fresh shell prompt follows on
 * the next line), so only a full-line match counts: a literal riding along
 * mid-text — pasted into the pane, printed by a subagent's bash output —
 * must not read as completion.
 */
export function matchScreenSentinel(screen: string): number | null {
  const match = screen.match(/^[ \t]*__SUBAGENT_DONE_(\d+)__[ \t\r]*$/m);
  return match ? Number.parseInt(match[1], 10) : null;
}

export const __pollForExitTest__ = {
  interpretExitSidecar,
  readAskSidecar,
  matchScreenSentinel,
};

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written on turn-end auto-exit), falling back to the terminal sentinel for
 * crash detection. A `.ask` sidecar is consumed non-terminally: pollForExit
 * calls options.onAsk with the payload and keeps polling.
 */
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
      } catch {}
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
      const wait = execFileAsync(
        "herdr",
        [
          "agent",
          "wait",
          surface,
          "--until",
          "idle",
          "--until",
          "blocked",
          "--until",
          "unknown",
          "--timeout",
          String(options.interval),
        ],
        { encoding: "utf8" },
      );
      const abort = new Promise<never>((_, reject) => {
        if (signal.aborted) {
          wait.child?.kill();
          return reject(new Error("Aborted"));
        }
        signal.addEventListener(
          "abort",
          () => {
            wait.child?.kill();
            reject(new Error("Aborted"));
          },
          { once: true },
        );
      });
      await Promise.race([
        wait.then(
          () => undefined,
          () => undefined,
        ),
        abort,
      ]);
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
