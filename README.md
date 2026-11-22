# pi-subagent

**pi-subagent** is a fully **non-blocking async system** for [pi](https://github.com/badlogic/pi-mono) — spawn, orchestrate, and manage sub-agent sessions in multiplexer panes while the main agent keeps working in the background. Inspired by [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents).

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [How It Works](#how-it-works)
- [Tools & Commands](#tools--commands)
- [Bundled Agents](#bundled-agents)
- [The Subagent Lifecycle](#the-subagent-lifecycle)
  - [Asking the parent (ask_question)](#asking-the-parent-ask_question)
  - [Messaging a subagent](#messaging-a-subagent)
  - [Closing a subagent](#closing-a-subagent)
  - [Status supervision](#status-supervision)
- [Spawning Subagents](#spawning-subagents)
- [Workflows](#workflows)
- [Custom Agents](#custom-agents)
- [Tool Access Control](#tool-access-control)
- [Role Folders](#role-folders)
- [Tools Widget](#tools-widget)
- [Configuration](#configuration)
- [Project structure](#project-structure)

## Requirements

- [pi](https://github.com/badlogic/pi-mono) — the coding agent
- Node.js ≥ 20.6 (what pi runs on). Working on the extension itself needs ≥ 23.6, because the sources and tests are `.ts` files executed directly by Node's type stripping — there is no build step and no emitted JS.
- One supported multiplexer: [cmux](https://github.com/manaflow-ai/cmux), [tmux](https://github.com/tmux/tmux), [zellij](https://zellij.dev), [WezTerm](https://wezfurlong.org/wezterm/), or [herdr](https://herdr.dev)

## Install

```bash
pi install git:github.com/E-JM/pi-subagent
```

Then start pi inside a supported multiplexer:

| Multiplexer                                    | Start pi with                                      |
| ---------------------------------------------- | -------------------------------------------------- |
| [cmux](https://github.com/manaflow-ai/cmux)    | `cmux pi`                                          |
| [tmux](https://github.com/tmux/tmux)           | `tmux new -A -s pi 'pi'`                           |
| [zellij](https://zellij.dev)                   | `zellij --session pi`, then run `pi`               |
| [herdr](https://herdr.dev)                     | run `herdr`, then run `pi`                         |
| [WezTerm](https://wezfurlong.org/wezterm/)     | just run `pi` — built-in multiplexing, no wrapper  |

See [Configuration](#configuration) for backend overrides, pane layouts, and tuning.

## How It Works

Call `subagent_spawn` and it **returns immediately**. The sub-agent runs in its own terminal pane. A live widget above the input shows all running agents with their current state — `starting`, `active`, `waiting`, `stalled`, or `running`.

**One completion rule for every spawn: ending the turn is finishing.** When a sub-agent's turn ends, the session closes automatically and its last assistant message is steered back to the parent as the run result — no explicit done call is needed. A sub-agent that needs input from the parent calls `ask_question` instead, which keeps the pane alive until the reply arrives.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  Scout: Auth (scout)        active · bash 7m │
│ 00:45  Scout: DB (scout)                waiting 2m │
╰────────────────────────────────────────────────────╯
```

For parallel execution, just call `subagent_spawn` multiple times — they all run concurrently:

```typescript
subagent_spawn({ name: "Scout: Auth", agent: "scout", task: "Analyze auth module" });
subagent_spawn({ name: "Scout: DB", agent: "scout", task: "Map database schema" });
// Both return immediately, results steer back independently
```

## Tools & Commands

The extension adds 3 tools to the main session, 1 tool to subagents, and 3 slash commands:

| Tool               | Side  | Description                                                                           |
| ------------------ | ----- | ------------------------------------------------------------------------------------- |
| `subagent_spawn`   | main  | Spawn a sub-agent in a dedicated multiplexer pane (async — returns immediately)       |
| `subagent_message` | main  | Message a live subagent (typed into its pane) or resume an ended session (async)      |
| `subagent_close`   | main  | Close a running subagent's pane and finish its session (cleanup / runaway killer)     |
| `ask_question`     | child | Ask the parent orchestrator a question and wait for its reply (keeps the child alive) |

| Command                    | Description                          |
| -------------------------- | ------------------------------------ |
| `/plan`                    | Start a full planning workflow       |
| `/iterate`                 | Fork into a subagent for quick fixes |
| `/subagent <agent> <task>` | Spawn a named agent directly         |

Unknown agent names fail with the available catalog appended, so there is no separate listing tool.

## Bundled Agents

| Agent             | Role                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------- |
| **planner**       | Brainstorming — clarifies requirements, explores approaches, writes plans, creates todos |
| **scout**         | Fast codebase reconnaissance — maps files, patterns, conventions                         |
| **worker**        | Implements tasks from todos — writes code, runs tests, makes polished commits            |
| **reviewer**      | Reviews code for bugs, security issues, correctness                                      |
| **visual-tester** | Visual QA via Chrome CDP — screenshots, responsive testing, interaction testing          |
| **claude-code**   | Self-driving Claude CLI session for deep investigation, experimentation, and exploration |

Agent discovery follows priority: **project-local** (`.pi/agents/`) > **global** (`~/.pi/agent/agents/`) > **package-bundled**. Override any bundled agent by placing your own version in the higher-priority location.

## The Subagent Lifecycle

```
1. Parent calls subagent_spawn()  → returns immediately ("started")
2. Sub-agent runs in its pane     → widget shows live status
3. Sub-agent's turn ends          → session auto-exits, last assistant
                                    message is steered to the parent
4. Parent processes the result    → continues with new context
```

The final assistant message is the result — no `done` tool, no debounce, no idle lane. Behind the scenes the child extension writes a `.exit` sidecar when its turn ends; the parent's watcher picks it up within a second, extracts the closing message from the child's session file, closes the pane, and steers the result.

### Asking the parent (ask_question)

When a sub-agent hits a decision it cannot make alone, it calls:

```typescript
ask_question({
  message: "Found two conflicting migration files — should I use v1 or v2?",
});
```

The question is steered to the parent session immediately (rendered with a `?` badge), and the child **stays alive** with its turn ended. The parent answers by typing into the child's pane via `subagent_message` — the reply arrives as the child's next user message and the child continues, its next turn end delivering the final result as usual.

### Messaging a subagent

`subagent_message` is the single entry point for follow-ups, live or ended:

```typescript
// Live subagent — the message is typed into its pane, like a user typing.
// Works while the child is mid-run too (pi queues input); no busy-gating.
subagent_message({ name: "Scout", message: "Also check the auth middleware" });
subagent_message({ id: "abcd1234", message: "Focus on the failing test" });

// Ended session — resumes it in a new pane with the message as follow-up
// (fire-and-forget: the result arrives later as a steer message).
subagent_message({
  sessionFile: "/home/…/sessions/…/2026-…jsonl",
  message: "One more pass on the edge cases",
});
```

Messages sent by the parent are labeled `[parent]` in the child's pane, so the child (and you) can tell parent-orchestrator input from a human typing alongside it. Typing in the pane yourself is just another input: the child answers it, and the normal turn-end rule applies — it never takes the session over permanently.

When a live name matches multiple running subagents, the tool returns an ambiguity error listing the candidates.

### Closing a subagent

`subagent_close` is the cleanup hatch — for a stalled run, or any subagent that is no longer needed:

```typescript
subagent_close({ name: "Scout" });
subagent_close({ id: "abcd1234" });
```

It writes the exit signal, closes the pane, and the run's output so far is still delivered as the result. Interactive subagents are the exception: they are user-driven panes, so close one only when the user explicitly asks — never proactively just because it has been idle (interactive panes never wake the parent, so there is no idle signal to react to anyway).

### Status supervision

The widget tracks each Pi-backed sub-agent from a child-written activity snapshot:

- `starting` — launched, but no valid child snapshot has been observed yet
- `active` — the child is doing observed runtime work: agent turn, provider request, streaming, or tool execution
- `waiting` — the child finished a turn (answering an ask, or user-driven)
- `stalled` — the parent can no longer trust the run is healthy: either too long without a valid child snapshot, or a snapshot that stopped updating while the child claims to be working
- `running` — fallback for backends without child snapshots (e.g. Claude)

A fixed watchdog marks a run as `stalled` when valid snapshots never appear or stop matching the current child. A child that is mid-work also *heartbeats* its snapshot every 30s — so a snapshot whose updates stop for 90s while the phase is `active` means the child's event loop hung, and the run is flagged `stalled (frozen snapshot)`. The parent gets a steer message on `stalled`/`recovered` transitions so it can react (e.g. `subagent_close` a zombie). Interactive panes never wake the parent — not on transitions, not on idleness: the user is already in the pane, and only the user closes it.

The widget and stall steering can be disabled via [`config.json`](#status-display-configjson).

## Spawning Subagents

```typescript
// Named agent with defaults from agent definition
subagent_spawn({ name: "Scout", agent: "scout", task: "Analyze the codebase..." });

// Force a full-context fork for this spawn
subagent_spawn({ name: "Iterate", fork: true, task: "Fix the bug where..." });

// Agent defaults can choose an interactive session via frontmatter
subagent_spawn({ name: "Planner", agent: "planner", task: "Work through the design with me" });

// Custom working directory
subagent_spawn({ name: "Designer", agent: "game-designer", cwd: "agents/game-designer", task: "..." });
```

### Parameters

| Parameter         | Type    | Default  | Description                                                                                      |
| ----------------- | ------- | -------- | ------------------------------------------------------------------------------------------------ |
| `name`            | string  | required | Display name (shown in widget and pane title)                                                    |
| `task`            | string  | required | Task prompt for the sub-agent                                                                    |
| `agent`           | string  | —        | Load defaults from agent definition (unknown names fail with the available catalog)              |
| `fork`            | boolean | `false`  | Force the full-context fork mode for this spawn, overriding any agent `session-mode` frontmatter |
| `model`           | string  | —        | Override agent's default model                                                                   |
| `systemPrompt`    | string  | —        | Append to system prompt                                                                          |
| `skills`          | string  | —        | Comma-separated skill names                                                                      |
| `tools`           | string  | —        | Comma-separated tool names                                                                       |
| `cwd`             | string  | —        | Working directory for the sub-agent (see [Role Folders](#role-folders))                          |
| `resumeSessionId` | string  | —        | Resume a previous Claude Code session by its ID                                                  |

## Workflows

### `/plan` — planning to implementation

```
/plan Add a dark mode toggle to the settings page
```

| Phase |           | What happens                                 |
| ----- | --------- | -------------------------------------------- |
| 1     | Investigate | Quick codebase scan                        |
| 2     | Plan      | Interactive planner subagent (user collaborates) |
| 3     | Review    | Confirm todos, adjust if needed              |
| 4     | Execute   | Scout + sequential workers implement todos   |
| 5     | Review    | Reviewer subagent checks all changes         |

Tab/window titles update to show the current phase:

```
🔍 Investigating: dark mode → 💬 Planning: dark mode
→ 🔨 Executing: 1/3 → 🔎 Reviewing → ✅ Done
```

### `/iterate` — quick fixes in a fork

For quick, focused work without polluting the main session's context:

```
/iterate Fix the off-by-one error in the pagination logic
```

This always forks the current session into a subagent with full conversation context (it does not inherit an agent default `session-mode`). Make the fix, verify it, and exit to return. The main session gets a summary of what was done.

## Custom Agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global):

```markdown
---
name: my-agent
description: Does something specific
model: anthropic/claude-sonnet-4-6
thinking: minimal
tools: read, bash, edit, write
session-mode: lineage-only
spawning: false
---

# My Agent

You are a specialized agent that does X...
```

### Frontmatter Reference

#### Identity & discovery

| Field                      | Type    | Description                                                                                                                                             |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                     | string  | Agent name (used in `agent: "my-agent"`)                                                                                                                |
| `description`              | string  | Shown in the spawn error catalog                                                                                                                        |
| `disable-model-invocation` | boolean | Hide this agent from the spawn error catalog. The agent still remains directly invokable by explicit name via `subagent_spawn({ agent: "name", ... })`. |

#### Model & session behavior

| Field          | Type    | Description                                                                                              |
| -------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `model`        | string  | Default model (e.g. `anthropic/claude-sonnet-4-6`)                                                       |
| `thinking`     | string  | Thinking level: `minimal`, `medium`, `high`                                                              |
| `session-mode` | string  | Default child-session mode: `standalone`, `lineage-only`, or `fork` (see [`session-mode`](#session-mode)) |
| `interactive`  | boolean | Escape hatch for user-driven agents (see [`interactive`](#interactive))                                  |
| `system-prompt`| string  | How the agent body is delivered: `append` adds it to pi's default system prompt, `replace` uses it as the whole system prompt. Unset prepends the body to the task prompt. |
| `cli`          | string  | Run an external CLI (e.g. `claude`) as the sub-agent instead of pi                                       |
| `cwd`          | string  | Default working directory (absolute or relative to project root)                                         |

#### Tools & delegation

| Field        | Type    | Description                                                                                                              |
| ------------ | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `tools`      | string  | Comma-separated **native pi tools only**: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. `ask_question` is always added. |
| `skills`     | string  | Comma-separated skill names to auto-load (`skill` is accepted as an alias)                                              |
| `spawning`   | boolean | Set `false` to deny all subagent-spawning tools (`subagent_spawn`, `subagent_message`, `subagent_close`)                 |
| `deny-tools` | string  | Comma-separated extension tool names to deny                                                                             |

Discovery resolves precedence before visibility filtering: if a project-local hidden agent has the same name as a visible global or bundled agent, the hidden project agent wins and the lower-precedence agent does not appear in the catalog.

### `session-mode`

Choose how a subagent session starts:

- `standalone` — default fresh session with no lineage link to the caller
- `lineage-only` — fresh blank child session with `parentSession` linkage, but no copied turns from the caller
- `fork` — linked child session seeded with the caller's prior conversation context

`lineage-only` is useful when you want session discovery and fork lineage UX to show the relationship later, but you do **not** want the child to inherit the parent's turns.

`fork: true` on the tool call always forces the `fork` mode for that specific spawn — `/iterate` uses this explicit override on purpose.

```yaml
---
name: planner
session-mode: lineage-only
---
```

### `interactive`

The interactive escape hatch turns a spawn into a user-driven pane: no turn-end auto-exit, the user works in the pane directly (planner), and the session ends when the user closes it. The pane never wakes the parent — not on status transitions, not on idleness — so nothing ever nudges or closes it behind the user's back; only the user closes it (directly, or by asking the parent for `subagent_close`). Autonomous agents (scout, worker, reviewer…) cannot set it: declaring `interactive: true` together with `spawning: false` fails the spawn with a configuration error, instead of wedging a pane nobody would ever notice.

Resumed sessions (`subagent_message` with `sessionFile`) are always autonomous — the reply's turn end delivers the result and exits.

## Tool Access Control

By default, every sub-agent can spawn further sub-agents. Control this with frontmatter:

### `spawning: false`

Denies all subagent lifecycle tools (`subagent_spawn`, `subagent_message`, `subagent_close`):

```yaml
---
name: worker
spawning: false
---
```

### `deny-tools`

Fine-grained control over individual extension tools:

```yaml
---
name: focused-agent
deny-tools: subagent_spawn
---
```

### Recommended Configuration

| Agent          | `spawning`  | Rationale                                    |
| -------------- | ----------- | -------------------------------------------- |
| planner        | _(default)_ | Legitimately spawns scouts for investigation |
| worker         | `false`     | Should implement tasks, not delegate         |
| researcher     | `false`     | Should research, not spawn                   |
| reviewer       | `false`     | Should review, not spawn                     |
| scout          | `false`     | Should gather context, not spawn             |
| visual-tester  | `false`     | Should test UIs, not spawn                   |

## Role Folders

The `cwd` parameter lets sub-agents start in a specific directory with its own configuration:

```
project/
├── agents/
│   ├── game-designer/
│   │   └── CLAUDE.md          ← "You are a game designer..."
│   ├── sre/
│   │   ├── CLAUDE.md          ← "You are an SRE specialist..."
│   │   └── .pi/skills/        ← SRE-specific skills
│   └── narrative/
│       └── CLAUDE.md          ← "You are a narrative designer..."
```

```typescript
subagent_spawn({ name: "Game Designer", cwd: "agents/game-designer", task: "Design the combat system" });
subagent_spawn({ name: "SRE", cwd: "agents/sre", task: "Review deployment pipeline" });
```

Set a default `cwd` in agent frontmatter:

```yaml
---
name: game-designer
cwd: ./agents/game-designer
spawning: false
---
```

## Tools Widget

Every sub-agent session displays a compact tools widget showing available and denied tools. Toggle with `Ctrl+J`:

```
[scout] — 12 tools · 4 denied  (Ctrl+J to expand)
```

```
[scout] — 12 available  (Ctrl+J to collapse)
  read, bash, edit, write, todo, ...
  denied: subagent_spawn, subagent_message, ...
```

## Configuration

### Environment variables

| Variable                          | Default       | Description                                                                        |
| --------------------------------- | ------------- | ---------------------------------------------------------------------------------- |
| `PI_SUBAGENT_MUX`                 | auto-detect   | Force a backend: `cmux`, `tmux`, `zellij`, `wezterm`, or `herdr`                   |
| `PI_SUBAGENT_LAYOUT`              | `columns`     | Default pane layout for herdr & tmux: `columns` or `tiled`                         |
| `PI_SUBAGENT_HERDR_PARENT_RATIO`  | `0.4`         | Width share kept by the main agent's pane on herdr                                 |
| `PI_SUBAGENT_TMUX_PARENT_RATIO`   | `0.4`         | Width share kept by the main agent's pane on tmux                                  |
| `PI_SUBAGENT_SHELL_READY_DELAY_MS`| `500`         | Delay before sending commands to a fresh pane (raise if your shell startup is slow) |

### Status display (config.json)

Copy `config.json.example` in the extension directory to get started:

```bash
cp config.json.example config.json
```

```json
{
  "status": {
    "enabled": true
  }
}
```

- `status.enabled` — show the live status widget and steer `stalled`/`recovered` transitions.

The config is validated strictly: unknown keys fail extension startup with an actionable error instead of being silently ignored. Subagent nesting is capped at 3 levels — a sub-agent at the cap is told to do the work itself rather than spawn further panes.

### Pane layout & focus (herdr & tmux)

Two layouts control how subagent panes fill the space to the right of the main agent:

- **`columns`** (default) — every subagent gets a full-height column; new subagents split the rightmost subagent pane, and all columns are rebalanced to equal width whenever one spawns or closes.
- **`tiled`** — subagents fill a block grid (1×1 → 1×2 → 2×2 → 2×3 → 3×3 → 3×4 …). Each new subagent is carved out of the pane covering the next grid cell, and the grid is rebalanced so cells stay as equal as the layout allows.

Switch layouts with the **`/subagent-layout`** command: with no arguments it opens an interactive picker (current choice preselected, Esc cancels), or pass `columns` / `tiled` explicitly — both offer argument completion in the editor. The choice persists across restarts and applies to newly spawned subagents; existing panes keep their geometry until the next spawn or close. A persisted `/subagent-layout` choice wins over `PI_SUBAGENT_LAYOUT`.

**Shared tabs:** an agent group only claims its parent's own panel — the bounding region of the parent pane and its subagent panes. When the tab also holds unrelated panes (another agent, your own splits), subagents split inside that region and rebalancing never moves panes outside it, so a second agent keeps its pane size while the first one spawns. A solo parent's region is the whole tab, which behaves exactly as before.

Other pane behavior:

- Subagent panes are created without stealing keyboard focus (cmux, tmux, herdr). Launch commands target child surfaces by explicit ID, so focus and command delivery are independent.
- Each split is labeled with the subagent name; herdr detects the child agent and shows its live status.
- Because herdr's `pane read` cannot see the transcript of fullscreen (alt-screen) background panes, Pi-backed subagents on herdr launch with `--tui-mode regular` so their output stays readable for completion detection.

cmux, zellij, and WezTerm keep their own layout behavior regardless of these settings.

## Project structure

The extension is layered so each module has one reason to change. `index.ts` composes the extension; `tools/` is the interface layer (tool registration and parameter parsing) and delegates to use cases.

```text
pi-extension/subagents/
  index.ts            composition root — registers tools, commands, renderers
  tools/              one module per tool capability
    shared.ts           the "no multiplexer" result
    spawn.ts            subagent_spawn — guards, launch, started result
    message.ts          subagent_message — live delivery and resume
    close.ts            subagent_close
  launch/             spawn pipeline, split by layer
    schema.ts           typebox parameters
    policies.ts         pure domain rules (model fallback, depth, delivery)
    command-builder.ts  argv/env/system prompt for pi and claude
    spawn.ts            spawn use case
  resume.ts           resume use case
  targeting.ts        live-target matching and formatting
  lifecycle.ts        watch pipeline, supervision loop, close path
  delivery.ts         result/ask presentation to the parent
  ui/                 output paths
    widget.ts           status widget: borders, rows, refresh loop
    renderers.ts        subagent_result/status/ask message renderers
  status/             parent-side run status
    config.ts           config.json parsing
    snapshot.ts         observation -> snapshot state machine
    format.ts           status and transition lines
  activity/           child-written activity snapshots
    schema.ts           event/phase/scope vocabulary and snapshot shape
    read.ts             parent side: validate a snapshot
    recorder.ts         child side: throttled writes and heartbeat
  child.ts            extension loaded into the child session
    protocol.ts         pure turn-end contract
  agents.ts           agent definitions (frontmatter, discovery)
  session.ts          session seeding and summary extraction
  exit-poll.ts        .exit/.ask sidecars and the screen sentinel
  sanitize.ts         text guards for child-controlled output
  state.ts            reload-surviving store + running-subagent registry
  mux/                multiplexer backends behind one normalized API
    api.ts              per-backend dispatch
    layout-grid.ts      shared grid/region geometry
    layout-mode.ts      columns vs tiled
    tracked-panes.ts    per-backend subagent pane list
    <backend>.ts        cmux, zellij, wezterm
    herdr|tmux/         layout.ts (pure planning) + ops.ts (pane ops)
  format.ts files.ts random.ts guards.ts shell.ts   shared primitives
```

`npm run check` is the gate CI runs: format check, lint, typecheck, unit tests. `npm run test:integration` additionally exercises real pane lifecycles and needs a supported multiplexer.

## Acknowledgements

- Forked from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) — thanks to [@HazAT](https://github.com/HazAT) for the original work.

## License

[MIT](LICENSE)
