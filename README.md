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
  "fresh" something is in the conversation's own frame rather than a real-time timer. Edge
  glow equals the freshness of the node above it, so a whole ancestor chain lights up when
  any of its members are still fresh, not just the exact node touched.

```
npm install
npm run compile
# then F5 in VS Code (or Run Extension via .vscode/launch.json) to try it
# in the Extension Development Host
```

Verified statically against the real `toprope-agentdev` meta-repo (layout math, node
classification, node-folding) and against a fabricated fake transcript (offset tracking,
partial-line buffering across ticks, tool_use file_path extraction, path-to-node resolution
walking up to a folded parent, freshness decay math) — not yet exercised by hand in a live
Extension Development Host window. The transcript format is Claude Code's internal
conversation-persistence schema, not a published contract (see the `toprope-agentdev` diary,
2026-08-18-1007) — malformed/drifted lines are skipped rather than crashing the extension,
degrading to "no glow" if it ever breaks.
