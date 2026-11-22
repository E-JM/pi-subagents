// Subagent targeting: resolve id/name references to live runs, and render the
// catalogs used in tool error context.
import { discoverAgentDefinitions } from "./agents.ts";
import { err, ok, type Result } from "./result.ts";
import { type RunningSubagent, registry } from "./state.ts";

/**
 * A live subagent matched by id or by exact display name. Three outcomes, not
 * two: a miss is not an error for the message path (it falls through to a
 * resume) but is one for close, so the caller decides. A dead id does not block
 * the name unless `requireIdMatch` is set (irreversible actions).
 */
export type LiveTargetMatch =
  | { kind: "live"; running: RunningSubagent; matchedBy: "id" | "name" }
  | { kind: "none" }
  | { kind: "ambiguous"; message: string };

export function matchLiveTarget(
  id?: string,
  name?: string,
  options?: { requireIdMatch?: boolean },
): LiveTargetMatch {
  const requestedId = id?.trim();
  if (requestedId) {
    const exact = registry.get(requestedId);
    if (exact) return { kind: "live", running: exact, matchedBy: "id" };
    // Closing a pane is irreversible: a dead id plus a matching name must error
    // instead of acting on the wrong run.
    if (options?.requireIdMatch) return { kind: "none" };
  }

  const requestedName = name?.trim();
  if (!requestedName) return { kind: "none" };

  const matches = registry
    .all()
    .filter((candidate) => candidate.name === requestedName);
  if (matches.length === 0) return { kind: "none" };
  const [only] = matches;
  if (matches.length === 1 && only) {
    return { kind: "live", running: only, matchedBy: "name" };
  }

  const candidates = matches
    .map((candidate) => `${candidate.name} [${candidate.id}]`)
    .join(", ");
  return {
    kind: "ambiguous",
    message: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}`,
  };
}

/** Close-style resolution: the target must exist, so a miss is an error. */
export function resolveRunningTarget(params: {
  id?: string;
  name?: string;
}): Result<{ running: RunningSubagent; matchedBy: "id" | "name" }, string> {
  const requestedId = params.id?.trim();
  const requestedName = params.name?.trim();
  if (!requestedId && !requestedName) {
    return err("Provide a running subagent id or exact display name.");
  }

  const match = matchLiveTarget(requestedId, requestedName, {
    requireIdMatch: true,
  });
  if (match.kind === "ambiguous") return err(match.message);
  if (match.kind === "live")
    return ok({ running: match.running, matchedBy: match.matchedBy });

  return err(
    requestedId
      ? `No running subagent with id "${requestedId}".`
      : `No running subagent named "${requestedName}".`,
  );
}

/** One-line summary of currently running subagents, for tool error results. */
export function formatRunningSubagents(): string {
  const entries = registry.all();
  if (entries.length === 0) return "No subagents are currently running.";
  return entries
    .map((running) => {
      const cliTag = running.cli === "claude" ? " (claude)" : "";
      return `• ${running.name} [${running.id}]${cliTag}`;
    })
    .join("\n");
}

/**
 * The agent catalog as compact text, appended to unknown-agent errors so the
 * model never needs a listing round-trip.
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
