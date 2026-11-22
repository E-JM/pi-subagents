import type { SubagentActivityPhase } from "../activity/schema.ts";
import { formatElapsedDuration } from "../format.ts";

const SNAPSHOT_STALLED_AFTER_MS = 60_000;
// A heartbeating child refreshes updatedAt every 30s, so a frozen timestamp
// means a hung event loop. Waiting is exempt (an ask may wait forever).
const ACTIVE_STALLED_AFTER_MS = 90_000;

type SubagentStatusKind =
  | "starting"
  | "active"
  | "waiting"
  | "stalled"
  | "running";
type SubagentStatusSource = "pi" | "claude";
export type SubagentStatusTransition = "stalled" | "recovered" | null;
type StatusSnapshotState =
  | "unseen"
  | "present"
  | "missing"
  | "invalid"
  | "wrong-id";

type StatusObservation =
  | {
      snapshot: "present";
      updatedAt: number;
      sequence: number;
      phase: SubagentActivityPhase;
      active?: boolean;
      activeScope?: string;
      activeSince?: number;
      waitingSince?: number;
      latestEvent?: string;
      activityLabel?: string;
      heartbeatMs?: number;
    }
  | {
      snapshot: "missing" | "invalid" | "wrong-id";
      snapshotError?: string;
    };

export interface SubagentStatusState {
  source: SubagentStatusSource;
  startTimeMs: number;
  firstObservationAtMs: number | null;
  lastActivityAtMs: number | null;
  lastActivitySequence: number | null;
  activeNow: boolean;
  activeSinceMs: number | null;
  activeScope: string | null;
  waitingSinceMs: number | null;
  phase: SubagentActivityPhase | null;
  latestEvent: string | null;
  activityLabel: string | null;
  /** Heartbeat period the child advertised (null = older, silent child). */
  heartbeatMs: number | null;
  snapshotState: StatusSnapshotState;
  snapshotProblemSinceMs: number | null;
  snapshotError: string | null;
  currentKind: SubagentStatusKind;
}

export interface StatusSnapshot {
  kind: SubagentStatusKind;
  elapsedMs: number;
  elapsedText: string;
  activeSinceMs: number | null;
  activeDurationText: string | null;
  activeScope: string | null;
  waitingSinceMs: number | null;
  waitingDurationText: string | null;
  latestEvent: string | null;
  activityLabel: string | null;
  snapshotState: StatusSnapshotState;
  snapshotError: string | null;
  snapshotProblemText: string | null;
  statusLabel: string | null;
}

function snapshotProblemLabel(
  snapshotState: StatusSnapshotState,
): string | null {
  if (snapshotState === "wrong-id") return "wrong activity id";
  return null;
}

export function createStatusState(params: {
  source: SubagentStatusSource;
  startTimeMs: number;
}): SubagentStatusState {
  const initialKind = params.source === "claude" ? "running" : "starting";
  return {
    source: params.source,
    startTimeMs: params.startTimeMs,
    firstObservationAtMs: null,
    lastActivityAtMs: null,
    lastActivitySequence: null,
    activeNow: false,
    activeSinceMs: null,
    activeScope: null,
    waitingSinceMs: null,
    phase: null,
    latestEvent: null,
    activityLabel: null,
    heartbeatMs: null,
    snapshotState: "unseen",
    snapshotProblemSinceMs: null,
    snapshotError: null,
    currentKind: initialKind,
  };
}

// Timestamp-first, sequence-tiebreak: only strictly older data is stale.
function observationIsStale(
  updatedAt: number,
  sequence: number,
  watermarkMs: number | null,
  watermarkSeq: number | null,
): boolean {
  if (watermarkMs == null) return false;
  if (updatedAt < watermarkMs) return true;
  if (updatedAt > watermarkMs) return false;
  if (watermarkSeq == null) return false;
  return sequence < watermarkSeq;
}

type PresentStatusObservation = Extract<
  StatusObservation,
  { snapshot: "present" }
>;

type StaleStatusObservation = Exclude<
  StatusObservation,
  { snapshot: "present" }
>;

function observedStatusFields(
  observation: PresentStatusObservation,
  state: SubagentStatusState,
  updatedAt: number,
) {
  const phase = observation.phase;
  const activeNow = phase === "active" || observation.active === true;
  const activeSinceMs = activeNow
    ? (observation.activeSince ?? state.activeSinceMs ?? updatedAt)
    : null;
  const waitingSinceMs =
    phase === "waiting"
      ? (observation.waitingSince ?? state.waitingSinceMs ?? updatedAt)
      : null;
  return {
    phase,
    activeNow,
    activeSinceMs,
    activeScope: activeNow ? (observation.activeScope ?? null) : null,
    waitingSinceMs,
  };
}

function staleSnapshotState(
  state: SubagentStatusState,
  observation: StaleStatusObservation,
  now: number,
): SubagentStatusState {
  return {
    ...state,
    firstObservationAtMs: state.firstObservationAtMs ?? now,
    snapshotState: observation.snapshot,
    snapshotProblemSinceMs: state.snapshotProblemSinceMs ?? now,
    snapshotError: observation.snapshotError ?? null,
  };
}

export function observeStatus(
  state: SubagentStatusState,
  observation: StatusObservation,
  now: number,
): SubagentStatusState {
  if (state.source === "claude") return state;

  if (observation.snapshot !== "present") {
    return staleSnapshotState(state, observation, now);
  }

  const updatedAt = observation.updatedAt;
  const sequence = observation.sequence;
  // Late-arriving writes must not rewind state.
  if (
    observationIsStale(
      updatedAt,
      sequence,
      state.lastActivityAtMs,
      state.lastActivitySequence,
    )
  )
    return state;

  return {
    ...state,
    firstObservationAtMs: state.firstObservationAtMs ?? now,
    lastActivityAtMs: updatedAt,
    lastActivitySequence: sequence,
    ...observedStatusFields(observation, state, updatedAt),
    latestEvent: observation.latestEvent ?? null,
    activityLabel: observation.activityLabel ?? null,
    heartbeatMs: observation.heartbeatMs ?? null,
    snapshotState: "present",
    snapshotProblemSinceMs: null,
    snapshotError: null,
  };
}

function classifyProblemState(
  state: SubagentStatusState,
  now: number,
): Pick<StatusSnapshot, "kind" | "statusLabel"> {
  const problemLabel = snapshotProblemLabel(state.snapshotState);
  const hasValidSnapshot = state.lastActivityAtMs != null;

  if (!hasValidSnapshot) {
    const referenceMs = state.firstObservationAtMs ?? state.startTimeMs;
    const elapsedMs = Math.max(0, now - referenceMs);
    return elapsedMs >= SNAPSHOT_STALLED_AFTER_MS
      ? { kind: "stalled", statusLabel: problemLabel }
      : { kind: "starting", statusLabel: null };
  }

  const problemSinceMs = state.snapshotProblemSinceMs ?? now;
  const problemMs = Math.max(0, now - problemSinceMs);
  if (problemMs >= SNAPSHOT_STALLED_AFTER_MS)
    return { kind: "stalled", statusLabel: problemLabel };

  // Grace period: report the last healthy kind, not the problem.
  return { kind: lastHealthyKindOf(state), statusLabel: problemLabel };
}

/** The kind to report while a snapshot problem is still within its grace period. */
function lastHealthyKindOf(state: SubagentStatusState): SubagentStatusKind {
  if (state.activeNow) return "active";
  if (state.waitingSinceMs != null || state.phase === "done") return "waiting";
  return state.currentKind === "stalled" ? "starting" : state.currentKind;
}

export function classifyStatus(
  state: SubagentStatusState,
  now: number,
): StatusSnapshot {
  const elapsedMs = Math.max(0, now - state.startTimeMs);
  const elapsedText = formatElapsedDuration(elapsedMs);

  if (state.source === "claude") {
    return {
      kind: "running",
      elapsedMs,
      elapsedText,
      activeSinceMs: null,
      activeDurationText: null,
      activeScope: null,
      waitingSinceMs: null,
      waitingDurationText: null,
      latestEvent: null,
      activityLabel: null,
      snapshotState: state.snapshotState,
      snapshotError: null,
      snapshotProblemText: null,
      statusLabel: null,
    };
  }

  let kind: SubagentStatusKind;
  let statusLabel: string | null = null;

  if (state.snapshotState === "present") {
    if (state.phase === "active" || state.activeNow) {
      // A heartbeating child refreshes updatedAt while active, so this old means
      // the event loop hung. Capability-gated: older silent children are exempt.
      const frozenMs =
        state.heartbeatMs == null || state.lastActivityAtMs == null
          ? 0
          : Math.max(0, now - state.lastActivityAtMs);
      if (frozenMs >= ACTIVE_STALLED_AFTER_MS) {
        kind = "stalled";
        statusLabel = "frozen snapshot";
      } else {
        kind = "active";
      }
    } else if (state.phase === "waiting") {
      kind = "waiting";
    } else if (state.phase === "done") {
      kind = "waiting";
      statusLabel = "done";
    } else {
      const referenceMs = state.firstObservationAtMs ?? state.startTimeMs;
      const elapsedSinceObservationMs = Math.max(0, now - referenceMs);
      kind =
        elapsedSinceObservationMs >= SNAPSHOT_STALLED_AFTER_MS
          ? "stalled"
          : "starting";
      statusLabel = null;
    }
  } else {
    const classified = classifyProblemState(state, now);
    kind = classified.kind;
    statusLabel = classified.statusLabel;
  }

  const activeDurationText =
    state.activeSinceMs == null
      ? null
      : formatElapsedDuration(now - state.activeSinceMs);
  const waitingDurationText =
    state.waitingSinceMs == null
      ? null
      : formatElapsedDuration(now - state.waitingSinceMs);
  const snapshotProblemText =
    state.snapshotProblemSinceMs == null
      ? null
      : formatElapsedDuration(now - state.snapshotProblemSinceMs);

  return {
    kind,
    elapsedMs,
    elapsedText,
    activeSinceMs: state.activeSinceMs,
    activeDurationText,
    activeScope: state.activeScope,
    waitingSinceMs: state.waitingSinceMs,
    waitingDurationText,
    latestEvent: state.latestEvent,
    activityLabel: state.activityLabel,
    snapshotState: state.snapshotState,
    snapshotError: state.snapshotError,
    snapshotProblemText,
    statusLabel,
  };
}

export function advanceStatusState(
  state: SubagentStatusState,
  now: number,
): {
  nextState: SubagentStatusState;
  snapshot: StatusSnapshot;
  transition: SubagentStatusTransition;
} {
  const snapshot = classifyStatus(state, now);
  const transition =
    state.currentKind !== "stalled" && snapshot.kind === "stalled"
      ? "stalled"
      : state.currentKind === "stalled" &&
          (snapshot.kind === "active" || snapshot.kind === "waiting")
        ? "recovered"
        : null;

  return {
    snapshot,
    transition,
    nextState: {
      ...state,
      currentKind: snapshot.kind,
    },
  };
}
