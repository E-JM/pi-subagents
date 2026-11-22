// Text sanitization for every message that reaches a child pane or a parent
// screen: values are trimmed, capped, and the screen sentinel is neutralized.
/**
 * Break the sentinel literal so delivered text can never match the exit
 * poller's pattern (a pasted `__SUBAGENT_DONE_0__` would read as completion).
 */
export function neutralizeSentinel(text: string): string {
  return text.replace(/__SUBAGENT_DONE_/g, "__SUBAGENT-DONE_");
}

/**
 * For typing into a live pane: newlines collapse to spaces (pane send is
 * line-oriented), then trim and cap at 4000 chars.
 */
export function sanitizeInjectedMessage(message: string): string {
  const collapsed = neutralizeSentinel(
    message.replace(/\s*\n\s*/g, " ").trim(),
  );
  const MAX_INJECTED_MESSAGE_LENGTH = 4000;
  if (collapsed.length <= MAX_INJECTED_MESSAGE_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_INJECTED_MESSAGE_LENGTH)}…[truncated]`;
}

/**
 * For the artifact/@file channel (resume): the file tolerates newlines, but
 * contents still render on screen, so the sentinel is neutralized too.
 */
export function sanitizeArtifactMessage(message: string): string {
  const trimmed = message.trim();
  const MAX_ARTIFACT_MESSAGE_LENGTH = 20_000;
  const capped =
    trimmed.length <= MAX_ARTIFACT_MESSAGE_LENGTH
      ? trimmed
      : `${trimmed.slice(0, MAX_ARTIFACT_MESSAGE_LENGTH)}…[truncated]`;
  return neutralizeSentinel(capped);
}
