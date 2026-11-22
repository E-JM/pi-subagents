import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { errorMessage } from "../format.ts";
import {
  currentSubagentDepth,
  MAX_SUBAGENT_DEPTH,
  resolveResumeLaunchBehavior,
} from "../launch/policies.ts";
import { sendCommand } from "../mux/api.ts";
import { isMuxAvailable } from "../mux/backend.ts";
import { claimResumeSession, launchResumedSession } from "../resume.ts";
import { sanitizeInjectedMessage } from "../sanitize.ts";
import { formatRunningSubagents, matchLiveTarget } from "../targeting.ts";
import {
  detailsOf,
  renderResultFallback,
  targetCallText,
} from "../ui/renderers.ts";
import { muxUnavailableResult, textResult } from "./shared.ts";

const SUBAGENT_MESSAGE_DESCRIPTION =
  "Send a message to a sub-agent. If it is live (match by name or id), the " +
  "message is typed into its pane and the sub-agent replies from its own turn — " +
  "pane stays alive. If the session has ended, pass sessionFile to resume it " +
  "in a new pane with the message as follow-up. Fire-and-forget: returns " +
  "immediately; results arrive later as automatic steer messages. Never poll " +
  "or assume results — end your turn or do other independent work.";

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
        // Live target: type into its pane — pi queues input while the child runs.
        // No match falls through to the resume path below.
        const match = matchLiveTarget(params.id, params.name);
        if (match.kind === "ambiguous") {
          return textResult(match.message, {
            error: "ambiguous name",
            name: params.name?.trim(),
          });
        }
        if (match.kind === "live") {
          const { running: live, matchedBy } = match;
          // [parent] lets the child tell parent input from a human typing alongside.
          const sanitized = sanitizeInjectedMessage(
            `[parent] ${params.message}`,
          );
          try {
            sendCommand(live.surface, sanitized);
          } catch (error) {
            const text = `Failed to deliver message to subagent "${live.name}": ${errorMessage(error)}`;
            return textResult(text, {
              error: text,
              id: live.id,
              name: live.name,
            });
          }
          return textResult(
            `Message delivered to live subagent "${live.name}" (pane ${live.surface}).` +
              (matchedBy === "name" && params.id?.trim()
                ? ` Note: id "${params.id.trim()}" matched no live subagent — resolved by name instead.`
                : ""),
            { status: "delivered_live", id: live.id, name: live.name },
          );
        }

        // Not live: a sessionFile is required to reopen the session in a new pane.
        if (!params.sessionFile) {
          const text =
            "No live subagent matched. To message a RUNNING subagent, pass its id or exact display name. " +
            "To resume an ENDED subagent session, pass sessionFile (found in the result steer message details / the `Session:` line)." +
            `\n\n${formatRunningSubagents()}`;
          return textResult(text, { error: "no target" });
        }

        // A resumed session still counts toward the nesting depth cap.
        if (currentSubagentDepth() >= MAX_SUBAGENT_DEPTH) {
          return textResult(
            `Subagent nesting is capped at ${MAX_SUBAGENT_DEPTH} levels and you are at the limit. ` +
              `Do the work yourself instead of resuming another sub-agent session.`,
            { error: "depth limit", depth: currentSubagentDepth() },
          );
        }

        const sessionPath = params.sessionFile;
        const name = params.name ?? "Resume";
        const { interactive } = resolveResumeLaunchBehavior();

        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        if (!existsSync(sessionPath)) {
          return textResult(`Error: session file not found: ${sessionPath}`, {
            error: "session not found",
            sessionFile: sessionPath,
          });
        }

        const claim = claimResumeSession(sessionPath);
        if (!claim.ok) {
          return textResult(claim.error.text, claim.error.details);
        }

        try {
          const resume = await launchResumedSession({
            pi,
            ctx,
            sessionPath,
            name,
            message: params.message,
            interactive,
          });

          return textResult(`Session "${name}" resumed with the message.`, {
            id: resume.id,
            name,
            sessionFile: sessionPath,
            launchScriptFile: resume.launchScriptFile,
            status: "started",
          });
        } finally {
          claim.value.release();
        }
      },
    });
}
