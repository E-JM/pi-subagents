import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  loadAgentDefaults,
  parseAgentDefinition,
  resolveInteractive,
} from "../pi-extension/subagents/agents.ts";
import {
  buildPiPromptArgs,
  buildSubagentToolAllowlist,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveTaskDelivery,
} from "../pi-extension/subagents/launch/policies.ts";
import { buildResumeEscapedArgs } from "../pi-extension/subagents/resume.ts";
import { formatAvailableAgents } from "../pi-extension/subagents/targeting.ts";
import {
  createTestDir,
  withIsolatedAgentEnv,
  writeAgentFile,
} from "./helpers.ts";

describe("subagent discovery", () => {
  it("loads session-mode from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "lineage-mode-test-agent",
        [
          "name: lineage-mode-test-agent",
          "model: anthropic/test-lineage",
          "session-mode: lineage-only",
        ].join("\n"),
      );

      const loaded = loadAgentDefaults("lineage-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, "lineage-only");
    });
  });

  it("loads explicit interactive flag from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-true-test-agent",
        [
          "name: interactive-true-test-agent",
          "model: anthropic/test-interactive-true",
          "interactive: true",
        ].join("\n"),
      );
      writeAgentFile(
        projectAgentsDir,
        "interactive-false-test-agent",
        [
          "name: interactive-false-test-agent",
          "model: anthropic/test-interactive-false",
          "interactive: false",
        ].join("\n"),
      );

      const loadedTrue = loadAgentDefaults("interactive-true-test-agent");
      assert.equal(loadedTrue?.interactive, true);

      const loadedFalse = loadAgentDefaults("interactive-false-test-agent");
      assert.equal(loadedFalse?.interactive, false);
    });
  });

  it("leaves interactive undefined when not set in frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-unset-test-agent",
        [
          "name: interactive-unset-test-agent",
          "model: anthropic/test-interactive-unset",
        ].join("\n"),
      );

      const loaded = loadAgentDefaults("interactive-unset-test-agent");
      assert.equal(loaded?.interactive, undefined);
    });
  });

  it("resolveInteractive rejects interactive: true on autonomous agents (spawning: false)", () => {
    // The planner shape: user-driven, spawning enabled — allowed.
    assert.equal(
      resolveInteractive({
        agentName: "planner",
        agentDefs: { interactive: true },
      }),
      true,
    );
    // No frontmatter at all — autonomous default.
    assert.equal(
      resolveInteractive({ agentName: "w", agentDefs: null }),
      false,
    );
    assert.equal(
      resolveInteractive({
        agentName: "w",
        agentDefs: { spawning: false },
      }),
      false,
    );
    // The dead-lock shape: autonomous agent declaring interactive — a
    // configuration error, rejected at spawn time instead of wedging.
    assert.throws(
      () =>
        resolveInteractive({
          agentName: "worker",
          agentDefs: { spawning: false, interactive: true },
        }),
      /declares interactive: true but sets spawning: false/,
    );
  });

  it("bundled scout/worker/reviewer agents resolve as autonomous; planner as interactive", () => {
    for (const name of ["scout", "worker", "reviewer"]) {
      const defs = loadAgentDefaults(name);
      assert.ok(defs, `expected bundled agent ${name} to be discoverable`);
      assert.equal(
        defs.interactive,
        undefined,
        `${name} should not declare interactive (autonomous by default)`,
      );
    }

    const planner = loadAgentDefaults("planner");
    assert.ok(planner, "expected bundled planner to be discoverable");
    assert.equal(
      planner.interactive,
      true,
      "planner should declare interactive: true (user drives the pane)",
    );
  });

  it("ignores invalid session-mode values", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "invalid-mode-test-agent",
        [
          "name: invalid-mode-test-agent",
          "model: anthropic/test-invalid",
          "session-mode: sideways",
        ].join("\n"),
      );

      const loaded = loadAgentDefaults("invalid-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, undefined);
    });
  });

  it("resolves session mode with fork override precedence", () => {
    assert.equal(resolveEffectiveSessionMode({}, null), "standalone");
    assert.equal(
      resolveEffectiveSessionMode({}, { sessionMode: "lineage-only" }),
      "lineage-only",
    );
    assert.equal(
      resolveEffectiveSessionMode(
        { fork: true },
        { sessionMode: "lineage-only" },
      ),
      "fork",
    );
  });

  it("resolves launch behavior for standalone, lineage-only, and fork modes", () => {
    assert.deepEqual(resolveLaunchBehavior({}, null), {
      sessionMode: "standalone",
      seededSessionMode: null,
      inheritsConversationContext: false,
    });
    assert.deepEqual(
      resolveLaunchBehavior({}, { sessionMode: "lineage-only" }),
      {
        sessionMode: "lineage-only",
        seededSessionMode: "lineage-only",
        inheritsConversationContext: false,
      },
    );
    assert.deepEqual(resolveLaunchBehavior({}, { sessionMode: "fork" }), {
      sessionMode: "fork",
      seededSessionMode: "fork",
      inheritsConversationContext: true,
    });
    assert.deepEqual(
      resolveLaunchBehavior({ fork: true }, { sessionMode: "lineage-only" }),
      {
        sessionMode: "fork",
        seededSessionMode: "fork",
        inheritsConversationContext: true,
      },
    );
  });

  it("resolveTaskDelivery defaults to direct and falls back to artifact for argv-unsafe tasks", () => {
    assert.equal(resolveTaskDelivery("do the thing"), "direct");
    assert.equal(
      resolveTaskDelivery("line one\nline two with 'quotes' and $var"),
      "direct",
    );
    assert.equal(resolveTaskDelivery("-flag-looking task"), "artifact");
    assert.equal(resolveTaskDelivery("--also-flag-looking"), "artifact");
    assert.equal(resolveTaskDelivery("x".repeat(32_001)), "artifact");
    assert.equal(resolveTaskDelivery("x".repeat(32_000)), "direct");
  });

  it("buildSubagentToolAllowlist preserves requested tools and adds ask_question", () => {
    assert.equal(
      buildSubagentToolAllowlist("read,bash,web_search"),
      "read,bash,web_search,ask_question",
    );
  });

  it("buildSubagentToolAllowlist returns null without an explicit tool restriction", () => {
    assert.equal(buildSubagentToolAllowlist(undefined), null);
    assert.equal(buildSubagentToolAllowlist(""), null);
  });

  it("buildPiPromptArgs inserts separator for artifact-backed launches with skills", () => {
    assert.deepEqual(
      buildPiPromptArgs({
        effectiveSkills: "review,lint",
        taskDelivery: "artifact",
        taskArg: "@artifact.md",
      }),
      ["", "/skill:review", "/skill:lint", "@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for artifact-backed launches without skills", () => {
    assert.deepEqual(
      buildPiPromptArgs({
        effectiveSkills: undefined,
        taskDelivery: "artifact",
        taskArg: "@artifact.md",
      }),
      ["@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for direct launches with skills", () => {
    assert.deepEqual(
      buildPiPromptArgs({
        effectiveSkills: "review",
        taskDelivery: "direct",
        taskArg: "do the task",
      }),
      ["/skill:review", "do the task"],
    );
  });

  it("buildPiPromptArgs passes the task through unchanged for direct launches without skills", () => {
    assert.deepEqual(
      buildPiPromptArgs({
        effectiveSkills: undefined,
        taskDelivery: "direct",
        taskArg: "do the task",
      }),
      ["do the task"],
    );
  });

  it("spawn delivery contract: bare task rides argv, wrapper never touches the message", () => {
    // Mimics launchSubagent's pi-backed flow with the same pure pieces.
    const task = "echo 'PASS' > marker.txt";
    const taskDelivery = resolveTaskDelivery(task);
    assert.equal(taskDelivery, "direct");
    const promptArgs = buildPiPromptArgs({
      effectiveSkills: undefined,
      taskDelivery,
      taskArg: task,
    });
    // The bare task is the one positional arg pi receives — plain text,
    // no @file reference, never flag-shaped, no lifecycle wrapper (the
    // wrapper travels in the system prompt now).
    assert.deepEqual(promptArgs, [task]);
    assert.ok(!promptArgs[0]!.startsWith("-"));
    assert.ok(!promptArgs[0]!.includes("Ending your turn"));
  });

  it("spawn delivery contract: argv-unsafe task falls back to the @artifact channel", () => {
    const taskDelivery = resolveTaskDelivery("-n unusual task");
    assert.equal(taskDelivery, "artifact");
    const promptArgs = buildPiPromptArgs({
      effectiveSkills: undefined,
      taskDelivery,
      taskArg: "@/artifacts/context/child-2026.md",
    });
    assert.deepEqual(promptArgs, ["@/artifacts/context/child-2026.md"]);
  });

  it("resume delivery contract: direct message rides argv, artifact fallback writes the file", async () => {
    const dir = createTestDir();

    // Normal message: plain positional arg plus the contract wrapper flag;
    // no message artifact file.
    const direct = buildResumeEscapedArgs({
      message: "[parent] also check the retry path",
      artifactDir: dir,
      name: "Worker",
      interactive: false,
    });
    assert.equal(direct.messageArtifactFile, null);
    assert.equal(direct.escapedArgs.length, 3);
    assert.equal(direct.escapedArgs[0], "--append-system-prompt");
    assert.equal(direct.escapedArgs[1], `'${direct.wrapperFile}'`);
    assert.ok(direct.escapedArgs[2]!.includes("also check the retry path"));
    const wrapperText = readFileSync(direct.wrapperFile, "utf8");
    assert.ok(wrapperText.includes("Ending your turn finishes this task"));

    // Dash-leading message: artifact fallback, file written, @path in argv.
    const fallback = buildResumeEscapedArgs({
      message: "- fix the flaky test first",
      artifactDir: dir,
      name: "Worker",
      interactive: false,
    });
    assert.ok(fallback.messageArtifactFile);
    assert.deepEqual(fallback.escapedArgs, [
      "--append-system-prompt",
      `'${fallback.wrapperFile}'`,
      `'@${fallback.messageArtifactFile}'`,
    ]);
    const written = readFileSync(fallback.messageArtifactFile!, "utf8");
    assert.equal(written, "- fix the flaky test first");
  });

  it("formatAvailableAgents lists visible agents from discovery", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "visible-discovery-test-agent",
        [
          "name: visible-discovery-test-agent",
          "description: Visible test agent",
          "model: anthropic/test-visible",
        ].join("\n"),
      );

      const catalog = formatAvailableAgents();
      assert.match(catalog, /visible-discovery-test-agent/);
      assert.match(catalog, /\(project\)/);
    });
  });

  it("formatAvailableAgents hides disable-model-invocation agents but keeps direct loading", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "hidden-discovery-test-agent",
        [
          "name: hidden-discovery-test-agent",
          "description: Hidden test agent",
          "model: anthropic/test-hidden",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the hidden agent.",
      );

      const catalog = formatAvailableAgents();
      assert.doesNotMatch(catalog, /hidden-discovery-test-agent/);

      const loaded = loadAgentDefaults("hidden-discovery-test-agent");
      assert.ok(loaded, "expected hidden agent to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-hidden");
      assert.equal(loaded.body, "You are the hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });

  it("lets a hidden project agent shadow a visible global agent", async () => {
    await withIsolatedAgentEnv(
      async ({ projectAgentsDir, globalAgentsDir }) => {
        writeAgentFile(
          globalAgentsDir,
          "shadowed-discovery-test-agent",
          [
            "name: shadowed-discovery-test-agent",
            "description: Global visible agent",
            "model: anthropic/test-global",
          ].join("\n"),
          "You are the global visible agent.",
        );
        writeAgentFile(
          projectAgentsDir,
          "shadowed-discovery-test-agent",
          [
            "name: shadowed-discovery-test-agent",
            "description: Project hidden agent",
            "model: anthropic/test-project",
            "disable-model-invocation: true",
          ].join("\n"),
          "You are the project hidden agent.",
        );

        const catalog = formatAvailableAgents();
        assert.doesNotMatch(catalog, /shadowed-discovery-test-agent/);

        const loaded = loadAgentDefaults("shadowed-discovery-test-agent");
        assert.ok(
          loaded,
          "expected project override to remain directly loadable",
        );
        assert.equal(loaded.model, "anthropic/test-project");
        assert.equal(loaded.body, "You are the project hidden agent.");
        assert.equal(loaded.disableModelInvocation, true);
      },
    );
  });
});

describe("parseAgentDefinition (system-prompt-mode)", () => {
  // Regression guard for the systemPromptMode feature: these exercise the
  // REAL frontmatter parser (the old test/system-prompt-mode.test.ts tested
  // a drifted local copy and was never wired into a test runner).
  const parse = (content: string) =>
    parseAgentDefinition(content, "fallback-name");

  it("parses system-prompt: replace and extracts the body", () => {
    const parsed = parse(
      [
        "---",
        "model: anthropic/claude-sonnet-4-20250514",
        "system-prompt: replace",
        "interactive: true",
        "---",
        "",
        "You are a specialized agent.",
      ].join("\n"),
    );
    assert.equal(parsed?.systemPromptMode, "replace");
    assert.equal(parsed?.body, "You are a specialized agent.");
    assert.equal(parsed?.interactive, true);
  });

  it("parses system-prompt: append", () => {
    const parsed = parse(
      "---\nsystem-prompt: append\n---\n\nYou are an appended identity.",
    );
    assert.equal(parsed?.systemPromptMode, "append");
    assert.equal(parsed?.body, "You are an appended identity.");
  });

  it("leaves systemPromptMode undefined when the field is absent", () => {
    const parsed = parse("---\nmodel: anthropic/x\n---\n\nDefault body.");
    assert.equal(parsed?.systemPromptMode, undefined);
    assert.equal(parsed?.body, "Default body.");
  });

  it("ignores an invalid system-prompt value", () => {
    const parsed = parse("---\nsystem-prompt: foobar\n---\n\nBody here.");
    assert.equal(parsed?.systemPromptMode, undefined);
  });

  it("falls back to the provided name when frontmatter has none", () => {
    const parsed = parse("---\nmodel: anthropic/x\n---\n\nBody.");
    assert.equal(parsed?.name, "fallback-name");
  });

  it("returns null for content without frontmatter", () => {
    assert.equal(parse("just a body, no frontmatter"), null);
  });

  it("omits body when the file is frontmatter-only", () => {
    const parsed = parse("---\nmodel: anthropic/x\n---");
    assert.equal(parsed?.body, undefined);
  });
});
