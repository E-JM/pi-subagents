// Composition root for the subagents extension: wires the register* functions
// from the focused modules into the pi extension lifecycle.
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerSubagentCommands } from "./commands.ts";
import { registry, setLatestContext, teardownModuleTimers } from "./state.ts";
import { registerSubagentCloseTool } from "./tools/close.ts";
import { registerSubagentMessageTool } from "./tools/message.ts";
import { registerSubagentSpawnTool } from "./tools/spawn.ts";
import { registerSubagentMessageRenderers } from "./ui/renderers.ts";

export default function subagentsExtension(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    setLatestContext(ctx);
  });

  pi.on("session_shutdown", (_event, _ctx) => {
    teardownModuleTimers();
    for (const agent of registry.all()) {
      agent.abortController?.abort();
    }
    registry.clear();
  });

  // Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
  const deniedTools = new Set(
    (process.env.PI_DENY_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const shouldRegister = (name: string) => !deniedTools.has(name);

  registerSubagentSpawnTool(pi, shouldRegister);
  registerSubagentMessageTool(pi, shouldRegister);
  registerSubagentCloseTool(pi, shouldRegister);
  registerSubagentCommands(pi);
  registerSubagentMessageRenderers(pi);
}
