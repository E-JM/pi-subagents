// The resume use case: reopen an ended session in a new pane with a parent
// message as follow-up.
import { mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getSubagentActivityFile } from "./activity/schema.ts";
import { deliverWatchResult, exitSummaryFallback } from "./delivery.ts";
import {
  fileTimestamp,
  getArtifactDir,
  safeFileName,
  writeArtifactFile,
} from "./files.ts";
import {
  buildPiInvocation,
  buildSubagentEnvPrefix,
  sendLaunchScript,
} from "./launch/command-builder.ts";
import {
  composeSystemPromptParts,
  currentSubagentDepth,
  resolveTaskDelivery,
} from "./launch/policies.ts";
import { createRunningSubagent } from "./launch/spawn.ts";
import { startWatchPipeline } from "./lifecycle.ts";
import { createSurface } from "./mux/api.ts";
import { randomHex } from "./random.ts";
import { err, ok, type Result } from "./result.ts";
import { sanitizeArtifactMessage } from "./sanitize.ts";
import { findLastAssistantMessage, getNewEntries } from "./session.ts";
import { getShellReadyDelayMs, shellEscape } from "./shell.ts";
import { type RunningSubagent, registry } from "./state.ts";

/** Structural slice of the extension context the resume launch needs. */
interface ResumeContext {
  sessionManager: {
    getSessionId(): string;
    getSessionDir(): string;
  };
}

/**
 * argv for a resume launch: the [parent]-labeled message rides as a direct
 * positional arg when it safely can (same rule as spawn), with the artifact
 * channel as fallback. The lifecycle contract always rides
 * --append-system-prompt, because a resumed launch is a fresh pi process whose
 * system prompt is derived per launch.
 */
export function buildResumeEscapedArgs(params: {
  message: string;
  artifactDir: string;
  name: string;
  interactive: boolean;
}): {
  escapedArgs: string[];
  wrapperFile: string;
  messageArtifactFile: string | null;
} {
  const wrapperFile = join(
    params.artifactDir,
    "subagent-resume",
    `${safeFileName(params.name, "resume")}-wrapper-${fileTimestamp()}.md`,
  );
  writeArtifactFile(
    wrapperFile,
    composeSystemPromptParts({
      identity: null,
      interactive: params.interactive,
    }).append,
  );

  if (resolveTaskDelivery(params.message) === "direct") {
    return {
      escapedArgs: [
        "--append-system-prompt",
        shellEscape(wrapperFile),
        shellEscape(params.message),
      ],
      wrapperFile,
      messageArtifactFile: null,
    };
  }
  const messageArtifactFile = join(
    params.artifactDir,
    "subagent-resume",
    `${safeFileName(params.name, "resume")}-${fileTimestamp()}.md`,
  );
  writeArtifactFile(messageArtifactFile, params.message);
  return {
    escapedArgs: [
      "--append-system-prompt",
      shellEscape(wrapperFile),
      shellEscape(`@${messageArtifactFile}`),
    ],
    wrapperFile,
    messageArtifactFile,
  };
}

/** What the caller shows the model when a session cannot be claimed. */
interface ResumeClaimRefusal {
  text: string;
  details: Record<string, unknown>;
}

type ResumeClaim = Result<{ release: () => void }, ResumeClaimRefusal>;

/**
 * One watcher per session file: a second resume would race the first on the
 * sidecars and the transcript. Claimed synchronously, because the launch below
 * awaits and parallel calls would otherwise both pass the registry scan.
 * `release()` must run in a finally block.
 */
export function claimResumeSession(sessionPath: string): ResumeClaim {
  const existingWatcher = registry
    .all()
    .find((candidate) => candidate.sessionFile === sessionPath);
  if (existingWatcher) {
    return err({
      text:
        `Session ${sessionPath} is already live as "${existingWatcher.name}" [${existingWatcher.id}]. ` +
        `Message that instance instead of resuming it again.`,
      details: {
        error: "already live",
        id: existingWatcher.id,
        name: existingWatcher.name,
      },
    });
  }
  if (!registry.tryClaimResume(sessionPath)) {
    return err({
      text:
        `Session ${sessionPath} is already being resumed by another call in flight. ` +
        `Message that instance once it starts instead of resuming it again.`,
      details: { error: "already live", sessionFile: sessionPath },
    });
  }
  return ok({
    release: () => {
      registry.releaseResumeClaim(sessionPath);
    },
  });
}

/**
 * Launch a resumed session: create the pane, build the invocation with the
 * lifecycle wrapper, clear stale sidecars, and start the watcher.
 */
export async function launchResumedSession(opts: {
  pi: ExtensionAPI;
  ctx: ResumeContext;
  sessionPath: string;
  name: string;
  message: string;
  interactive: boolean;
}): Promise<{
  id: string;
  running: RunningSubagent;
  launchScriptFile: string;
}> {
  const { pi, ctx, sessionPath, name, interactive } = opts;
  const startTime = Date.now();
  const id = randomHex(8);

  // Entry count before resuming, so we can extract only the new messages.
  const entryCountBefore = getNewEntries(sessionPath, 0).length;

  const surface = createSurface(name);
  // Let the new pane's shell come up before sending the command.
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

  // Same [parent] label as a spawned task: sanitizing only trims, caps, and
  // neutralizes the sentinel — it never collapses formatting.
  const { escapedArgs, messageArtifactFile: resumeMsgFile } =
    buildResumeEscapedArgs({
      message: sanitizeArtifactMessage(`[parent] ${opts.message}`),
      artifactDir,
      name,
      interactive,
    });

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
    escapedArgs,
  });

  const launchScriptFile = sendLaunchScript(surface, command, {
    artifactDir,
    fileBase: `${safeFileName(name, "resume")}-resume-${Date.now()}`,
    preambleLines: [
      `# Subagent resume script for ${name}`,
      `# Generated: ${new Date().toISOString()}`,
      `# Session: ${sessionPath}`,
      `# Surface: ${surface}`,
      ...(resumeMsgFile ? [`# Message file: ${resumeMsgFile}`] : []),
    ],
  });

  const running = createRunningSubagent({
    id,
    name,
    task: opts.message,
    surface,
    startTime,
    sessionFile: sessionPath,
    launchScriptFile,
    activityFile,
    interactive,
    source: "pi",
  });
  registry.register(running);

  // Clear stale sidecars: a leftover .ask would re-deliver a ghost question, a
  // leftover .exit would fake instant completion.
  try {
    unlinkSync(`${sessionPath}.exit`);
  } catch {
    // Nothing to clear.
  }
  try {
    unlinkSync(`${sessionPath}.ask`);
  } catch {
    // Nothing to clear.
  }

  startWatchPipeline(pi, running, (result) => {
    // The watcher only saw the session's pre-existing content, so re-extract
    // the summary from entries added since the resume.
    const allEntries = getNewEntries(sessionPath, entryCountBefore);
    const summary =
      findLastAssistantMessage(allEntries) ??
      exitSummaryFallback(result, "Resumed session", "new output");
    deliverWatchResult(pi, running, result, { summary });
  });

  return { id, running, launchScriptFile };
}
