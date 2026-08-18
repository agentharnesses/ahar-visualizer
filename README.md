# ahar-vsvis

A lightweight but powerful visualization tool for `ahar` (agent-harnesses standard)-powered
repos: a VS Code extension that observes a running Claude Code session and visualizes its
navigation against the harness/sub-harness structure it's exploring.

## Status: MVP

Two ways to look at a workspace's harness structure, both using detection logic ported by
hand from the `agent-harnesses` skill's `.harnessleaf`/`.leaf-detectors` conventions in the
`toprope-agentdev` meta-repo:

- **"Harness Structure" tree view** (Explorer sidebar) — the workspace directory tree with
  `HARNESS.md`/routing/leaf files distinguished by icon, plus a "Flatten Harnesses" toggle
  to collapse down to just the harness-relevant nodes.
- **"Open Tree Visualization"** (command, or the button in the tree view's title bar) — opens
  a large panel beside the editor with a literal node-link diagram of the whole tree: every
  directory and file as a node, root at top branching downward. Folders that are a harness
  root (`HARNESS.md`) or contain a routing index (`SKILLS.md`, etc.) are colored differently
  from plain folders; leaf directories and their descriptor files get their own color too.
  Pan by dragging or two-finger scroll, zoom with Ctrl/Cmd+scroll or the +/− buttons, click a
  node for details (path, kind, child count), double-click a file to open it. The panel is a
  normal editor tab, so closing it is just closing the tab; reopening it via the command
  re-creates it.

```
npm install
npm run compile
# then F5 in VS Code (or Run Extension via .vscode/launch.json) to try it
# in the Extension Development Host
```

Verified in a live Extension Development Host against the `toprope-agentdev` meta-repo:
both views render correctly, node classification (harness-root/routing/leaf) checks out, and
the tree-visualization panel's layout math was sanity-checked against the real repo's 49-node
tree. Not yet verified by hand: the pan/zoom drag interactions themselves (only checked that
the underlying math doesn't produce bad values) — try it and see how it feels. Next: the live
agent-navigation visualizer described in the meta-repo's diary feature plan.
