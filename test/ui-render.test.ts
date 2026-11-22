import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@mariozechner/pi-tui";
import { resolveResultPresentation } from "../pi-extension/subagents/delivery.ts";
import subagentsExtension from "../pi-extension/subagents/index.ts";
import { randomHex } from "../pi-extension/subagents/random.ts";
import { getShellReadyDelayMs } from "../pi-extension/subagents/shell.ts";
import { createStatusState } from "../pi-extension/subagents/status/snapshot.ts";
import {
  borderLine,
  renderSubagentWidgetLines,
} from "../pi-extension/subagents/ui/widget.ts";
import { createMockExtensionApi } from "./helpers.ts";

describe("result presentation", () => {
  it("formats exit code 130 as an ordinary failure with the resume hint", () => {
    const presentation = resolveResultPresentation(
      {
        exitCode: 130,
        elapsed: 61,
        summary: "Sub-agent exited with code 130",
        sessionFile: "/tmp/subagent.jsonl",
      },
      "Worker",
    );

    assert.match(presentation, /failed \(exit code 130\)/);
    assert.match(presentation, /Resume with subagent_message/);
  });

  it("renders a clear provider/agent error when errorMessage is set", () => {
    // A retry-exhausted run must surface the underlying error instead of
    // silently presenting a stale summary as the result.
    const presentation = resolveResultPresentation(
      {
        exitCode: 1,
        elapsed: 14,
        summary: "ignored when errorMessage is present",
        sessionFile: "/tmp/subagent.jsonl",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
      "Worker",
    );

    assert.match(presentation, /Sub-agent "Worker" failed/);
    assert.match(presentation, /provider\/agent error — auto-retry exhausted/);
    assert.match(
      presentation,
      /Error: Anthropic 529 Overloaded after 3 retries/,
    );
    assert.match(presentation, /subagent_message/);
    assert.match(presentation, /Resume with subagent_message/);
    assert.doesNotMatch(presentation, /ignored when errorMessage is present/);
  });

  it("completed runs carry the summary and the session reference", () => {
    const presentation = resolveResultPresentation(
      {
        exitCode: 0,
        elapsed: 42,
        summary: "All done, tests green.",
        sessionFile: "/tmp/subagent.jsonl",
      },
      "Worker",
    );

    assert.match(presentation, /Sub-agent "Worker" completed \(42s\)/);
    assert.match(presentation, /All done, tests green\./);
    assert.match(presentation, /Session: \/tmp\/subagent\.jsonl/);
  });
});

describe("subagent status renderer", () => {
  function createTheme() {
    return {
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
  }

  it("renders only capped lines plus overflow", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    subagentsExtension(api);

    const rendererEntry = registeredMessageRenderers.find(
      (entry) => entry.name === "subagent_status",
    );
    assert.ok(
      rendererEntry,
      "expected subagent_status renderer to be registered",
    );

    const visibleLines = [
      "Worker running 5m, active (bash 2m).",
      "Scout running 3m, waiting 1m.",
      "Reviewer running 2m, active (streaming 30s).",
      "Planner running 4m, waiting 2m.",
    ];
    const rendered = rendererEntry.renderer(
      {
        customType: "subagent_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: {
          lines: visibleLines,
          overflow: 2,
        },
      },
      { expanded: true },
      createTheme(),
    );
    const output = rendered.render(80).join("\n");

    assert.match(output, /Subagent status/);
    for (const line of visibleLines) {
      assert.match(
        output,
        new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    }
    assert.match(output, /\+2 more running\./);
  });

  it("stays within narrow widths", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    subagentsExtension(api);

    const rendererEntry = registeredMessageRenderers.find(
      (entry) => entry.name === "subagent_status",
    );
    assert.ok(
      rendererEntry,
      "expected subagent_status renderer to be registered",
    );

    const rendered = rendererEntry.renderer(
      {
        customType: "subagent_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: {
          lines: ["Worker running 5m, active (bash 2m)."],
          overflow: 0,
        },
      },
      { expanded: true },
      createTheme(),
    );

    for (const width of [4, 5, 6]) {
      for (const line of rendered.render(width)) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

describe("subagent startup delay", () => {
  it("defaults to 500ms when no env var is set", () => {
    assert.equal(typeof getShellReadyDelayMs, "function");

    const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    try {
      assert.equal(getShellReadyDelayMs(), 500);
    } finally {
      if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
    }
  });

  it("uses PI_SUBAGENT_SHELL_READY_DELAY_MS when it is set", () => {
    assert.equal(typeof getShellReadyDelayMs, "function");

    const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "2500";
    try {
      assert.equal(getShellReadyDelayMs(), 2500);
    } finally {
      if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
    }
  });

  it("randomHex is always exactly the requested length in hex chars", () => {
    for (let i = 0; i < 200; i++) {
      const fragment = randomHex(8);
      assert.equal(fragment.length, 8);
      assert.match(fragment, /^[0-9a-f]+$/);
    }
    // Odd counts take the leading chars of a crypto-strong byte string.
    assert.equal(randomHex(3).length, 3);
  });
});

describe("subagents widget rendering", () => {
  it("keeps every rendered line within a very narrow width", () => {
    assert.equal(typeof renderSubagentWidgetLines, "function");

    const originalNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      const lines = renderSubagentWidgetLines(
        [
          {
            id: "a1",
            name: "A",
            task: "",
            surface: "s1",
            startTime: 1_000_000 - 13_000,
            sessionFile: "sess1",
            interactive: false,
            statusState: createStatusState({
              source: "pi",
              startTimeMs: 1_000_000 - 13_000,
            }),
          },
          {
            id: "a2",
            name: "B",
            task: "",
            surface: "s2",
            startTime: 1_000_000 - 21_000,
            sessionFile: "sess2",
            interactive: false,
            statusState: createStatusState({
              source: "pi",
              startTimeMs: 1_000_000 - 21_000,
            }),
          },
          {
            id: "a3",
            name: "C",
            task: "",
            surface: "s3",
            startTime: 1_000_000 - 27_000,
            sessionFile: "sess3",
            interactive: false,
            statusState: createStatusState({
              source: "pi",
              startTimeMs: 1_000_000 - 27_000,
            }),
          },
        ],
        16,
      );

      assert.deepEqual(
        lines.map((line: string) => visibleWidth(line)),
        [16, 16, 16, 16, 16],
      );
    } finally {
      Date.now = originalNow;
    }
  });

  it("truncates the right-hand status instead of overflowing when it alone is too wide", () => {
    assert.equal(typeof borderLine, "function");

    const line = borderLine(" A ", " 999 msgs (999.9KB) ", 16);
    assert.equal(visibleWidth(line), 16);
  });

  it("handles ultra-narrow widths without exceeding the width contract", () => {
    assert.equal(typeof renderSubagentWidgetLines, "function");

    const widths = [0, 1, 2];
    for (const width of widths) {
      const startTime = Date.now() - 5_000;
      const lines = renderSubagentWidgetLines(
        [
          {
            id: "a1",
            name: "A",
            task: "",
            surface: "s1",
            startTime,
            sessionFile: "sess1",
            interactive: false,
            statusState: createStatusState({
              source: "pi",
              startTimeMs: startTime,
            }),
          },
        ],
        width,
      );

      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});
