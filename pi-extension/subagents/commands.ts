// Slash commands: /iterate, /subagent, /subagent-layout, /plan.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionUIContext,
  DynamicBorder,
  getSelectListTheme,
} from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList } from "@mariozechner/pi-tui";
import { loadAgentDefaults } from "./agents.ts";
import {
  getMuxBackend,
  getSubagentLayoutMode,
  isMuxAvailable,
  renameCurrentTab,
  renameWorkspace,
  type SubagentLayoutMode,
  setSubagentLayoutMode,
} from "./cmux.ts";
import { SUBAGENTS_DIR } from "./util.ts";

const SUBAGENT_LAYOUT_ITEMS: SelectItem[] = [
  {
    value: "columns",
    label: "columns",
    description: "Full-height columns of equal width",
  },
  {
    value: "tiled",
    label: "tiled",
    description: "Block grid: 1×1 → 2×2 → 2×3 → 3×3 …",
  },
];

/**
 * Interactive layout picker, mirroring the built-in /thinking selector:
 * bordered SelectList, current mode preselected, Esc cancels.
 */
async function selectSubagentLayout(
  ui: ExtensionUIContext,
  current: SubagentLayoutMode,
): Promise<SubagentLayoutMode | undefined> {
  return ui.custom<SubagentLayoutMode | undefined>(
    (_tui, _theme, _keybindings, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder());
      const list = new SelectList(
        SUBAGENT_LAYOUT_ITEMS,
        SUBAGENT_LAYOUT_ITEMS.length,
        getSelectListTheme(),
      );
      const currentIndex = SUBAGENT_LAYOUT_ITEMS.findIndex(
        (item) => item.value === current,
      );
      if (currentIndex !== -1) list.setSelectedIndex(currentIndex);
      list.onSelect = (item) => {
        if (item.value === "columns" || item.value === "tiled")
          done(item.value);
      };
      list.onCancel = () => done(undefined);
      container.addChild(list);
      container.addChild(new DynamicBorder());
      return {
        render: (width: number) => container.render(width),
        handleInput: (data: string) => list.handleInput(data),
        invalidate: () => list.invalidate(),
      };
    },
  );
}

export function registerSubagentCommands(pi: ExtensionAPI): void {
  pi.registerCommand("iterate", {
    description:
      "Fork session into a subagent for focused work (bugfixes, iteration)",
    handler: async (args, _ctx) => {
      const task = args.trim() || "";
      const toolCall = task
        ? `Use subagent_spawn to fork a session. fork: true, name: "Iterate", task: ${JSON.stringify(task)}`
        : `Use subagent_spawn to fork a session. fork: true, name: "Iterate", task: "The user wants to do some hands-on work. Help them with whatever they need."`;
      pi.sendUserMessage(toolCall);
    },
  });

  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const defs = loadAgentDefaults(agentName);
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in .pi/agents/, ~/.pi/agent/agents/, or the bundled agents directory`,
          "error",
        );
        return;
      }

      const taskText =
        task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const toolCall = `Use subagent_spawn with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });

  pi.registerCommand("subagent-layout", {
    description: "Subagent pane layout: columns ↔ tiled grid (herdr/tmux)",
    getArgumentCompletions: (argumentPrefix) => {
      const prefix = argumentPrefix.trim().toLowerCase();
      const items = SUBAGENT_LAYOUT_ITEMS.filter((item) =>
        item.value.startsWith(prefix),
      );
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg && arg !== "columns" && arg !== "tiled") {
        ctx.ui.notify("Usage: /subagent-layout [columns|tiled]", "warning");
        return;
      }
      const current = getSubagentLayoutMode();
      const next =
        arg === "columns" || arg === "tiled"
          ? arg
          : await selectSubagentLayout(ctx.ui, current);
      if (!next) return; // picker canceled
      setSubagentLayoutMode(next);
      const backend = getMuxBackend();
      const note =
        backend === "herdr" || backend === "tmux"
          ? ""
          : " (note: this multiplexer uses its own layout)";
      ctx.ui.notify(
        `Subagent layout: ${next}${note} — applies to newly spawned subagents`,
        "info",
      );
    },
  });

  pi.registerCommand("plan", {
    description: "Start a planning session: /plan <what to build>",
    handler: async (args, ctx) => {
      const task = args.trim();
      if (!task) {
        ctx.ui.notify("Usage: /plan <what to build>", "warning");
        return;
      }

      if (isMuxAvailable()) {
        try {
          const label = task.length > 40 ? `${task.slice(0, 40)}...` : task;
          renameWorkspace(`🎯 ${label}`);
          renameCurrentTab(`🎯 Plan: ${label}`);
        } catch {
          // non-critical -- do not block the plan
        }
      }

      const planSkillPath = join(SUBAGENTS_DIR, "plan-skill.md");
      let content = readFileSync(planSkillPath, "utf8");
      content = content.replace(/^---\n[\s\S]*?\n---\n*/, "");
      pi.sendUserMessage(
        `<skill name="plan" location="${planSkillPath}">\n${content.trim()}\n</skill>\n\n${task}`,
      );
    },
  });
}
