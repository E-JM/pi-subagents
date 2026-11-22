/**
 * Pane-id tracking shared by herdr and tmux: globalThis + Symbol.for so the
 * list survives /reload; ids stay in spawn order (grid fill order).
 */
export function createTrackedPaneList(key: symbol) {
  const paneList = (): string[] => {
    const store = globalThis as Record<symbol, unknown>;
    if (!Array.isArray(store[key])) {
      store[key] = [];
    }
    return store[key] as string[];
  };
  const setPaneList = (paneIds: string[]): void => {
    (globalThis as Record<symbol, unknown>)[key] = [...paneIds];
  };
  return {
    paneList,
    setPaneList,
    /** Track a spawned subagent pane so layout ops stay in the group (idempotent). */
    track(paneId: string): void {
      const panes = paneList();
      if (!panes.includes(paneId)) panes.push(paneId);
    },
    /** Forget a subagent pane after its surface closes. */
    untrack(paneId: string): void {
      setPaneList(paneList().filter((id) => id !== paneId));
    },
  };
}
