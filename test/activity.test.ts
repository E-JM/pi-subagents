import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readSubagentActivityFile } from "../pi-extension/subagents/activity/read.ts";
import { createSubagentActivityRecorder } from "../pi-extension/subagents/activity/recorder.ts";
import { getSubagentActivityFile } from "../pi-extension/subagents/activity/schema.ts";
import { createTestDir, withTempDir } from "./helpers.ts";

describe("subagent activity snapshots", () => {
  function validActivity(overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      runningChildId: "child-1",
      createdAt: 1_000,
      updatedAt: 1_000,
      sequence: 1,
      latestEvent: "session_start",
      phase: "starting",
      agentActive: false,
      turnActive: false,
      providerActive: false,
      toolActive: false,
      ...overrides,
    };
  }

  it("writes and validates activity files by running child id", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-1");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-1",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.toolExecutionStart("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-1");
      assert.ok(read.ok);
      assert.equal(read.value.phase, "active");
      assert.equal(read.value.activeScope, "tool");
      assert.equal(read.value.toolName, "bash");

      assert.deepEqual(readSubagentActivityFile(activityFile, "other-child"), {
        ok: false,
        error: { kind: "wrong-id" },
      });
    });
  });

  it("records waiting and final done states", () => {
    withTempDir((dir) => {
      let currentNow = 2_000;
      const activityFile = getSubagentActivityFile(dir, "child-2");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-2",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      currentNow = 3_000;
      recorder.agentEndWaiting();
      let read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.value.phase, "waiting");
      assert.equal(read.value.waitingSince, 3_000);

      currentNow = 4_000;
      recorder.agentEndDone();
      read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.value.phase, "done");
      assert.equal(read.value.agentActive, false);
    });
  });

  it("records ask_question as a mid-turn event without flipping the phase", () => {
    withTempDir((dir) => {
      let currentNow = 2_000;
      const activityFile = getSubagentActivityFile(dir, "child-ask");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-ask",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      currentNow = 2_500;
      recorder.agentStart();
      currentNow = 3_000;
      recorder.askQuestion();

      const read = readSubagentActivityFile(activityFile, "child-ask");
      assert.ok(read.ok);
      assert.equal(read.value.latestEvent, "ask_question");
      // The turn is still running; agent_end flips the phase to waiting.
      assert.equal(read.value.phase, "active");
    });
  });

  it("rejects malformed activity fields used by classification and rendering", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "subagent-activity"), { recursive: true });
      const cases = [
        { activeSince: "bad" },
        { waitingSince: "bad" },
        { activeScope: "database" },
        { latestEvent: "unknown" },
        { runningChildId: 42 },
        { toolActive: "yes" },
        { toolName: "bad\nname" },
      ];

      for (const [index, overrides] of cases.entries()) {
        const activityFile = getSubagentActivityFile(dir, `child-${index}`);
        const activity = validActivity({
          runningChildId: `child-${index}`,
          ...overrides,
        });
        writeFileSync(activityFile, `${JSON.stringify(activity)}\n`);

        const read = readSubagentActivityFile(activityFile, `child-${index}`);
        assert.equal(read.ok, false);
        assert.equal(read.error.kind, "invalid");
      }
    });
  });

  it("does not let tool_result resurrect finished tool activity", () => {
    withTempDir((dir) => {
      let currentNow = 1_000;
      const activityFile = getSubagentActivityFile(dir, "child-3");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-3",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      recorder.agentStart();
      recorder.turnStart(1);
      currentNow = 2_000;
      recorder.toolExecutionStart("tool-1", "bash");
      currentNow = 3_000;
      recorder.toolExecutionEnd("tool-1", "bash");
      currentNow = 4_000;
      recorder.toolResult("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-3");
      assert.ok(read.ok);
      assert.equal(read.value.toolActive, false);
      assert.equal(read.value.activeScope, "turn");
    });
  });

  it("does not mark reload shutdown as the final done snapshot", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-4");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-4",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.sessionShutdown("reload");

      const read = readSubagentActivityFile(activityFile, "child-4");
      assert.ok(read.ok);
      assert.equal(read.value.phase, "starting");
      assert.equal(read.value.latestEvent, "session_start");
    });
  });

  it("heartbeats while active and stops once the run waits or finishes", async () => {
    const dir = createTestDir();
    try {
      const activityFile = getSubagentActivityFile(dir, "child-hb");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-hb",
        activityFile,
        now: () => 1_000,
        heartbeatMs: 20,
      });

      recorder.sessionStart();
      recorder.agentStart();
      const atStart = readSubagentActivityFile(activityFile, "child-hb");
      assert.ok(atStart.ok);
      assert.equal(atStart.value.latestEvent, "agent_start");
      const sequenceAtStart = atStart.value.sequence;

      // A long silent stretch while active: the heartbeat keeps bumping the
      // sequence (with latestEvent unchanged) so the parent can tell a busy
      // child from a hung one.
      await new Promise((resolve) => setTimeout(resolve, 80));
      const heartbeating = readSubagentActivityFile(activityFile, "child-hb");
      assert.ok(heartbeating.ok);
      assert.ok(
        heartbeating.value.sequence > sequenceAtStart,
        "heartbeat must advance the sequence while active",
      );
      assert.equal(heartbeating.value.latestEvent, "agent_start");
      assert.equal(heartbeating.value.phase, "active");
      const sequenceWhileActive = heartbeating.value.sequence;

      recorder.agentEndWaiting();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const waiting = readSubagentActivityFile(activityFile, "child-hb");
      assert.ok(waiting.ok);
      assert.equal(waiting.value.phase, "waiting");
      assert.equal(
        waiting.value.sequence,
        sequenceWhileActive + 1,
        "no heartbeat writes once the phase leaves active",
      );

      recorder.agentEndDone();
      const done = readSubagentActivityFile(activityFile, "child-hb");
      assert.ok(done.ok);
      assert.equal(done.value.phase, "done");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cancels pending throttled writes on reload shutdown", async () => {
    const dir = createTestDir();
    try {
      await new Promise<void>((resolve) => {
        let currentNow = 1_000;
        const activityFile = getSubagentActivityFile(dir, "child-5");
        const recorder = createSubagentActivityRecorder({
          runningChildId: "child-5",
          activityFile,
          now: () => currentNow,
        });

        recorder.sessionStart();
        currentNow = 1_100;
        recorder.messageUpdate("delta");
        recorder.sessionShutdown("reload");

        setTimeout(() => {
          const read = readSubagentActivityFile(activityFile, "child-5");
          assert.ok(read.ok);
          assert.equal(read.value.phase, "starting");
          assert.equal(read.value.latestEvent, "session_start");
          resolve();
        }, 650);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
