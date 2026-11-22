import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initTheme } from "@mariozechner/pi-coding-agent";
import { resolveDenyTools } from "../pi-extension/subagents/agents.ts";
import subagentsExtension from "../pi-extension/subagents/index.ts";
import { resolveResumeLaunchBehavior } from "../pi-extension/subagents/launch/policies.ts";
import { registry } from "../pi-extension/subagents/state.ts";
import { createStatusState } from "../pi-extension/subagents/status/snapshot.ts";
import {
  matchLiveTarget,
  resolveRunningTarget,
} from "../pi-extension/subagents/targeting.ts";
import { createMockExtensionApi, restoreEnvVar } from "./helpers.ts";

describe("commands", () => {
  it("/iterate always emits a full-context fork tool call", () => {
    const { api, registeredCommands, sentUserMessages } =
      createMockExtensionApi();

    subagentsExtension(api);

    const iterate = registeredCommands.find(
      (command) => command.name === "iterate",
    );
    assert.ok(iterate, "expected /iterate to be registered");

    iterate.handler("Fix the bug", {});

    assert.equal(sentUserMessages.length, 1);
    assert.match(sentUserMessages[0]!, /fork: true/);
    assert.match(sentUserMessages[0]!, /name: "Iterate"/);
  });
});

describe("tool registration", () => {
  it("resumes are always autonomous — turn end exits and steers the result", () => {
    assert.deepEqual(resolveResumeLaunchBehavior(), {
      interactive: false,
    });
  });

  it("expands spawning false to deny subagent lifecycle tools", () => {
    const denied = resolveDenyTools({ spawning: false });

    assert.equal(denied.has("subagent_spawn"), true);
    assert.equal(denied.has("subagent_message"), true);
    assert.equal(denied.has("subagent_close"), true);
    assert.equal(denied.size, 3);
  });

  it("registers exactly the three subagent tools in the main session", () => {
    const { api, registeredTools } = createMockExtensionApi();
    subagentsExtension(api);

    assert.deepEqual(registeredTools.map((tool: any) => tool.name).sort(), [
      "subagent_close",
      "subagent_message",
      "subagent_spawn",
    ]);
  });

  it("renders partial subagent tool-call args without throwing", () => {
    const { api, registeredTools } = createMockExtensionApi();
    subagentsExtension(api);

    const subagentTool = registeredTools.find(
      (tool: any) => tool.name === "subagent_spawn",
    );
    assert.ok(subagentTool, "expected subagent_spawn tool to be registered");

    const theme = {
      fg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
    const rendered = subagentTool.renderCall({}, theme);
    const output = rendered.render(80).join("\n");

    assert.match(output, /\(unnamed\)/);
  });

  it("registers subagent_message with the required message parameter and no autoExit", () => {
    const { api, registeredTools } = createMockExtensionApi();
    subagentsExtension(api);

    const messageTool = registeredTools.find(
      (tool: any) => tool.name === "subagent_message",
    );
    assert.ok(messageTool, "expected subagent_message tool to be registered");

    const messageSchema = messageTool.parameters.properties.message;
    assert.equal(messageSchema.type, "string");
    // The resume path is always autonomous now; there is no override.
    assert.equal(messageTool.parameters.properties.autoExit, undefined);
  });

  it("registers subagent_close for live subagents", () => {
    const { api, registeredTools } = createMockExtensionApi();
    subagentsExtension(api);

    const closeTool = registeredTools.find(
      (tool: any) => tool.name === "subagent_close",
    );
    assert.ok(closeTool, "expected subagent_close tool to be registered");
    assert.ok(closeTool.parameters.properties.name);
    assert.ok(closeTool.parameters.properties.id);
  });
});

describe("tool execute error paths", () => {
  const theme = {
    fg(_color: string, text: string) {
      return text;
    },
    bg(_color: string, text: string) {
      return text;
    },
    bold(text: string) {
      return text;
    },
  };

  function boot() {
    const mock = createMockExtensionApi();
    subagentsExtension(mock.api);
    return mock;
  }

  async function executeTool(
    name: string,
    params: object,
    env?: Record<string, string>,
  ) {
    const saved = new Map(
      Object.keys(env ?? {}).map((k) => [k, process.env[k]]),
    );
    try {
      Object.assign(process.env, env);
      const mock = boot();
      const tool = mock.registeredTools.find((t: any) => t.name === name);
      assert.ok(tool, `expected ${name} tool to be registered`);
      return await tool.execute("test-id", params, undefined, undefined, {});
    } finally {
      for (const [k, v] of saved) restoreEnvVar(k, v);
    }
  }

  it("subagent_spawn blocks self-spawning of the current agent", async () => {
    const result = await executeTool(
      "subagent_spawn",
      { agent: "planner", task: "plan more" },
      { PI_SUBAGENT_AGENT: "planner" },
    );
    assert.equal(result.details.error, "self-spawn blocked");
    assert.match(result.content[0].text, /do not start another planner/);
  });

  it("subagent_spawn blocks spawning past the nesting depth cap", async () => {
    const result = await executeTool(
      "subagent_spawn",
      { task: "do work" },
      { PI_SUBAGENT_DEPTH: "3" },
    );
    assert.equal(result.details.error, "depth limit");
    assert.match(result.content[0].text, /nesting is capped at 3 levels/);
    assert.match(result.content[0].text, /Do the work yourself/);
  });

  it("subagent_message blocks resuming past the nesting depth cap", async () => {
    const result = await executeTool(
      "subagent_message",
      { sessionFile: "/tmp/no-such-session.jsonl", message: "hello" },
      { PI_SUBAGENT_DEPTH: "3" },
    );
    assert.equal(result.details.error, "depth limit");
    assert.match(result.content[0].text, /nesting is capped at 3 levels/);
  });

  it("subagent_spawn fails unknown agent names with the available catalog", async () => {
    const result = await executeTool("subagent_spawn", {
      agent: "ghost-agent",
      task: "do work",
    });
    assert.equal(result.details.error, "unknown agent");
    assert.match(result.content[0].text, /Unknown agent "ghost-agent"/);
    assert.match(result.content[0].text, /Available agents/);
    assert.match(result.content[0].text, /scout/);
  });

  it("subagent_spawn reports a missing multiplexer instead of launching", async () => {
    const result = await executeTool(
      "subagent_spawn",
      { task: "do work" },
      { PI_SUBAGENT_MUX: "cmux" }, // cmux pinned, no CMUX_SOCKET_PATH -> unavailable
    );
    assert.equal(result.details.error, "mux not available");
    assert.match(
      result.content[0].text,
      /Subagents require a supported terminal multiplexer/,
    );
  });

  it("subagent_message reports how to target a live or ended subagent", async () => {
    const result = await executeTool("subagent_message", { message: "hello" });
    assert.equal(result.details.error, "no target");
    assert.match(result.content[0].text, /No live subagent matched/);
    assert.match(result.content[0].text, /sessionFile/);
  });

  it("subagent_close reports an unknown name", async () => {
    const result = await executeTool("subagent_close", { name: "ghost" });
    assert.match(result.content[0].text, /No running subagent named "ghost"/);
  });

  it("subagent_result renderer shows the summary without the resume hint", () => {
    const mock = boot();
    const entry = mock.registeredMessageRenderers.find(
      (e: any) => e.name === "subagent_result",
    );
    assert.ok(entry, "expected subagent_result renderer");
    const rendered = entry
      .renderer(
        {
          customType: "subagent_result",
          content:
            'Sub-agent "worker" completed (42s).\n\nAll done.\n\n' +
            "Session: /tmp/session.jsonl\n" +
            "Resume with subagent_message if a follow-up is needed.",
          details: {
            name: "worker",
            task: "write tests",
            elapsed: 42,
            sessionFile: "/tmp/session.jsonl",
          },
        },
        { expanded: true },
        theme,
      )
      .render(80)
      .join("\n");
    assert.match(rendered, /worker/);
    assert.match(rendered, /completed \(42s\)/);
    assert.match(rendered, /All done\./);
    assert.doesNotMatch(rendered, /Resume with subagent_message/);
  });

  it("subagent_result renderer marks errorMessage deliveries as failed", () => {
    // deliverWatchError produces details with an errorMessage key and no
    // exitCode — the renderer must read that key (an `error` key used to
    // render crashes as green ✓ completed).
    const mock = boot();
    const entry = mock.registeredMessageRenderers.find(
      (e: any) => e.name === "subagent_result",
    );
    assert.ok(entry, "expected subagent_result renderer");
    const rendered = entry
      .renderer(
        {
          customType: "subagent_result",
          content:
            'Sub-agent "worker" failed (provider error) after 12s.\n\nError: watch crashed',
          details: {
            name: "worker",
            task: "write tests",
            errorMessage: "watch crashed",
          },
        },
        { expanded: true },
        theme,
      )
      .render(80)
      .join("\n");
    assert.match(rendered, /failed/);
    assert.match(rendered, /watch crashed/);
    assert.doesNotMatch(rendered, /completed/);
  });

  it("subagent_ask renderer shows the question", () => {
    const mock = boot();
    const entry = mock.registeredMessageRenderers.find(
      (e: any) => e.name === "subagent_ask",
    );
    assert.ok(entry, "expected subagent_ask renderer");
    const rendered = entry
      .renderer(
        {
          customType: "subagent_ask",
          details: { name: "scout", message: "Which API should I use?" },
        },
        { expanded: true },
        theme,
      )
      .render(80)
      .join("\n");
    assert.match(rendered, /scout/);
    assert.match(rendered, /Which API should I use\?/);
  });

  it("subagent_result collapsed view previews 5 lines and hints at the rest", () => {
    initTheme(); // collapsed views render the keyHint() expand line
    const mock = boot();
    const entry = mock.registeredMessageRenderers.find(
      (e: any) => e.name === "subagent_result",
    );
    assert.ok(entry, "expected subagent_result renderer");
    const summary = ["l1", "l2", "l3", "l4", "l5", "l6", "l7"].join("\n");
    const rendered = entry
      .renderer(
        {
          customType: "subagent_result",
          content: `Sub-agent "worker" completed (42s).\n\n${summary}`,
          details: { name: "worker", task: "t", elapsed: 42, exitCode: 0 },
        },
        { expanded: false },
        theme,
      )
      .render(80)
      .join("\n");
    assert.match(rendered, /l1/);
    assert.match(rendered, /l5/);
    assert.doesNotMatch(rendered, /l6/);
    assert.match(rendered, /… 2 more lines/);
  });

  it("subagent_ask collapsed view previews the first message line only", () => {
    initTheme(); // collapsed views render the keyHint() expand line
    const mock = boot();
    const entry = mock.registeredMessageRenderers.find(
      (e: any) => e.name === "subagent_ask",
    );
    assert.ok(entry, "expected subagent_ask renderer");
    const rendered = entry
      .renderer(
        {
          customType: "subagent_ask",
          details: {
            name: "scout",
            message: "First line of the question\nsecond line",
          },
        },
        { expanded: false },
        theme,
      )
      .render(80)
      .join("\n");
    assert.match(rendered, /First line of the question/);
    assert.doesNotMatch(rendered, /second line/);
  });
});

describe("live target resolution", () => {
  function makeRunning(overrides: Record<string, unknown> = {}) {
    return {
      id: "a1",
      name: "Worker",
      task: "",
      surface: "pane-1",
      startTime: 0,
      sessionFile: "worker.jsonl",
      interactive: false,
      statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
      ...overrides,
    };
  }

  it("resolves targets by exact id and reports name ambiguity", () => {
    registry.clear();
    try {
      registry.register(makeRunning());
      registry.register(
        makeRunning({ id: "a2", name: "Worker", surface: "pane-2" }),
      );

      const byId = resolveRunningTarget({ id: "a1" });
      assert.ok(byId.ok);
      assert.equal(byId.value.running.name, "Worker");

      const ambiguous = resolveRunningTarget({ name: "Worker" });
      assert.ok(!ambiguous.ok);
      assert.match(ambiguous.error, /Ambiguous subagent name "Worker"/);
      assert.match(ambiguous.error, /a1/);
      assert.match(ambiguous.error, /a2/);

      const unknownId = resolveRunningTarget({ id: "nope" });
      assert.ok(!unknownId.ok);
      assert.match(unknownId.error, /No running subagent with id "nope"/);
    } finally {
      registry.clear();
    }
  });

  it("matchLiveTarget returns null without an error when nothing matches", () => {
    registry.clear();
    try {
      assert.deepEqual(matchLiveTarget(undefined, "ghost"), { kind: "none" });
    } finally {
      registry.clear();
    }
  });

  it("falls back to name matching when the id is stale", () => {
    registry.clear();
    try {
      registry.register(makeRunning());

      // Stale id (pre-resume id, typo) + correct display name: the name
      // must still resolve the live run.
      const byFallback = matchLiveTarget("stale-id", "Worker");
      assert.equal(byFallback.kind, "live");
      assert.equal(byFallback.kind === "live" && byFallback.running.id, "a1");
      assert.equal(byFallback.kind === "live" && byFallback.matchedBy, "name");

      // A live id wins even when the name disagrees.
      const byId = matchLiveTarget("a1", "Other Name");
      assert.equal(byId.kind, "live");
      assert.equal(byId.kind === "live" && byId.matchedBy, "id");

      // A stale id with no name still misses (resume guidance path).
      assert.deepEqual(matchLiveTarget("stale-id", undefined), {
        kind: "none",
      });
    } finally {
      registry.clear();
    }
  });

  it("close resolution requires an exact id match instead of falling back to name", () => {
    // Closing a pane is irreversible: a dead id plus a coincidentally
    // matching name must error, not act on the wrong run.
    registry.clear();
    try {
      registry.register(makeRunning());

      const resolved = resolveRunningTarget({
        id: "stale-id",
        name: "Worker",
      });
      assert.ok(!resolved.ok);
      assert.match(resolved.error, /No running subagent with id "stale-id"/);

      const exact = resolveRunningTarget({ id: "a1" });
      assert.ok(exact.ok);
      assert.equal(exact.value.running.id, "a1");
    } finally {
      registry.clear();
    }
  });
});
