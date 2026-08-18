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
- **Live glow.** While a `claude` CLI session runs in the same workspace, the extension
  passively tails its transcript JSONL (`~/.claude/projects/<slug>/*.jsonl`, no hooks setup
  needed) and lights up nodes as Claude reads/edits/writes them. Glow fades — but based on
  *conversation growth* (transcript lines observed), not wall-clock time, so it tracks how
  "fresh" something is in the conversation's own frame rather than a real-time timer. A touch
  lights up the node itself plus its immediate containing directory (so reading a leaf's
  descriptor file visibly lights up the leaf, not just an easy-to-miss file node); an edge's
  glow equals the freshness of the node above it, so independently-fresh ancestors chain
  together visually without a single touch flooding the whole tree. Only sessions *created
  after the panel opened* are followed — if multiple `claude` sessions are writing into the
  same project directory at once (e.g. one developing this extension, another testing it),
  picking "whichever transcript has the latest mtime" would get starved by whichever session
  is more continuously active; this scopes the watcher to the session that belongs to the
  window the panel is actually running in.

```
npm install
npm run compile
npm test          # runs the automated test suite (see below)
# then F5 in VS Code (or Run Extension via .vscode/launch.json) to try it
# in the Extension Development Host
```

**Automated tests** (`npm test`, `node:test`, no dependencies) cover the parts that don't
need a live VS Code window: `test/transcriptWatcher.test.js` exercises the transcript-tailing
logic directly (offset tracking, partial-line buffering, batching, the fast-exchange-before-
first-tick edge case, and the created-after-watcher-start session scoping) against fabricated
fake transcripts; `test/webviewLogic.test.js` extracts the actual `<script>` block from
`treePanel.ts`'s generated HTML verbatim, runs it in a stubbed DOM/SVG sandbox, and asserts on
the real glow/decay/edge-propagation behavior (not a reimplementation of it) by dispatching
fake `postMessage` events and reading back computed opacities. This is deliberately the
primary way this extension's logic gets verified — round-tripping every change through a real
Extension Development Host window by hand doesn't scale as a feedback loop and misses exactly
the kind of subtle bugs (an ancestor-propagation rule that over-triggers, a temporal-dead-zone
crash from declaration order) these tests were written specifically to catch.

The transcript format itself is Claude Code's internal conversation-persistence schema, not a
published contract (see the `toprope-agentdev` diary, 2026-08-18-1007) — malformed/drifted
lines are skipped rather than crashing the extension, degrading to "no glow" if it ever
breaks.
