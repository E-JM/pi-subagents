import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";

export function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

export function createSessionFile(dir: string, entries: object[]): string {
  const file = join(dir, "test-session.jsonl");
  const content = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
  writeFileSync(file, content);
  return file;
}

export async function withTempDir<T>(run: (dir: string) => T | Promise<T>) {
  const dir = createTestDir();
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function createMockExtensionApi() {
  const registeredTools: Array<any> = [];
  const registeredCommands: Array<any> = [];
  const registeredMessageRenderers: Array<any> = [];
  const sentUserMessages: string[] = [];
  const sentMessages: Array<any> = [];
  const eventHandlers = new Map<
    string,
    Array<(event: any, ctx: any) => void>
  >();
  const registeredShortcuts: Array<any> = [];
  return {
    registeredTools,
    registeredCommands,
    registeredMessageRenderers,
    sentUserMessages,
    sentMessages,
    eventHandlers,
    registeredShortcuts,
    emit(event: string, payload?: any, ctx?: any) {
      for (const handler of eventHandlers.get(event) ?? [])
        handler(payload, ctx);
    },
    api: {
      on(name: string, handler: (event: any, ctx: any) => void) {
        const list = eventHandlers.get(name) ?? [];
        list.push(handler);
        eventHandlers.set(name, list);
      },
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand(name: string, command: any) {
        registeredCommands.push({ name, ...command });
      },
      registerMessageRenderer(name: string, renderer: any) {
        registeredMessageRenderers.push({ name, renderer });
      },
      registerShortcut(name: string, shortcut: any) {
        registeredShortcuts.push({ name, ...shortcut });
      },
      sendUserMessage(message: string) {
        sentUserMessages.push(message);
      },
      sendMessage(message: any, options?: any) {
        sentMessages.push({ message, options });
      },
      getAllTools() {
        return [];
      },
    } as any,
  };
}

export function restoreEnvVar(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

// Extension registration and mux detection consult these env vars; a stray
// export (e.g. PI_DENY_TOOLS in reviewer sessions) silently disables tools
// and breaks unrelated tests. Snapshot-and-clear once for the whole file;
// tests that need specific values set and restore their own.
const GATED_ENV_KEYS = [
  "PI_DENY_TOOLS",
  "PI_SUBAGENT_MUX",
  "CMUX_SOCKET_PATH",
  "PI_SUBAGENT_AGENT",
];
const gatedEnvSaved = new Map(GATED_ENV_KEYS.map((k) => [k, process.env[k]]));
before(() => {
  for (const key of GATED_ENV_KEYS) delete process.env[key];
});
after(() => {
  for (const key of GATED_ENV_KEYS) restoreEnvVar(key, gatedEnvSaved.get(key));
});

export function withMockedNow<T>(now: number, fn: () => T): T {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}

export function writeAgentFile(
  agentsDir: string,
  name: string,
  frontmatter: string,
  body = "You are a test agent.",
) {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, `${name}.md`),
    `---\n${frontmatter}\n---\n\n${body}\n`,
  );
}

export async function withIsolatedAgentEnv(
  fn: (paths: {
    projectDir: string;
    projectAgentsDir: string;
    globalDir: string;
    globalAgentsDir: string;
  }) => Promise<void> | void,
) {
  const root = createTestDir();
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const projectDir = join(root, "project");
  const projectAgentsDir = join(projectDir, ".pi", "agents");
  const globalDir = join(root, "global");
  const globalAgentsDir = join(globalDir, "agents");

  mkdirSync(projectAgentsDir, { recursive: true });
  mkdirSync(globalAgentsDir, { recursive: true });
  process.chdir(projectDir);
  process.env.PI_CODING_AGENT_DIR = globalDir;

  try {
    await fn({ projectDir, projectAgentsDir, globalDir, globalAgentsDir });
  } finally {
    process.chdir(previousCwd);
    restoreEnvVar("PI_CODING_AGENT_DIR", previousAgentDir);
    rmSync(root, { recursive: true, force: true });
  }
}
export const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
export const MODEL_CHANGE = {
  type: "model_change",
  id: "mc-001",
  parentId: null,
};
export const USER_MSG = {
  type: "message",
  id: "user-001",
  parentId: "mc-001",
  message: {
    role: "user",
    content: [{ type: "text", text: "Hello, plan something" }],
  },
};
export const ASSISTANT_MSG = {
  type: "message",
  id: "asst-001",
  parentId: "user-001",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Here is my plan..." }],
  },
};
export const ASSISTANT_MSG_2 = {
  type: "message",
  id: "asst-002",
  parentId: "asst-001",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think..." },
      { type: "text", text: "Updated plan with details." },
    ],
  },
};
export const TOOL_RESULT = {
  type: "message",
  id: "tool-001",
  parentId: "asst-001",
  message: {
    role: "toolResult",
    toolCallId: "tc-001",
    toolName: "bash",
    content: [{ type: "text", text: "output here" }],
  },
};
