import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { readSubagentActivityFile } from "../pi-extension/subagents/activity/read.ts";
import {
  decideAgentEnd,
  findLatestAssistantError,
} from "../pi-extension/subagents/child/protocol.ts";
import childExtension from "../pi-extension/subagents/child.ts";
import {
  createMockExtensionApi,
  restoreEnvVar,
  withTempDir,
} from "./helpers.ts";

describe("child.ts lifecycle decision", () => {
  describe("decideAgentEnd", () => {
    it("exits with done after a normal turn end — turn end IS completion", () => {
      const decision = decideAgentEnd({
        interactive: false,
        awaitingReply: false,
        unconsumedInput: false,
        messages: [{ role: "assistant", stopReason: "stop" }],
      });
      assert.deepEqual(decision, { action: "done" });
    });

    it("waits while an ask_question is awaiting its reply", () => {
      const decision = decideAgentEnd({
        interactive: false,
        awaitingReply: true,
        unconsumedInput: false,
        messages: [{ role: "assistant", stopReason: "stop" }],
      });
      assert.deepEqual(decision, { action: "wait", reason: "awaiting-reply" });
    });

    it("keeps interactive sessions open regardless of everything else", () => {
      assert.deepEqual(
        decideAgentEnd({
          interactive: true,
          awaitingReply: false,
          unconsumedInput: false,
          messages: [{ role: "assistant", stopReason: "stop" }],
        }),
        { action: "wait", reason: "interactive" },
      );
      assert.deepEqual(
        decideAgentEnd({
          interactive: true,
          awaitingReply: false,
          unconsumedInput: false,
          messages: [
            { role: "assistant", stopReason: "error", errorMessage: "529" },
          ],
        }),
        { action: "wait", reason: "interactive" },
      );
    });

    it("waits while input has not been processed by a completed turn", () => {
      assert.deepEqual(
        decideAgentEnd({
          interactive: false,
          awaitingReply: false,
          unconsumedInput: true,
          messages: [{ role: "assistant", stopReason: "stop" }],
        }),
        { action: "wait", reason: "queued-input" },
      );
    });

    it("stays open after Escape aborts the run", () => {
      assert.deepEqual(
        decideAgentEnd({
          interactive: false,
          awaitingReply: false,
          unconsumedInput: false,
          messages: [{ role: "assistant", stopReason: "aborted" }],
        }),
        { action: "wait", reason: "aborted" },
      );
    });

    it("exits when the turn produced no assistant message", () => {
      assert.deepEqual(
        decideAgentEnd({
          interactive: false,
          awaitingReply: false,
          unconsumedInput: false,
          messages: [{ role: "user" }],
        }),
        { action: "done" },
      );
      assert.deepEqual(
        decideAgentEnd({
          interactive: false,
          awaitingReply: false,
          unconsumedInput: false,
          messages: undefined,
        }),
        { action: "done" },
      );
    });

    it("exits with error info when the turn ended with stopReason=error", () => {
      // The parent must be woken with the failure instead of waiting on a
      // stalled provider.
      const decision = decideAgentEnd({
        interactive: false,
        awaitingReply: false,
        unconsumedInput: false,
        messages: [
          { role: "assistant", stopReason: "error", errorMessage: "529" },
        ],
      });
      assert.deepEqual(decision, { action: "error", errorMessage: "529" });
    });

    it("pending input and asks outrank a provider error", () => {
      // Exiting now would drop the input the next turn was going to process.
      assert.deepEqual(
        decideAgentEnd({
          interactive: false,
          awaitingReply: true,
          unconsumedInput: false,
          messages: [
            { role: "assistant", stopReason: "error", errorMessage: "529" },
          ],
        }),
        { action: "wait", reason: "awaiting-reply" },
      );
      assert.deepEqual(
        decideAgentEnd({
          interactive: false,
          awaitingReply: false,
          unconsumedInput: true,
          messages: [
            { role: "assistant", stopReason: "error", errorMessage: "529" },
          ],
        }),
        { action: "wait", reason: "queued-input" },
      );
    });
  });

  describe("findLatestAssistantError", () => {
    it("returns the error info from a stopReason=error message", () => {
      const messages = [
        {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "ok" }],
        },
        { role: "toolResult", content: [] },
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Anthropic 529 Overloaded",
        },
      ];
      assert.equal(
        findLatestAssistantError(messages),
        "Anthropic 529 Overloaded",
      );
    });

    it("returns null when the latest assistant turn completed normally", () => {
      const messages = [
        { role: "assistant", stopReason: "error", errorMessage: "old failure" },
        { role: "user", content: [] },
        {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "done" }],
        },
      ];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("returns null when the latest assistant turn was aborted by the user", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("falls back to a placeholder when stopReason=error has no errorMessage field", () => {
      const messages = [{ role: "assistant", stopReason: "error" }];
      const message = findLatestAssistantError(messages);
      assert.match(String(message), /stopReason=error/);
    });

    it("returns null when messages is undefined or empty", () => {
      assert.equal(findLatestAssistantError(undefined), null);
      assert.equal(findLatestAssistantError([]), null);
    });
  });
});

describe("child.ts extension bootstrap", () => {
  const envKeys = [
    "PI_SUBAGENT_NAME",
    "PI_SUBAGENT_AGENT",
    "PI_DENY_TOOLS",
    "PI_SUBAGENT_INTERACTIVE",
    "PI_SUBAGENT_ID",
    "PI_SUBAGENT_ACTIVITY_FILE",
    "PI_SUBAGENT_SESSION",
  ];
  let savedEnv: Record<string, string | undefined>;
  before(() => {
    savedEnv = {};
    for (const key of envKeys) savedEnv[key] = process.env[key];
  });
  after(() => {
    for (const key of envKeys) restoreEnvVar(key, savedEnv[key]);
  });

  function bootstrap(env: Record<string, string> = {}) {
    for (const key of envKeys) delete process.env[key];
    Object.assign(process.env, env);
    const mock = createMockExtensionApi();
    childExtension(mock.api);
    return mock;
  }

  function makeCtx(dir: string, env: Record<string, string> = {}) {
    const setWidgetCalls: Array<{ key: string; factory: any }> = [];
    let shutdowns = 0;
    const sessionFile = join(dir, "session.jsonl");
    const ctx = {
      ui: {
        setWidget: (key: string, factory: any) =>
          setWidgetCalls.push({ key, factory }),
      },
      shutdown: () => {
        shutdowns++;
      },
      sessionFile,
      env,
    };
    return { ctx, setWidgetCalls, shutdowns: () => shutdowns, sessionFile };
  }

  const theme = {
    bg: (_key: string, text: string) => text,
    fg: (_key: string, text: string) => text,
    bold: (text: string) => text,
  };

  it("registers lifecycle handlers, the ask_question tool, and the ctrl+j shortcut", () => {
    const mock = bootstrap();
    for (const event of [
      "session_start",
      "input",
      "before_agent_start",
      "agent_start",
      "agent_end",
      "turn_start",
      "turn_end",
      "before_provider_request",
      "after_provider_response",
      "message_update",
      "tool_execution_start",
      "tool_call",
      "tool_execution_update",
      "tool_result",
      "tool_execution_end",
      "session_shutdown",
    ]) {
      assert.ok(mock.eventHandlers.has(event), `missing handler for ${event}`);
    }
    assert.deepEqual(
      mock.registeredTools.map((t) => t.name),
      ["ask_question"],
    );
    assert.equal(mock.registeredShortcuts[0]?.name, "ctrl+j");
  });

  it("session_start renders the identity widget", () => {
    withTempDir((dir) => {
      const mock = bootstrap({ PI_SUBAGENT_NAME: "worker" });
      const { ctx, setWidgetCalls } = makeCtx(dir);
      mock.emit("session_start", {}, ctx);
      assert.equal(setWidgetCalls.length, 1);
      assert.equal(setWidgetCalls[0]!.key, "subagent-tools");
      const box = setWidgetCalls[0]!.factory(null, theme);
      assert.ok(Array.isArray(box.render(60)));
    });
  });

  it("ctrl+j toggles the widget between collapsed and expanded", () => {
    withTempDir((dir) => {
      const mock = bootstrap({ PI_SUBAGENT_NAME: "worker" });
      const { ctx, setWidgetCalls } = makeCtx(dir);
      mock.emit("session_start", {}, ctx);
      const collapsed = setWidgetCalls[0]!
        .factory(null, theme)
        .render(60)
        .join("\n");
      assert.match(collapsed, /Ctrl\+J to expand/);
      mock.registeredShortcuts[0].handler(ctx);
      const expanded = setWidgetCalls[1]!
        .factory(null, theme)
        .render(60)
        .join("\n");
      assert.match(expanded, /Ctrl\+J to collapse/);
      assert.match(expanded, /0 available/);
      mock.registeredShortcuts[0].handler(ctx);
      assert.match(
        setWidgetCalls[2]!.factory(null, theme).render(60).join("\n"),
        /Ctrl\+J to expand/,
      );
    });
  });

  it("widget lists available and denied tools", () => {
    withTempDir((dir) => {
      const mock = bootstrap({ PI_DENY_TOOLS: "write, edit" });
      mock.api.getAllTools = () => [{ name: "read" }, { name: "write" }];
      const { ctx, setWidgetCalls } = makeCtx(dir);
      mock.emit("session_start", {}, ctx);
      const collapsed = setWidgetCalls[0]!
        .factory(null, theme)
        .render(60)
        .join("\n");
      assert.match(collapsed, /2 tools/);
      assert.match(collapsed, /2 denied/);
      mock.registeredShortcuts[0].handler(ctx);
      const expanded = setWidgetCalls[1]!
        .factory(null, theme)
        .render(60)
        .join("\n");
      assert.match(expanded, /read/);
      assert.match(expanded, /denied: write, edit/);
    });
  });

  it("lifecycle events reach the activity recorder file the parent reads", () => {
    withTempDir((dir) => {
      const activityFile = join(dir, "activity.json");
      const mock = bootstrap({
        PI_SUBAGENT_ID: "child-1",
        PI_SUBAGENT_ACTIVITY_FILE: activityFile,
      });
      const { ctx } = makeCtx(dir);
      mock.emit("session_start", {}, ctx);
      mock.emit("input");
      mock.emit("before_agent_start");
      mock.emit("agent_start");
      mock.emit("turn_start", { turnIndex: 0 });
      mock.emit("before_provider_request");
      mock.emit("after_provider_response");
      mock.emit("message_update", { assistantMessageEvent: { type: "text" } });
      mock.emit("tool_execution_start", { toolCallId: "t1", toolName: "read" });
      mock.emit("tool_call", { toolCallId: "t1", toolName: "read" });
      mock.emit("tool_execution_update", {
        toolCallId: "t1",
        toolName: "read",
      });
      mock.emit("tool_result", { toolCallId: "t1", toolName: "read" });
      mock.emit("tool_execution_end", { toolCallId: "t1", toolName: "read" });
      mock.emit("turn_end", { turnIndex: 0 });
      mock.emit(
        "agent_end",
        { messages: [{ role: "assistant", stopReason: "stop" }] },
        ctx,
      );
      mock.emit("session_shutdown");
      const activity = readSubagentActivityFile(activityFile, "child-1");
      assert.ok(activity, "activity file was written");
    });
  });

  it("agent_end shuts down an autonomous session after a normal turn and writes the done sidecar", () => {
    withTempDir((dir) => {
      const mock = bootstrap({
        PI_SUBAGENT_SESSION: join(dir, "session.jsonl"),
      });
      const { ctx, shutdowns, sessionFile } = makeCtx(dir);
      mock.emit(
        "agent_end",
        { messages: [{ role: "assistant", stopReason: "stop" }] },
        ctx,
      );
      assert.equal(shutdowns(), 1);
      assert.deepEqual(
        JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
        {
          type: "done",
        },
      );
    });
  });

  it("agent_end keeps an aborted turn alive without a sidecar", () => {
    withTempDir((dir) => {
      const mock = bootstrap({
        PI_SUBAGENT_SESSION: join(dir, "session.jsonl"),
      });
      const { ctx, shutdowns, sessionFile } = makeCtx(dir);
      mock.emit(
        "agent_end",
        { messages: [{ role: "assistant", stopReason: "aborted" }] },
        ctx,
      );
      assert.equal(shutdowns(), 0);
      assert.ok(!existsSync(`${sessionFile}.exit`));
    });
  });

  it("agent_end keeps the session alive while an ask_question awaits its reply", async () => {
    await withTempDir(async (dir) => {
      const mock = bootstrap({
        PI_SUBAGENT_SESSION: join(dir, "session.jsonl"),
      });
      const { ctx, shutdowns, sessionFile } = makeCtx(dir);
      const tool = mock.registeredTools.find((t) => t.name === "ask_question");
      await tool.execute(
        "id",
        { message: "Which schema?" },
        undefined,
        undefined,
        ctx,
      );
      mock.emit(
        "agent_end",
        { messages: [{ role: "assistant", stopReason: "stop" }] },
        ctx,
      );
      assert.equal(shutdowns(), 0);
      assert.ok(!existsSync(`${sessionFile}.exit`));
    });
  });

  it("interactive sessions never auto-exit", () => {
    withTempDir((dir) => {
      const mock = bootstrap({ PI_SUBAGENT_INTERACTIVE: "1" });
      const { ctx, shutdowns } = makeCtx(dir);
      mock.emit(
        "agent_end",
        { messages: [{ role: "assistant", stopReason: "stop" }] },
        ctx,
      );
      assert.equal(shutdowns(), 0);
    });
  });

  it("input queued mid-run waits for its reply turn, then the turn end exits", () => {
    withTempDir((dir) => {
      const mock = bootstrap({
        PI_SUBAGENT_SESSION: join(dir, "session.jsonl"),
      });
      const { ctx, shutdowns, sessionFile } = makeCtx(dir);

      // The first turn consumes the task input (turn_start snapshots the
      // count, turn_end marks it consumed) — a latched count wedged every spawn.
      mock.emit("input", { text: "the task" });
      mock.emit("turn_start", { turnIndex: 0 });
      mock.emit("turn_end", { turnIndex: 0 });
      mock.emit(
        "agent_end",
        { messages: [{ role: "assistant", stopReason: "stop" }] },
        ctx,
      );
      assert.equal(shutdowns(), 1, "consumed task input does not block exit");

      mock.emit("input", { text: "[parent] also list the files" });
      mock.emit(
        "agent_end",
        { messages: [{ role: "assistant", stopReason: "stop" }] },
        ctx,
      );
      assert.equal(shutdowns(), 1, "unconsumed input blocks the exit");

      mock.emit("turn_start", { turnIndex: 1 });
      mock.emit("turn_end", { turnIndex: 1 });
      mock.emit(
        "agent_end",
        { messages: [{ role: "assistant", stopReason: "stop" }] },
        ctx,
      );
      assert.equal(shutdowns(), 2);
      assert.deepEqual(
        JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
        {
          type: "done",
        },
      );
    });
  });

  it("input arriving after a turn started is not swallowed by that turn's end", () => {
    withTempDir((dir) => {
      const mock = bootstrap({
        PI_SUBAGENT_SESSION: join(dir, "session.jsonl"),
      });
      const { ctx, shutdowns } = makeCtx(dir);

      // Input landing after turn_start was not processed by that turn, so its
      // end must not mark it consumed.
      mock.emit("input", { text: "the task" });
      mock.emit("turn_start", { turnIndex: 0 });
      mock.emit("input", { text: "[parent] actually, also check tests" });
      mock.emit("turn_end", { turnIndex: 0 });
      mock.emit(
        "agent_end",
        { messages: [{ role: "assistant", stopReason: "stop" }] },
        ctx,
      );
      assert.equal(shutdowns(), 0, "late-arriving input is not consumed");

      mock.emit("turn_start", { turnIndex: 1 });
      mock.emit("turn_end", { turnIndex: 1 });
      mock.emit(
        "agent_end",
        { messages: [{ role: "assistant", stopReason: "stop" }] },
        ctx,
      );
      assert.equal(shutdowns(), 1, "the reply turn's end exits");
    });
  });

  it("a reply input releases a pending ask; the processed turn's end exits", async () => {
    await withTempDir(async (dir) => {
      const mock = bootstrap({
        PI_SUBAGENT_SESSION: join(dir, "session.jsonl"),
      });
      const { ctx, shutdowns, sessionFile } = makeCtx(dir);
      const tool = mock.registeredTools.find((t) => t.name === "ask_question");
      await tool.execute(
        "id",
        { message: "Which schema?" },
        undefined,
        undefined,
        ctx,
      );
      mock.emit(
        "agent_end",
        { messages: [{ role: "assistant", stopReason: "stop" }] },
        ctx,
      );
      assert.equal(shutdowns(), 0, "waiting for the reply");

      mock.emit("input", { text: "[parent] use v2" });
      mock.emit("turn_start", { turnIndex: 1 });
      mock.emit(
        "agent_end",
        { messages: [{ role: "assistant", stopReason: "stop" }] },
        ctx,
      );
      assert.equal(shutdowns(), 0, "the reply turn has not completed yet");
      mock.emit("turn_end", { turnIndex: 1 });
      mock.emit(
        "agent_end",
        { messages: [{ role: "assistant", stopReason: "stop" }] },
        ctx,
      );
      assert.equal(shutdowns(), 1);
      assert.deepEqual(
        JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
        {
          type: "done",
        },
      );
    });
  });

  it("agent_end writes an error sidecar when the turn ended with stopReason=error", () => {
    withTempDir((dir) => {
      const mock = bootstrap({
        PI_SUBAGENT_SESSION: join(dir, "session.jsonl"),
      });
      const { ctx, shutdowns, sessionFile } = makeCtx(dir);
      mock.emit(
        "agent_end",
        {
          messages: [
            {
              role: "assistant",
              stopReason: "error",
              errorMessage: "529 overloaded",
            },
          ],
        },
        ctx,
      );
      assert.equal(shutdowns(), 1);
      assert.deepEqual(
        JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
        {
          type: "error",
          errorMessage: "529 overloaded",
          stopReason: "error",
        },
      );
    });
  });

  it("agent_end still shuts down when the error sidecar path is unwritable", () => {
    withTempDir((dir) => {
      const mock = bootstrap({
        PI_SUBAGENT_SESSION: join(dir, "missing-dir", "session.jsonl"),
      });
      const { ctx, shutdowns } = makeCtx(dir);
      mock.emit(
        "agent_end",
        {
          messages: [
            {
              role: "assistant",
              stopReason: "error",
              errorMessage: "529 overloaded",
            },
          ],
        },
        ctx,
      );
      assert.equal(
        shutdowns(),
        1,
        "shutdown must not be blocked by a failed sidecar write",
      );
    });
  });

  it("ask_question throws outside a subagent context", async () => {
    const mock = bootstrap({});
    const tool = mock.registeredTools.find((t) => t.name === "ask_question");
    await assert.rejects(
      () =>
        tool.execute(
          "id",
          { message: "help" },
          undefined,
          undefined,
          {} as any,
        ),
      /PI_SUBAGENT_SESSION/,
    );
  });

  it("ask_question writes an .ask sidecar and does NOT shut down", async () => {
    await withTempDir(async (dir) => {
      const mock = bootstrap({
        PI_SUBAGENT_SESSION: join(dir, "session.jsonl"),
      });
      const tool = mock.registeredTools.find((t) => t.name === "ask_question");
      const { ctx, shutdowns, sessionFile } = makeCtx(dir);
      const result = await tool.execute(
        "id",
        { message: "need a decision" },
        undefined,
        undefined,
        ctx,
      );
      assert.equal(shutdowns(), 0, "ask keeps the session alive");
      assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.ask`, "utf8")), {
        name: "subagent",
        message: "need a decision",
      });
      assert.match(result.content[0].text, /End your turn now/);
    });
  });

  it("ask_question failure does not latch awaitingReply — the turn-end rule still applies", async () => {
    await withTempDir(async (dir) => {
      // Session dir removed after startup: the sidecar write fails.
      const mock = bootstrap({
        PI_SUBAGENT_SESSION: join(dir, "gone", "session.jsonl"),
      });
      const tool = mock.registeredTools.find((t) => t.name === "ask_question");
      const { ctx, shutdowns } = makeCtx(dir);
      await assert.rejects(() =>
        tool.execute("id", { message: "help" }, undefined, undefined, ctx),
      );
      // The write failed, so nothing is latched: the session exits instead of
      // waiting forever for a reply the parent never saw.
      mock.emit(
        "agent_end",
        {
          messages: [
            { role: "assistant", stopReason: "error", errorMessage: "x" },
          ],
        },
        ctx,
      );
      assert.equal(shutdowns(), 1, "failed ask must not park the session");
    });
  });
});
