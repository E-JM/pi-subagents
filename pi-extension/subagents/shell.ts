// Shell-facing helpers: quoting values for a POSIX shell and deciding how
// long to let a freshly created pane's shell finish starting.

/** Single-quote a value for safe interpolation into a POSIX shell command. */
export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Shell-init can be slow (direnv/devenv), so the delay is configurable for users
 * who see dropped commands. Default stays 500ms.
 */
export function getShellReadyDelayMs(): number {
  const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}
