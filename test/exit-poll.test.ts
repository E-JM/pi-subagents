import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { __pollForExitTest__ } from "../pi-extension/subagents/exit-poll.ts";
import { withTempDir } from "./helpers.ts";

describe("exit-poll sidecar decoding", () => {
  const { interpretExitSidecar, matchScreenSentinel, readAskSidecar } =
    __pollForExitTest__;

  it("decodes done payloads", () => {
    assert.deepEqual(interpretExitSidecar({ type: "done" }), {
      reason: "done",
      exitCode: 0,
    });
  });

  it("decodes error payloads and propagates the message with a non-zero exit code", () => {
    assert.deepEqual(
      interpretExitSidecar({
        type: "error",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
        stopReason: "error",
      }),
      {
        reason: "error",
        exitCode: 1,
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
    );
  });

  it("falls back to a placeholder when error payload has no errorMessage", () => {
    const result = interpretExitSidecar({ type: "error" });
    assert.equal(result.reason, "error");
    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage ?? "", /no errorMessage/);
  });

  it("treats unknown payload shapes as done", () => {
    assert.deepEqual(interpretExitSidecar({}), { reason: "done", exitCode: 0 });
    assert.deepEqual(interpretExitSidecar(null), {
      reason: "done",
      exitCode: 0,
    });
  });

  it("reads and consumes an .ask sidecar", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "session.jsonl");
      writeFileSync(
        `${sessionFile}.ask`,
        JSON.stringify({ name: "Worker", message: "Which API should I use?" }),
      );
      const ask = readAskSidecar(sessionFile);
      assert.deepEqual(ask, {
        name: "Worker",
        message: "Which API should I use?",
      });
      // Consumed: the file is gone and a second read returns null — the ask
      // channel is one-shot per ask_question call.
      assert.ok(!existsSync(`${sessionFile}.ask`));
      assert.equal(readAskSidecar(sessionFile), null);
    });
  });

  it("returns null when no .ask sidecar exists", () => {
    withTempDir((dir) => {
      assert.equal(readAskSidecar(join(dir, "none.jsonl")), null);
    });
  });

  it("matches the screen sentinel only as a whole line", () => {
    // The launch command's echo + the returned shell prompt.
    assert.equal(
      matchScreenSentinel("$ pi --session s.jsonl\n__SUBAGENT_DONE_0__\n$ "),
      0,
    );
    assert.equal(matchScreenSentinel("__SUBAGENT_DONE_7__"), 7);
    // Tolerate trailing whitespace padding from terminal capture.
    assert.equal(matchScreenSentinel("__SUBAGENT_DONE_1__   \r"), 1);

    // Mid-text literals (pasted, printed by a subagent's bash output) must
    // not read as completion.
    assert.equal(
      matchScreenSentinel("cat README.md\nrun __SUBAGENT_DONE_0__ to finish"),
      null,
    );
    assert.equal(matchScreenSentinel("no sentinel here"), null);
  });

  it("isolates a corrupt .ask sidecar and surfaces a synthetic ask", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "s.jsonl");
      writeFileSync(`${sessionFile}.ask`, '{"name": "Worker", "mess'); // killed mid-write

      const ask = readAskSidecar(sessionFile);
      assert.ok(ask);
      assert.match(ask.message, /unreadable \.ask sidecar/);
      // One-shot: the poison pill is gone, the channel is usable again.
      assert.ok(!existsSync(`${sessionFile}.ask`));
    });
  });
});
