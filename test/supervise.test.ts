import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveModelWithFallback } from "../pi-extension/subagents/launch/policies.ts";
import { closeRunningSubagent } from "../pi-extension/subagents/lifecycle.ts";
import {
  sanitizeArtifactMessage,
  sanitizeInjectedMessage,
} from "../pi-extension/subagents/sanitize.ts";
import { registry } from "../pi-extension/subagents/state.ts";
import { createStatusState } from "../pi-extension/subagents/status/snapshot.ts";
import { withTempDir } from "./helpers.ts";

describe("model credential fallback", () => {
  const authed = new Set(["zai-coding-cn/glm-5.3"]);
  const hasAuth = (provider: string, id: string) =>
    authed.has(`${provider}/${id}`);

  it("keeps the requested model when its provider has credentials", () => {
    assert.deepEqual(
      resolveModelWithFallback({
        requestedModel: "zai-coding-cn/glm-5.3:high",
        hasAuth,
        parentModel: "zai-coding-cn/glm-5.3",
      }),
      { model: "zai-coding-cn/glm-5.3:high", applyThinking: true },
    );
  });

  it("falls back to the parent model when the agent provider has no auth", () => {
    const decision = resolveModelWithFallback({
      requestedModel: "anthropic/claude-sonnet-4-6:minimal",
      hasAuth,
      parentModel: "zai-coding-cn/glm-5.3",
    });
    assert.equal(decision.model, "zai-coding-cn/glm-5.3");
    assert.equal(decision.applyThinking, false);
    assert.match(decision.warning ?? "", /falling back/);
    assert.match(
      decision.warning ?? "",
      /anthropic\/claude-sonnet-4-6:minimal/,
    );
  });

  it("keeps the requested model with a warning when no parent model exists", () => {
    const decision = resolveModelWithFallback({
      requestedModel: "anthropic/claude-haiku-4-5",
      hasAuth,
      parentModel: undefined,
    });
    assert.equal(decision.model, "anthropic/claude-haiku-4-5");
    assert.equal(decision.applyThinking, true);
    assert.match(decision.warning ?? "", /no parent model/);
  });

  it("passes through unset and bare model ids without probing", () => {
    assert.deepEqual(
      resolveModelWithFallback({ hasAuth, parentModel: "p/m" }),
      {
        applyThinking: true,
      },
    );
    assert.deepEqual(
      resolveModelWithFallback({ requestedModel: "glm-5.3", hasAuth }),
      { model: "glm-5.3", applyThinking: true },
    );
  });
});

describe("closeRunningSubagent", () => {
  it("writes the .exit sidecar with the close reason", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "worker.jsonl");
      writeFileSync(sessionFile, "");
      registry.clear();

      try {
        const running = {
          id: "a1",
          name: "Worker",
          task: "",
          surface: "pane-1",
          startTime: 0,
          sessionFile,
          interactive: false,
          statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
        };
        registry.register(running);

        closeRunningSubagent(running, "closed-by-parent");

        const sidecar = JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8"));
        assert.deepEqual(sidecar, { type: "done", reason: "closed-by-parent" });
      } finally {
        registry.clear();
      }
    });
  });

  it("still works when the pane surface is already gone", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "worker.jsonl");
      writeFileSync(sessionFile, "");
      const running = {
        id: "a1",
        name: "Worker",
        task: "",
        // Nonexistent surface: closeSurface is idempotent and must not throw.
        surface: "/nonexistent/surface",
        startTime: 0,
        sessionFile,
        interactive: false,
        statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
      };

      closeRunningSubagent(running, "idle-close");

      const sidecar = JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8"));
      assert.deepEqual(sidecar, { type: "done", reason: "idle-close" });
    });
  });
});

describe("sanitizeInjectedMessage", () => {
  it("collapses newline-containing whitespace runs into single spaces", () => {
    assert.equal(sanitizeInjectedMessage("a\nb"), "a b");
    assert.equal(sanitizeInjectedMessage("a\n\n  b"), "a b");
    assert.equal(sanitizeInjectedMessage("a \n\t b"), "a b");
    assert.equal(sanitizeInjectedMessage("  trimmed  "), "trimmed");
    // Whitespace without newlines is preserved.
    assert.equal(sanitizeInjectedMessage("a  b"), "a  b");
  });

  it("hard-caps at 4000 chars with a truncation marker", () => {
    const long = "x".repeat(4_100);
    const sanitized = sanitizeInjectedMessage(long);
    assert.equal(sanitized.length, 4_000 + "…[truncated]".length);
    assert.ok(sanitized.endsWith("…[truncated]"));
    assert.equal(sanitizeInjectedMessage("y".repeat(4_000)), "y".repeat(4_000));
  });

  it("breaks screen-sentinel literals in both delivery channels", () => {
    // A pasted/injected `__SUBAGENT_DONE_0__` must never be able to fake
    // the pane's completion in the exit poller.
    assert.equal(
      sanitizeInjectedMessage("run __SUBAGENT_DONE_0__ to finish"),
      "run __SUBAGENT-DONE_0__ to finish",
    );
    // The artifact channel keeps newlines but still neutralizes.
    assert.equal(
      sanitizeArtifactMessage("line\n__SUBAGENT_DONE_1__\nline"),
      "line\n__SUBAGENT-DONE_1__\nline",
    );
    assert.equal(sanitizeArtifactMessage("  keep me  "), "keep me");
    const longArtifact = "z".repeat(20_100);
    assert.ok(sanitizeArtifactMessage(longArtifact).endsWith("…[truncated]"));
  });
});
