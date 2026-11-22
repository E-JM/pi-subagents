// The three subagent tools (spawn / message / close): target resolution,
// agent-catalog formatting, and registration.
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getSubagentActivityFile } from "./activity.ts";
import { discoverAgentDefinitions, loadAgentDefaults } from "./agents.ts";
import {
  createSurface,
  isMuxAvailable,
  sendCommand,
  shellEscape,
} from "./cmux.ts";
import {
  buildPiInvocation,
  buildSubagentEnvPrefix,
  createRunningSubagent,
  currentSubagentDepth,
  launchSubagent,
  MAX_SUBAGENT_DEPTH,
  resolveResumeLaunchBehavior,
  sendLaunchScript,
  SubagentSpawnParams,
} from "./launch.ts";
import {
  claimedResumeSessions,
  runningSubagents,
  type RunningSubagent,
} from "./state.ts";
import {
  closeRunningSubagent,
  deliverWatchResult,
  exitSummaryFallback,
  sanitizeArtifactMessage,
  sanitizeInjectedMessage,
  startWatchPipeline,
} from "./supervise.ts";
import {
  detailsOf,
  renderResultFallback,
  renderTargetCall,
  targetCallText,
} from "./ui.ts";
import {
  errorMessage,
  getArtifactDir,
  getShellReadyDelayMs,
  muxUnavailableResult,
  randomHex,
  safeFileName,
  fileTimestamp,
} from "./util.ts";
import { findLastAssistantMessage, getNewEntries } from "./session.ts";

/**
 * Match a live subagent by id or exact display name — no no-match error:
 * the subagent_message resume path falls through to a resume when nothing
 * matches. `ambiguous` carries the ready-to-use ambiguity error text.
 * A non-matching id (stale pre-resume id, typo) does not block the name
 * unless `requireIdMatch` is set (for irreversible actions): the match
 * falls through and `matchedBy` reports which field won.
 */
export function matchLiveTarget(
  id?: string,
  name?: string,
  options?: { requireIdMatch?: boolean },
):
  | { running: RunningSubagent | null; matchedBy?: "id" | "name" }
  | { ambiguous: string } {
  const requestedId = id?.trim();
  if (requestedId) {
    const exact = runningSubagents.get(requestedId);
    if (exact) return { running: exact, matchedBy: "id" };
    // Closing a pane is irreversible: a dead id plus a coincidentally
    // matching name must error instead of acting on the wrong run.
    if (options?.requireIdMatch) return { running: null };
  }

  const requestedName = name?.trim();
  if (!requestedName) return { running: null };

  const matches = Array.from(runningSubagents.values()).filter(
    (candidate) => candidate.name === requestedName,
  );
  if (matches.length === 1) return { running: matches[0], matchedBy: "name" };
  if (matches.length === 0) return { running: null };

  const candidates = matches
    .map((candidate) => `${candidate.name} [${candidate.id}]`)
    .join(", ");
  return {
    ambiguous: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}`,
  };
}

export function resolveRunningTarget(params: {
  id?: string;
  name?: string;
}):
  | { running: RunningSubagent; matchedBy?: "id" | "name" }
  | { error: string } {
  const requestedId = params.id?.trim();
  const requestedName = params.name?.trim();
  if (!requestedId && !requestedName) {
    return { error: "Provide a running subagent id or exact display name." };
  }

  const match = matchLiveTarget(requestedId, requestedName, {
    requireIdMatch: true,
  });
  if ("ambiguous" in match) return { error: match.ambiguous };
  if (match.running)
    return { running: match.running, matchedBy: match.matchedBy };

  return requestedId
    ? { error: `No running subagent with id "${requestedId}".` }
    : { error: `No running subagent named "${requestedName}".` };
}

/** One-line summary of currently running subagents, for tool error results. */
export function formatRunningSubagents(): string {
  const entries = Array.from(runningSubagents.values());
  if (entries.length === 0) return "No subagents are currently running.";
  return entries
    .map((running) => {
      const cliTag = running.cli === "claude" ? " (claude)" : "";
      return `• ${running.name} [${running.id}]${cliTag}`;
    })
    .join("\n");
}

/**
 * The available agent catalog as compact text — the error-context replacement
 * for the removed subagents_list tool: unknown agent names fail with this
 * appended, so the model never needs a listing round-trip.
 */
export function formatAvailableAgents(): string {
  const list = discoverAgentDefinitions().filter(
    (agent) => !agent.disableModelInvocation,
  );
  if (list.length === 0) return "No agent definitions are available.";
  return list
    .map((agent) => {
      const badge = agent.source === "project" ? " (project)" : "";
      const desc = agent.description ? ` — ${agent.description}` : "";
      const model = agent.model ? ` [${agent.model}]` : "";
      return `• ${agent.name}${badge}${model}${desc}`;
    })
    .join("\n");
}

// Tool descriptions, shared verbatim between `description` (tooltip) and
// `promptSnippet` (system prompt) so the two never drift apart. Kept short:
// they are injected into every session's prompt.
const SUBAGENT_SPAWN_DESCRIPTION =
  "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
  "Fire-and-forget: returns immediately with only an acknowledgement; the result " +
  "arrives later as an automatic steer message that starts a new turn. " +
  "Never poll, sleep/wait, or assume/fabricate results — the harness handles delivery. " +
  "After spawning, end your turn or do other independent work (parallel spawns are fine). " +
  "The sub-agent's turn end is its completion: its closing message is returned to you automatically.";

const SUBAGENT_MESSAGE_DESCRIPTION =
  "Send a message to a sub-agent. If it is live (match by name or id), the " +
  "message is typed into its pane and the sub-agent replies from its own turn — " +
  "pane stays alive. If the session has ended, pass sessionFile to resume it " +
  "in a new pane with the message as follow-up. Fire-and-forget: returns " +
  "immediately; results arrive later as automatic steer messages. Never poll " +
  "or assume results — end your turn or do other independent work.";

const SUBAGENT_CLOSE_DESCRIPTION =
  "Close a running subagent's pane and finish its session. Use for cleanup " +
  "when a subagent is stalled or no longer needed — any output produced so " +
  "far still arrives as an automatic steer message. Interactive subagents " +
  "are user-driven panes: close one only when the user explicitly asks, " +
  "never on your own initiative.";

export function registerSubagentSpawnTool(
  pi: ExtensionAPI,
  shouldRegister: (name: string) => boolean,
): void {
  if (shouldRegister("subagent_spawn"))
    pi.registerTool({
      name: "subagent_spawn",
      label: "Spawn Subagent",
      description: SUBAGENT_SPAWN_DESCRIPTION,
      promptSnippet: SUBAGENT_SPAWN_DESCRIPTION,
      parameters: SubagentSpawnParams,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        // Prevent self-spawning (e.g. planner spawning another planner)
        const currentAgent = process.env.PI_SUBAGENT_AGENT;
        if (params.agent && currentAgent && params.agent === currentAgent) {
          return {
            content: [
              {
                type: "text",
                text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          };
        }

        // Depth cap: the self-spawn guard above only catches same-agent
        // recursion — spawning without an agent name would otherwise nest
        // panes without limit.
        if (currentSubagentDepth() >= MAX_SUBAGENT_DEPTH) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Subagent nesting is capped at ${MAX_SUBAGENT_DEPTH} levels and you are at the limit. ` +
                  `Do the work yourself instead of spawning another sub-agent.`,
              },
            ],
            details: {
              error: "depth limit",
              depth: currentSubagentDepth(),
            },
          };
        }

        if (params.agent && !loadAgentDefaults(params.agent)) {
          const text = `Unknown agent "${params.agent}". Available agents:\n${formatAvailableAgents()}`;
          return {
            content: [{ type: "text", text }],
            details: { error: "unknown agent", agent: params.agent },
          };
        }

        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return {
            content: [
              {
                type: "text",
                text: "Error: no session file. Start pi with a persistent session to use subagents.",
              },
            ],
            details: { error: "no session file" },
          };
        }

        const running = await launchSubagent(params, ctx);

        // Fire-and-forget: the watcher's .then() steers the result later.
        startWatchPipeline(pi, running);
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${params.name}" launched and is now running in the background. ` +
                `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
                `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
                `Until then, move on to other work or tell the user you're waiting.` +
                (running.modelWarning ? `\n\n⚠️ ${running.modelWarning}` : ""),
            },
          ],
          details: {
            id: running.id,
            name: params.name,
            task: params.task,
            agent: params.agent,
            sessionFile: running.sessionFile,
            launchScriptFile: running.launchScriptFile,
            status: "started",
            ...(running.modelWarning
              ? { modelWarning: running.modelWarning }
              : {}),
          },
        };
      },

      renderCall(args, theme) {
        const partialArgs = args as Record<string, unknown>;
        const name =
          typeof partialArgs.name === "string" && partialArgs.name
            ? partialArgs.name
            : "(unnamed)";
        const task =
          typeof partialArgs.task === "string" ? partialArgs.task : "";
        const agent =
          typeof partialArgs.agent === "string" && partialArgs.agent
            ? theme.fg("dim", ` (${partialArgs.agent})`)
            : "";
        const cwdHint =
          typeof partialArgs.cwd === "string" && partialArgs.cwd
            ? theme.fg("dim", ` in ${partialArgs.cwd}`)
            : "";
        let text = `▸ ${theme.fg("toolTitle", theme.bold(name))}${agent}${cwdHint}`;

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        if (task) {
          const firstLine =
            task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview =
            firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
          if (preview) {
            text += `\n${theme.fg("toolOutput", preview)}`;
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = detailsOf(result.details);
        const name = details.name ?? "(unnamed)";

        if (details.status === "started") {
          return targetCallText(name, theme, "started");
        }

        return renderResultFallback(result, theme);
      },
    });
}

export function registerSubagentMessageTool(
  pi: ExtensionAPI,
  shouldRegister: (name: string) => boolean,
): void {
  if (shouldRegister("subagent_message"))
    pi.registerTool({
      name: "subagent_message",
      label: "Message Subagent",
      description: SUBAGENT_MESSAGE_DESCRIPTION,
      promptSnippet: SUBAGENT_MESSAGE_DESCRIPTION,
      parameters: Type.Object({
        name: Type.Optional(
          Type.String({
            description:
              "Display name of a live subagent (also used as tab label on resume)",
          }),
        ),
        id: Type.Optional(
          Type.String({
            description: "Live subagent id (from spawn tool result details)",
          }),
        ),
        sessionFile: Type.Optional(
          Type.String({
            description:
              "Session .jsonl path. REQUIRED when the target is not live — resumes that session in a new pane. Found in the result steer message details / the `Session:` line.",
          }),
        ),
        message: Type.String({
          description: "The message to deliver to the sub-agent",
        }),
      }),

      renderCall(args, theme) {
        const target =
          args.name ?? args.id ?? (args.sessionFile ? "Resume" : "(unknown)");
        return targetCallText(target, theme, "message");
      },

      renderResult(result, _opts, theme) {
        const details = detailsOf(result.details);
        const name = details.name ?? "subagent";

        if (details.status === "delivered_live") {
          return targetCallText(name, theme, "message delivered");
        }

        if (details.status === "started") {
          return targetCallText(name, theme, "resumed");
        }

        return renderResultFallback(result, theme);
      },

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        // LIVE path: id or name matches a running subagent — type the message
        // into its pane. pi queues typed input while the child is running,
        // exactly like a user typing, so there is no busy-gating on phase.
        // No match falls through to the resume path below.
        const match = matchLiveTarget(params.id, params.name);
        if ("ambiguous" in match) {
          return {
            content: [{ type: "text", text: match.ambiguous }],
            details: {
              error: "ambiguous name",
              name: params.name?.trim(),
            },
          };
        }
        const live = match.running;

        if (live) {
          // The [parent] prefix labels parent-orchestrator messages in the
          // child's pane and transcript, so the child can tell parent input
          // from a human typing alongside it.
          const sanitized = sanitizeInjectedMessage(
            `[parent] ${params.message}`,
          );
          try {
            sendCommand(live.surface, sanitized);
          } catch (error) {
            const text = `Failed to deliver message to subagent "${live.name}": ${errorMessage(error)}`;
            return {
              content: [{ type: "text", text }],
              details: { error: text, id: live.id, name: live.name },
            };
          }
          return {
            content: [
              {
                type: "text",
                text:
                  `Message delivered to live subagent "${live.name}" (pane ${live.surface}).` +
                  (match.matchedBy === "name" && params.id?.trim()
                    ? ` Note: id "${params.id.trim()}" matched no live subagent — resolved by name instead.`
                    : ""),
              },
            ],
            details: {
              status: "delivered_live",
              id: live.id,
              name: live.name,
            },
          };
        }

        // RESUME path: the target is not live. A sessionFile is required to
        // reopen an ended session in a new pane with the message as follow-up.
        if (!params.sessionFile) {
          const text =
            "No live subagent matched. To message a RUNNING subagent, pass its id or exact display name. " +
            "To resume an ENDED subagent session, pass sessionFile (found in the result steer message details / the `Session:` line)." +
            `\n\n${formatRunningSubagents()}`;
          return {
            content: [{ type: "text", text }],
            details: { error: "no target" },
          };
        }

        // A resumed session is a nested child too — the spawn depth cap
        // applies equally.
        if (currentSubagentDepth() >= MAX_SUBAGENT_DEPTH) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Subagent nesting is capped at ${MAX_SUBAGENT_DEPTH} levels and you are at the limit. ` +
                  `Do the work yourself instead of resuming another sub-agent session.`,
              },
            ],
            details: {
              error: "depth limit",
              depth: currentSubagentDepth(),
            },
          };
        }

        const sessionPath = params.sessionFile;
        const name = params.name ?? "Resume";
        const { interactive } = resolveResumeLaunchBehavior();
        const startTime = Date.now();
        const id = randomHex(8);

        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        if (!existsSync(sessionPath)) {
          return {
            content: [
              {
                type: "text",
                text: `Error: session file not found: ${sessionPath}`,
              },
            ],
            details: { error: "session not found", sessionFile: sessionPath },
          };
        }

        // One watcher per session file: a second resume of the same session
        // would race the first on the .ask/.exit sidecars and the transcript.
        // The claim is taken synchronously — the launch below awaits, and
        // parallel tool calls would otherwise both pass the registry scan.
        const existingWatcher = Array.from(runningSubagents.values()).find(
          (candidate) => candidate.sessionFile === sessionPath,
        );
        if (existingWatcher) {
          const text =
            `Session ${sessionPath} is already live as "${existingWatcher.name}" [${existingWatcher.id}]. ` +
            `Message that instance instead of resuming it again.`;
          return {
            content: [{ type: "text", text }],
            details: {
              error: "already live",
              id: existingWatcher.id,
              name: existingWatcher.name,
            },
          };
        }
        if (claimedResumeSessions.has(sessionPath)) {
          const text =
            `Session ${sessionPath} is already being resumed by another call in flight. ` +
            `Message that instance once it starts instead of resuming it again.`;
          return {
            content: [{ type: "text", text }],
            details: { error: "already live", sessionFile: sessionPath },
          };
        }
        claimedResumeSessions.add(sessionPath);

        let launchScriptFile: string | undefined;
        try {
          // Record entry count before resuming so we can extract new messages
          const entryCountBefore = getNewEntries(sessionPath, 0).length;

          const surface = createSurface(name);
          await new Promise<void>((resolve) =>
            setTimeout(resolve, getShellReadyDelayMs()),
          );

          const sessionId = ctx.sessionManager.getSessionId();
          const artifactDir = getArtifactDir(
            ctx.sessionManager.getSessionDir(),
            sessionId,
          );
          const activityFile = getSubagentActivityFile(artifactDir, id);
          mkdirSync(dirname(activityFile), { recursive: true });

          const resumeMsgFile = join(
            artifactDir,
            "subagent-resume",
            `${safeFileName(name, "resume")}-${fileTimestamp()}.md`,
          );
          mkdirSync(dirname(resumeMsgFile), { recursive: true });
          // The resume message carries the same [parent] label and goes
          // through the artifact channel, which tolerates newlines — only
          // trim/cap/sentinel-neutralize, never collapse formatting.
          writeFileSync(
            resumeMsgFile,
            sanitizeArtifactMessage(`[parent] ${params.message}`),
            "utf8",
          );

          const command = buildPiInvocation({
            sessionFile: sessionPath,
            envPrefix: buildSubagentEnvPrefix({
              name,
              sessionFile: sessionPath,
              id,
              activityFile,
              interactive,
              agentConfigDir: process.env.PI_CODING_AGENT_DIR,
              depth: currentSubagentDepth() + 1,
            }),
            escapedArgs: [shellEscape(`@${resumeMsgFile}`)],
          });

          launchScriptFile = sendLaunchScript(surface, command, {
            artifactDir,
            fileBase: `${safeFileName(name, "resume")}-resume-${Date.now()}`,
            preambleLines: [
              `# Subagent resume script for ${name}`,
              `# Generated: ${new Date().toISOString()}`,
              `# Session: ${sessionPath}`,
              `# Surface: ${surface}`,
              `# Message file: ${resumeMsgFile}`,
            ],
          });

          const running = createRunningSubagent({
            id,
            name,
            task: params.message,
            surface,
            startTime,
            sessionFile: sessionPath,
            launchScriptFile,
            activityFile,
            interactive,
            source: "pi",
          });
          runningSubagents.set(id, running);

          // Stale sidecars from the previous run must never leak into this
          // resume: a leftover .ask would re-deliver a ghost question, a
          // leftover .exit would fake instant completion. The resumed child
          // writes its own fresh sidecars.
          try {
            unlinkSync(`${sessionPath}.exit`);
          } catch {}
          try {
            unlinkSync(`${sessionPath}.ask`);
          } catch {}

          startWatchPipeline(pi, running, (result) => {
            // Re-extract the summary from entries added since the resume —
            // the watcher only saw the session's pre-existing content.
            const allEntries = getNewEntries(sessionPath, entryCountBefore);
            const summary =
              findLastAssistantMessage(allEntries) ??
              exitSummaryFallback(result, "Resumed session", "new output");
            deliverWatchResult(pi, running, result, { summary });
          });
        } finally {
          claimedResumeSessions.delete(sessionPath);
        }

        return {
          content: [
            {
              type: "text",
              text: `Session "${name}" resumed with the message.`,
            },
          ],
          details: {
            id,
            name,
            sessionFile: sessionPath,
            ...(launchScriptFile ? { launchScriptFile } : {}),
            status: "started",
          },
        };
      },
    });
}

export function registerSubagentCloseTool(
  pi: ExtensionAPI,
  shouldRegister: (name: string) => boolean,
): void {
  if (shouldRegister("subagent_close"))
    pi.registerTool({
      name: "subagent_close",
      label: "Close Subagent",
      description: SUBAGENT_CLOSE_DESCRIPTION,
      promptSnippet: SUBAGENT_CLOSE_DESCRIPTION,
      parameters: Type.Object({
        id: Type.Optional(
          Type.String({ description: "Exact running subagent id" }),
        ),
        name: Type.Optional(
          Type.String({ description: "Exact running subagent display name" }),
        ),
      }),

      async execute(_toolCallId, params) {
        const resolved = resolveRunningTarget(params);
        if ("error" in resolved) {
          const text = `${resolved.error}\n\n${formatRunningSubagents()}`;
          return {
            content: [{ type: "text", text }],
            details: { error: resolved.error },
          };
        }

        const running = resolved.running;
        closeRunningSubagent(running, "closed-by-parent");

        return {
          content: [
            {
              type: "text",
              text:
                `Closing subagent "${running.name}".` +
                (resolved.matchedBy === "name" && params.id?.trim()
                  ? ` Note: id "${params.id.trim()}" matched no live subagent — resolved by name instead.`
                  : ""),
            },
          ],
          details: { status: "closing", id: running.id, name: running.name },
        };
      },

      renderCall(args, theme) {
        return renderTargetCall(args, theme, "close");
      },

      renderResult(result, _opts, theme) {
        const details = detailsOf(result.details);
        if (details.status === "closing") {
          return targetCallText(
            details.name ?? details.id ?? "subagent",
            theme,
            "closing",
          );
        }

        return renderResultFallback(result, theme);
      },
    });
}
