/**
 * Terminal-multiplexer facade for subagent surfaces.
 *
 * Implementation lives in ./mux/: backend detection (backend.ts), one module
 * per backend (cmux-backend.ts, zellij.ts, tmux.ts, herdr.ts, wezterm.ts),
 * shared grid geometry (layout-grid.ts), layout-mode persistence
 * (layout-mode.ts), pane tracking (tracked-panes.ts), small helpers
 * (util.ts), and the public dispatchers (api.ts). This file re-exports the
 * public surface so existing `from "./cmux.ts"` imports keep working.
 */

// Public API
export {
  closeSurface,
  createSurface,
  createSurfaceSplit,
  readScreen,
  readScreenAsync,
  renameCurrentTab,
  renameWorkspace,
  sendCommand,
  sendEscape,
  sendLongCommand,
} from "./mux/api.ts";
// Backend detection & selection
export type { MuxBackend } from "./mux/backend.ts";
export {
  getMuxBackend,
  isCmuxAvailable,
  isHerdrAvailable,
  isMuxAvailable,
  isWezTermAvailable,
  muxSetupHint,
} from "./mux/backend.ts";
// cmux
export {
  parseCmuxFocusedSnapshot,
  parseCmuxFocusedSnapshotFromJson,
  parseCmuxJson,
  parseCmuxPaneRefForSurface,
  parseCmuxPaneRefForSurfaceFromJson,
} from "./mux/cmux-backend.ts";
// herdr
export type {
  HerdrLayout,
  HerdrLayoutPane,
  HerdrLayoutSplit,
  HerdrRect,
  HerdrResizeOp,
} from "./mux/herdr.ts";
export {
  isHerdrAgentWorking,
  parseHerdrLayout,
  parseHerdrPaneId,
  planHerdrGridRebalance,
  planHerdrRebalance,
  setHerdrSubagentPaneList,
} from "./mux/herdr.ts";
// Shared grid geometry & layout primitives
export type {
  GridDims,
  GridRect,
  GridTargets,
  TiledAnchorSelection,
} from "./mux/layout-grid.ts";
export {
  gridDimsForCount,
  placedPanes,
  planGridTargets,
  rightmostAnchor,
  selectSpawnAnchor,
  selectTiledGridAnchor,
} from "./mux/layout-grid.ts";
// Layout mode persistence
export type { SubagentLayoutMode } from "./mux/layout-mode.ts";
export {
  getSubagentLayoutMode,
  setSubagentLayoutMode,
} from "./mux/layout-mode.ts";
// tmux
export type {
  TmuxGridResizeOp,
  TmuxPaneGeometry,
  TmuxResizeOp,
} from "./mux/tmux.ts";
export {
  parseTmuxPaneGeometry,
  planTmuxGridRebalance,
  planTmuxRebalance,
  setTmuxSubagentPaneList,
} from "./mux/tmux.ts";
// Shared helpers
export { shellEscape } from "./mux/util.ts";
// zellij
export type {
  ZellijPaneSnapshot,
  ZellijPlacementPlan,
  ZellijSplitDirection,
} from "./mux/zellij.ts";
export {
  canSplitZellijPane,
  predictZellijSplitDirection,
  selectZellijPlacement,
  selectZellijStackPlacement,
} from "./mux/zellij.ts";
