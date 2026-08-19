# ahar-visualizer

A lightweight but powerful visualization tool for `ahar` (agent-harnesses standard)-powered
repos: a VS Code extension that observes a running Claude Code session and visualizes its
navigation against the harness/sub-harness structure it's exploring.

## Status: MVP

Activating the extension in a workspace opens two things: a large panel beside the editor
with a node-link diagram of the whole tree (directory/file classification logic ported by
hand from the `agent-harnesses` skill's `.harnessleaf`/`.leaf-detectors` conventions in the
`toprope-agentdev` meta-repo), and a small entry in the Activity Bar — a box-with-a-down-arrow
"ahar" icon — whose sidebar offers "Open Tree Visualization" and "Open Settings" buttons as a
second, more permanent way back into the extension once the panel's been closed.

- **Shapes, not labels.** Every directory and file is a small shape (square = directory,
  circle = file); no inline text, to keep large trees compact. `HARNESS.md` and routing-index
  files (`SKILLS.md`, etc.) don't get their own node — they just color their parent directory.
  Harness roots, routing directories, and leaves each get their own color; anything not
  harness-standard-relevant renders dimmed.
- **Navigation.** Pan by dragging or two-finger scroll, zoom with Ctrl/Cmd+scroll or the
  toolbar's +/− buttons, hover a node for a lightweight name/kind tooltip, click for a
  persistent details panel (path, kind, child count, open-file button), double-click a file to
  open it. The resize button (⤢) scales and centers the whole graph — both horizontally and
  vertically — to fit the panel; this is the same computation the panel runs on first load, so
  pressing it always snaps back to that same centered position for unchanged content. `+1`/`−1`
  expand or collapse the tree's shallowest-collapsed or deepest-visible layer *everywhere at
  once, synchronized by depth*: `−1` only pulls in the single deepest branch until shallower
  branches catch up to the same depth, and `+1` only fills in the shallowest still-collapsed
  layer before touching anything deeper — so an uneven tree grows or shrinks as one flat
  wavefront rather than one branch racing ahead of its siblings. The panel is a normal editor
  tab — closing it is just closing the tab; the `ahar-visualizer: Open Tree Visualization`
  command (or the sidebar button) re-creates it, and its own refresh button (⟳) re-scans the
  directory without needing the command palette.
- **Toolbar tucked out of the way.** Zoom/fit, refresh, the `+1`/`−1` depth controls, and
  settings are grouped into visually separated clusters, sized down, and dimmed to partial
  opacity until hovered — present when you need it, unobtrusive otherwise. The debug log
  (blue: transcript-watcher events, green: this panel's own touch-resolution) collapses to a
  tiny "log" pill by default; the legend does the same, shrinking to just its header instead of
  leaving an empty panel on screen, when toggled closed.
- **Live glow, always following the most recently active session.** While a `claude` CLI
  session runs anywhere writing into the workspace's `~/.claude/projects/<slug>/*.jsonl`
  transcript directory, the extension passively tails whichever session file is currently most
  recently modified — no hooks setup needed — and lights up nodes as Claude reads/edits/writes
  them, re-checking for a more-recently-active session on an interval
  (`aharVisualizer.rescanIntervalMs`, default 400ms). Glow fades based on *conversation growth*
  (transcript lines observed), not wall-clock time. A touch lights up the node itself plus its
  immediate containing directory; an edge only glows if its own child was actually touched,
  using the parent's freshness as the value — so independently-fresh ancestors chain together
  visually without a single touch lighting up every sibling edge under a fresh directory.
  Switching to a genuinely different session (a newer one becoming the most recently active)
  resets all glow/visited state — "recently touched" always means "in whichever session is
  currently most active," not an accumulation across every session this window has ever
  followed.
- **Three-tier prominence.** Beyond hot/cold, every node and edge that was *ever* touched in
  the current session stays visually distinct forever (a dim persistent orange ring/tint) from
  ones that were never touched — deliberately more prominent than plain, so you can see at a
  glance where the agent has been over the whole session, not just where it is right now.
- **Collapsible subtrees, built for large trees.** Double-click a directory (or use the
  "Collapse subtree" button in its info panel) to hide its descendants; a small arrow beneath
  it glows with the max activity hidden inside, so a hot node hidden inside a collapsed branch
  is never invisible. This is designed to stay fast on very large trees: collapsing a subtree
  never walks into it for layout or rendering — a directory with 10,000 hidden descendants
  costs O(1) to collapse, not O(10,000) — and every live-update pass (`updateGlow`) only
  touches whatever's currently rendered, never the full tree.
- **Opening the routing/`HARNESS.md` file a directory's color comes from.** `HARNESS.md` and
  routing-index files never get their own node (they're folded into their parent directory's
  color), which used to mean there was no way to actually open them from the tree. Clicking such
  a directory now shows an "Open SKILLS.md" (or `HARNESS.md`, etc.) button in its info panel.

## Settings

`aharVisualizer.maxDepth`, `maxNodesBeforeCollapse`, `maxChildrenBeforeCollapse`, and
`maxNodesOnExpand` control the initial/manual auto-collapse thresholds; `rescanIntervalMs`
controls how often the transcript watcher re-checks for a more recently active session. Reach
them via the toolbar's gear button, the sidebar's "Open Settings" button, or the
`ahar-visualizer: Open Settings` command — all three just open VS Code's own settings UI scoped
to `aharVisualizer`.

```
npm install
npm run compile
npm test          # runs the automated test suite (see below)
# then F5 in VS Code (or Run Extension via .vscode/launch.json) to try it
# in the Extension Development Host
```

**Automated tests** (`npm test`, `node:test`, no dependencies, 64 tests) cover the parts that
don't need a live VS Code window: `test/transcriptWatcher.test.js` exercises the transcript-
tailing logic directly (offset tracking, partial-line buffering, batching, the fast-exchange-
before-first-tick edge case, per-session scoping/reset, and that it always follows whichever
session is currently most recently modified — even one that already existed before the watcher
started) against fabricated fake transcripts; `test/webviewLogic.test.js`, `test/collapse.test.js`,
`test/autoCollapse.test.js`, `test/anchoring.test.js`, `test/fitToView.test.js`, and
`test/panelChrome.test.js` extract the actual `<script>` block from `treePanel.ts`'s generated
HTML verbatim and run it in a stubbed DOM/SVG sandbox (`test/webviewLogic.harness.js`),
asserting on the real glow/decay/edge-propagation/collapse/pan-anchoring/resize-centering/UI-
chrome-toggle behavior (not a reimplementation of it) by dispatching fake `postMessage`/DOM
events (including simulated clicks and double-clicks through the real listeners) and reading
back computed state; `test/serialize.test.js` extracts and transpiles `serialize()` (the
extension-host function that walks the harness index into the node list the webview receives)
to verify folded-file-path bookkeeping without needing `vscode`; `test/integration.test.js`
wires TranscriptWatcher's real output straight into the real webview script end-to-end. This is
deliberately the primary way this extension's logic gets verified — round-tripping every change
through a real Extension Development Host window by hand doesn't scale as a feedback loop and
misses exactly the kind of subtle bugs (an ancestor-propagation rule that over-triggers, a
temporal-dead-zone crash from declaration order, edge glow with backwards opacity, an unbounded
per-tick filesystem scan) these tests were written specifically to catch. See
`skills/dev-preview/SKILL.md` for the safe way to check something that genuinely does need a
real window.

The transcript format itself is Claude Code's internal conversation-persistence schema, not a
published contract (see the `toprope-agentdev` diary, 2026-08-18-1007) — malformed/drifted
lines are skipped rather than crashing the extension, degrading to "no glow" if it ever
breaks.
