import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  loadStatusConfig,
  parseStatusConfig,
} from "../pi-extension/subagents/status/config.ts";
import {
  capStatusLines,
  formatStatusAggregate,
  formatStatusLine,
  formatTransitionLine,
} from "../pi-extension/subagents/status/format.ts";
import {
  advanceStatusState,
  classifyStatus,
  createStatusState,
  observeStatus,
} from "../pi-extension/subagents/status/snapshot.ts";
import { withTempDir } from "./helpers.ts";

describe("status.ts", () => {
  it("parses strict config objects", () => {
    const disabled = parseStatusConfig({ status: { enabled: false } });

    assert.deepEqual(disabled, {
      enabled: false,
      lineLimit: 4,
    });
  });

  it("rejects a stale supervision section as an unsupported root key", () => {
    assert.throws(
      () => parseStatusConfig({ status: { enabled: true }, supervision: {} }),
      /root has unsupported key\(s\): supervision$/,
    );
  });

  it("loads a valid config file", () => {
    const examplePath = fileURLToPath(
      new URL("../config.json.example", import.meta.url),
    );
    const config = loadStatusConfig(examplePath);

    assert.deepEqual(config, {
      enabled: true,
      lineLimit: 4,
    });
  });

  it("loads the shared example when local config is absent", () => {
    withTempDir((dir) => {
      const examplePath = join(dir, "config.json.example");
      writeFileSync(
        examplePath,
        `${JSON.stringify({ status: { enabled: true } }, null, 2)}\n`,
      );

      const config = loadStatusConfig(join(dir, "config.json"), examplePath);

      assert.deepEqual(config, {
        enabled: true,
        lineLimit: 4,
      });
    });
  });

  it("fails fast for invalid config shapes", () => {
    assert.throws(
      () => parseStatusConfig({ status: { enabled: "false" } }),
      /status\.enabled must be a boolean/,
    );
    assert.throws(
      () =>
        parseStatusConfig({
          status: { enabled: true, defaultCadenceSeconds: 60 },
        }),
      /status has unsupported key\(s\): defaultCadenceSeconds/,
    );
  });

  it("rejects unknown root keys", () => {
    assert.throws(
      () => parseStatusConfig({ completion: {}, status: { enabled: true } }),
      /root has unsupported key\(s\): completion$/,
    );
    assert.throws(
      () => parseStatusConfig({ sttus: { enabled: true } }),
      /root has unsupported key\(s\): sttus$/,
    );
  });

  it("reports when neither local nor shared config exists", () => {
    withTempDir((dir) => {
      assert.throws(
        () =>
          loadStatusConfig(
            join(dir, "config.json"),
            join(dir, "config.json.example"),
          ),
        /Missing subagent status config\. Expected .*config\.json.*or.*config\.json\.example/,
      );
    });
  });

  it("reports invalid JSON from the shared example path", () => {
    withTempDir((dir) => {
      const examplePath = join(dir, "config.json.example");
      writeFileSync(examplePath, "{\n");

      assert.throws(
        () => loadStatusConfig(join(dir, "config.json"), examplePath),
        /Invalid JSON in subagent config .*config\.json\.example/,
      );
    });
  });

  it("fails on invalid local config instead of falling back to the shared example", () => {
    withTempDir((dir) => {
      const configPath = join(dir, "config.json");
      const examplePath = join(dir, "config.json.example");
      writeFileSync(configPath, "{\n");
      writeFileSync(
        examplePath,
        `${JSON.stringify({ status: { enabled: true } }, null, 2)}\n`,
      );

      assert.throws(
        () => loadStatusConfig(configPath, examplePath),
        /Invalid JSON in subagent config .*config\.json/,
      );
    });
  });

  it("keeps a missing snapshot as starting until the fixed watchdog threshold", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, { snapshot: "missing" }, 1_000);

    assert.equal(classifyStatus(state, 60_999).kind, "starting");
    const stalled = classifyStatus(state, 61_000);
    assert.equal(stalled.kind, "stalled");
    assert.equal(stalled.statusLabel, null);
  });

  it("classifies freshly-updated active snapshots as active", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 239_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
        latestEvent: "tool_execution_start",
      },
      239_000,
    );

    const snapshot = classifyStatus(state, 240_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.activityLabel, "bash");
    assert.equal(snapshot.activeDurationText, "3m");
  });

  it("ages a frozen active snapshot into stalled (dead heartbeat)", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
        latestEvent: "tool_execution_start",
        heartbeatMs: 30_000,
      },
      5_000,
    );

    // One tick before the threshold the run is still active…
    assert.equal(classifyStatus(state, 94_999).kind, "active");
    // …but a snapshot whose updatedAt stopped advancing means the child's
    // event loop stopped heartbeating while claiming to work.
    const stalled = classifyStatus(state, 95_000);
    assert.equal(stalled.kind, "stalled");
    assert.equal(stalled.statusLabel, "frozen snapshot");
  });

  it("never flags a frozen active snapshot from a child without heartbeat capability", () => {
    // Older children (spawned before the heartbeat existed) may be quietly
    // busy — no false "stalled" for them.
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
        latestEvent: "tool_execution_start",
      },
      5_000,
    );

    assert.equal(classifyStatus(state, 240_000).kind, "active");
  });

  it("classifies waiting snapshots as healthy idle without becoming stalled", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 10_000,
        sequence: 1,
        phase: "waiting",
        waitingSince: 10_000,
        latestEvent: "agent_end",
      },
      10_000,
    );

    const snapshot = classifyStatus(state, 240_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.waitingDurationText, "3m");
  });

  it("uses elapsed-only fallback for claude-backed subagents", () => {
    const state = createStatusState({ source: "claude", startTimeMs: 0 });
    const snapshot = classifyStatus(state, 125_000);

    assert.equal(snapshot.kind, "running");
    assert.equal(snapshot.elapsedText, "2m");
  });

  it("detects stalled transitions and recovery", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, { snapshot: "missing" }, 1_000);

    let advanced = advanceStatusState(state, 95_000);
    assert.equal(advanced.transition, "stalled");
    assert.equal(advanced.snapshot.kind, "stalled");

    state = observeStatus(
      advanced.nextState,
      {
        snapshot: "present",
        updatedAt: 96_000,
        sequence: 1,
        phase: "waiting",
        waitingSince: 96_000,
        latestEvent: "agent_end",
      },
      96_000,
    );
    advanced = advanceStatusState(state, 97_000);
    assert.equal(advanced.transition, "recovered");
    assert.equal(advanced.snapshot.kind, "waiting");
  });

  it("keeps the last healthy kind during transient snapshot loss", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "streaming",
        activeSince: 5_000,
      },
      5_000,
    );
    state = advanceStatusState(state, 6_000).nextState;
    state = observeStatus(state, { snapshot: "missing" }, 10_000);

    const snapshot = classifyStatus(state, 20_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.statusLabel, null);
  });

  it("orders same-millisecond snapshots by sequence", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 10_000,
        sequence: 2,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 10_000,
        activityLabel: "bash",
      },
      10_000,
    );

    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 10_000,
        sequence: 3,
        phase: "waiting",
        waitingSince: 10_000,
        latestEvent: "agent_end",
      },
      10_001,
    );

    const snapshot = classifyStatus(state, 11_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.latestEvent, "agent_end");
  });

  it("recovers from a transient snapshot read failure with the same valid snapshot", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 2,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );
    state = observeStatus(state, { snapshot: "missing" }, 10_000);
    assert.equal(classifyStatus(state, 10_000).statusLabel, null);

    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 2,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      11_000,
    );

    const snapshot = classifyStatus(state, 11_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.statusLabel, null);
  });

  it("normalizes and truncates long newline-heavy names", () => {
    const longName = `Worker\n\n${"very-long-name-".repeat(12)}`;
    const stalledState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      { snapshot: "missing" },
      1_000,
    );
    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 299_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 299_000,
        activityLabel: "write",
      },
      299_000,
    );
    const line = formatStatusLine(
      longName,
      classifyStatus(stalledState, 240_000),
    );
    const recovered = formatTransitionLine(
      longName,
      classifyStatus(activeState, 300_000),
      "recovered",
    );

    assert.doesNotMatch(line, /\n/);
    assert.doesNotMatch(recovered, /\n/);
    assert.ok(
      line.length <= 120,
      `expected bounded line length, got ${line.length}`,
    );
    assert.ok(
      recovered.length <= 120,
      `expected bounded line length, got ${recovered.length}`,
    );
  });

  it("caps visible status lines and reports overflow consistently", () => {
    const waitingState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 180_000,
        sequence: 1,
        phase: "waiting",
        waitingSince: 180_000,
      },
      180_000,
    );
    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 419_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 419_000,
        activityLabel: "bash",
      },
      419_000,
    );
    const waitingLine = formatStatusLine(
      "Worker",
      classifyStatus(waitingState, 300_000),
    );
    const recoveredLine = formatTransitionLine(
      "Worker",
      classifyStatus(activeState, 420_000),
      "recovered",
    );
    const lines = [
      waitingLine,
      recoveredLine,
      "Scout running 2m.",
      "Reviewer running 4m.",
      "Planner running 6m.",
    ];
    const capped = capStatusLines(lines, 3);
    const aggregate = formatStatusAggregate(lines, 3);

    assert.equal(waitingLine, "Worker running 5m, waiting 2m.");
    assert.equal(
      recoveredLine,
      "Worker running 7m, recovered; active (bash 1s).",
    );
    assert.deepEqual(capped.visibleLines, [
      waitingLine,
      recoveredLine,
      "Scout running 2m.",
    ]);
    assert.equal(capped.overflow, 2);
    assert.match(aggregate, /^Subagent status:/);
    assert.match(aggregate, /\+2 more running\./);
    assert.doesNotMatch(aggregate, /\/tmp|\.jsonl/);
  });
});
