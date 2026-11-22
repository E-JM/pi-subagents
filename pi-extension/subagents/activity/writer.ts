import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SubagentActivityEvent, SubagentActivityState } from "./schema.ts";

const ACTIVITY_UPDATE_THROTTLE_MS = 500;
const MAX_WRITE_FAILURES = 3;

/**
 * Persistence for one child's snapshot: apply an event's update, then write it
 * — now or throttled — and keep updatedAt fresh while active.
 */
export interface ActivityWriter {
  record(
    latestEvent: SubagentActivityEvent,
    update: (current: SubagentActivityState, now: number) => void,
    flush: "immediate" | "throttled",
  ): void;
  disable(): void;
}

export function createActivityWriter(params: {
  activityFile: string;
  activity: SubagentActivityState;
  now: () => number;
  heartbeatMs: number;
}): ActivityWriter {
  const { activityFile, activity, now, heartbeatMs } = params;

  let disabled = false;
  let failureCount = 0;
  let lastFlushAt = 0;
  let pendingFlush: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  function clearPendingFlush(): void {
    if (!pendingFlush) return;
    clearTimeout(pendingFlush);
    pendingFlush = null;
  }

  function stopHeartbeat(): void {
    if (!heartbeat) return;
    clearInterval(heartbeat);
    heartbeat = null;
  }

  function disable(): void {
    disabled = true;
    clearPendingFlush();
    stopHeartbeat();
  }

  /**
   * A long silent stretch (quiet bash, slow provider) looks identical to a hung
   * child, so refresh updatedAt/sequence while active. latestEvent is left
   * alone so it still reports the real last event.
   */
  function syncHeartbeat(): void {
    if (!disabled && activity.phase === "active") {
      if (!heartbeat) {
        heartbeat = setInterval(() => {
          if (disabled) {
            stopHeartbeat();
            return;
          }
          activity.updatedAt = now();
          activity.sequence += 1;
          flushNow();
        }, heartbeatMs);
        // Never keep the child process alive just for the heartbeat.
        heartbeat.unref?.();
      }
      return;
    }
    stopHeartbeat();
  }

  function flushNow(): void {
    if (disabled) return;
    try {
      writeSubagentActivityFile(activityFile, activity);
      lastFlushAt = now();
      failureCount = 0;
    } catch {
      // Swallowed per attempt; MAX_WRITE_FAILURES consecutive failures disable
      // the writer.
      failureCount += 1;
      if (failureCount >= MAX_WRITE_FAILURES) disable();
    }
  }

  function scheduleFlush(): void {
    if (disabled || pendingFlush) return;

    const remainingMs = Math.max(
      0,
      ACTIVITY_UPDATE_THROTTLE_MS - (now() - lastFlushAt),
    );
    if (remainingMs === 0) {
      flushNow();
      return;
    }

    pendingFlush = setTimeout(() => {
      pendingFlush = null;
      flushNow();
    }, remainingMs);
  }

  function record(
    latestEvent: SubagentActivityEvent,
    update: (current: SubagentActivityState, now: number) => void,
    flush: "immediate" | "throttled",
  ): void {
    if (disabled) return;
    if (flush === "immediate") clearPendingFlush();

    const observedAt = now();
    activity.latestEvent = latestEvent;
    activity.updatedAt = observedAt;
    activity.sequence += 1;
    update(activity, observedAt);

    if (flush === "immediate") flushNow();
    else scheduleFlush();
    syncHeartbeat();
  }

  return { record, disable };
}

/** Temp file + rename, so readers never see a half-written snapshot. */
function writeSubagentActivityFile(
  activityFile: string,
  activity: SubagentActivityState,
): void {
  const dir = dirname(activityFile);
  mkdirSync(dir, { recursive: true });
  const tempFile = join(
    dir,
    `${activity.runningChildId}.json.${process.pid}.${activity.sequence}.tmp`,
  );

  try {
    writeFileSync(tempFile, `${JSON.stringify(activity)}\n`, "utf8");
    renameSync(tempFile, activityFile);
  } catch (error) {
    try {
      unlinkSync(tempFile);
    } catch (cleanupError) {
      // Best effort; keep the original write/rename failure.
      void cleanupError;
    }
    throw error;
  }
}
