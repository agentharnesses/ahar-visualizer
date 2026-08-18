# ahar-vsvis

A lightweight but powerful visualization tool for `ahar` (agent-harnesses standard)-powered
repos: a VS Code extension that observes a running Claude Code session and visualizes its
navigation against the harness/sub-harness structure it's exploring.

## Status: MVP

Activating the extension in a workspace opens one thing: a large panel beside the editor
with a node-link diagram of the whole tree (directory/file classification logic ported by
hand from the `agent-harnesses` skill's `.harnessleaf`/`.leaf-detectors` conventions in the
`toprope-agentdev` meta-repo). No sidebar view — the panel *is* the extension, built from
whichever folder is open as the workspace root.

- **Shapes, not labels.** Every directory and file is a small shape (square = directory,
  circle = file); no inline text, to keep large trees compact. `HARNESS.md` and routing-index
  files (`SKILLS.md`, etc.) don't get their own node — they just color their parent directory.
  Harness roots, routing directories, and leaves each get their own color; anything not
  harness-standard-relevant renders dimmed.
- **Navigation.** Pan by dragging or two-finger scroll, zoom with Ctrl/Cmd+scroll or the
  +/− buttons, hover a node for a lightweight name/kind tooltip, click for a persistent
  details panel (path, kind, child count, open-file button), double-click a file to open it.
  The panel is a normal editor tab — closing it is just closing the tab; the
  `aharVsvis: Open Tree Visualization` command re-creates it, and its own refresh button
  (⟳) re-scans the directory without needing the command palette.
- **Live glow, scoped to the current session.** While a `claude` CLI session runs in the same
  workspace, the extension passively tails its transcript JSONL (`~/.claude/projects/<slug>/
  *.jsonl`, no hooks setup needed) and lights up nodes as Claude reads/edits/writes them. Glow
  fades based on *conversation growth* (transcript lines observed), not wall-clock time. A
  touch lights up the node itself plus its immediate containing directory; an edge only glows
  if its own child was actually touched, using the parent's freshness as the value — so
  independently-fresh ancestors chain together visually without a single touch lighting up
  every sibling edge under a fresh directory. Only sessions *created after the panel opened*
  are followed, and switching to a genuinely new session (a fresh `claude` process starting in
  the same window) resets all glow/visited state — "recently touched" always means "in the
  session currently running here," not an accumulation across every session this window has
  ever run.
- **Three-tier prominence.** Beyond hot/cold, every node and edge that was *ever* touched in
  the current session stays visually distinct forever (a dim persistent orange ring/tint) from
  ones that were never touched — deliberately more prominent than plain, so you can see at a
  glance where the agent has been over the whole session, not just where it is right now.
- **Collapsible subtrees, built for large trees.** Double-click a directory (or use the
  "Collapse subtree" button in its info panel) to hide its descendants; a small bar underneath
  shows the max glow anywhere inside, so a hot node hidden inside a collapsed branch is never
  invisible — that bar is the only visual marker for "collapsed" (no dashed border on the
  shape itself). This is designed to stay fast on very large trees: collapsing a subtree never
  walks into it for layout or rendering — a directory with 10,000 hidden descendants costs O(1)
  to collapse, not O(10,000) — and every live-update pass (`updateGlow`) only touches whatever's
  currently rendered, never the full tree.
- **Opening the routing/`HARNESS.md` file a directory's color comes from.** `HARNESS.md` and
  routing-index files never get their own node (they're folded into their parent directory's
  color), which used to mean there was no way to actually open them from the tree. Clicking such
  a directory now shows an "Open SKILLS.md" (or `HARNESS.md`, etc.) button in its info panel.

```
npm install
npm run compile
npm test          # runs the automated test suite (see below)
# then F5 in VS Code (or Run Extension via .vscode/launch.json) to try it
# in the Extension Development Host
```

**Automated tests** (`npm test`, `node:test`, no dependencies, 35 tests) cover the parts that
don't need a live VS Code window: `test/transcriptWatcher.test.js` exercises the transcript-
tailing logic directly (offset tracking, partial-line buffering, batching, the fast-exchange-
before-first-tick edge case, per-session scoping/reset, and that rejected session files never
get re-stat'd) against fabricated fake transcripts; `test/webviewLogic.test.js` and
`test/collapse.test.js` extract the actual `<script>` block from `treePanel.ts`'s generated HTML
verbatim and run it in a stubbed DOM/SVG sandbox (`test/webviewLogic.harness.js`), asserting on
the real glow/decay/edge-propagation/collapse behavior (not a reimplementation of it) by
dispatching fake `postMessage`/DOM events (including simulated clicks and double-clicks through
the real listeners) and reading back computed state; `test/serialize.test.js` extracts and
transpiles `serialize()` (the extension-host function that walks the harness index into the
node list the webview receives) to verify folded-file-path bookkeeping without needing
`vscode`; `test/integration.test.js` wires TranscriptWatcher's real output straight into the
real webview script end-to-end. This is deliberately the primary way this extension's logic
gets verified — round-tripping every change through a real Extension Development Host window
by hand doesn't scale as a feedback loop and misses exactly the kind of subtle bugs (an
ancestor-propagation rule that over-triggers, a temporal-dead-zone crash from declaration
order, edge glow with backwards opacity, an unbounded per-tick filesystem scan) these tests
were written specifically to catch.

The transcript format itself is Claude Code's internal conversation-persistence schema, not a
published contract (see the `toprope-agentdev` diary, 2026-08-18-1007) — malformed/drifted
lines are skipped rather than crashing the extension, degrading to "no glow" if it ever
breaks.
