# ahar-visualizer

A VS Code extension that visualizes an [Agent Harnesses](https://agentharnesses.io)-standard
directory as a live node-link diagram, and lights up nodes in real time as a `claude` CLI
session reads, edits, and writes them.

[![Latest release](https://img.shields.io/github/v/release/agentharnesses/ahar-visualizer)](https://github.com/agentharnesses/ahar-visualizer/releases)

## Installation

Not yet on the VS Code Marketplace — install from a `.vsix` release instead:

1. Download the latest `.vsix` from [Releases](https://github.com/agentharnesses/ahar-visualizer/releases).
2. Install it:
   ```bash
   code --install-extension ahar-visualizer-X.Y.Z.vsix
   ```
   or, from inside VS Code: Extensions view → `...` menu → **Install from VSIX...**

No auto-update — a new version means downloading and re-installing the new `.vsix`.

## Updating

There's no in-place upgrade path, so updating means uninstalling the current version, then
installing the new `.vsix` as above:

1. Uninstall the current version:
   ```bash
   code --uninstall-extension agentharnesses.ahar-visualizer
   ```
   or, from inside VS Code: Extensions view → find **ahar-visualizer** → gear icon →
   **Uninstall**.
2. Download the new `.vsix` from [Releases](https://github.com/agentharnesses/ahar-visualizer/releases)
   and install it (see [Installation](#installation) above).
3. Reload VS Code if it doesn't prompt you to automatically.

## How it works

ahar-visualizer runs two independent pipelines side by side:

**Structure.** On activation it scans the open workspace using the same
[`.harnessleaf`/`.leaf-detectors` conventions](https://agentharnesses.io) the `agent-harnesses`
standard defines — harness roots, routing directories, leaves, and everything else — and lays it
out as a node-link diagram. A native VS Code file watcher then keeps that diagram live: any file
or directory created or deleted anywhere in the workspace triggers a debounced rescan, which
merges the change into the running diagram in place — existing pan/zoom position and manual
collapse/expand state are never disturbed, and only genuinely new subtrees get an initial
auto-collapse decision.

**Live activity.** Independently, the extension passively tails whichever `claude` CLI session
transcript under `~/.claude/projects/<slug>/*.jsonl` is currently most recently modified — no
hooks setup required — and lights up (then gradually dims) nodes as the agent reads, edits, or
writes them. Glow decays by conversation length (transcript lines observed), not wall-clock time,
so a long pause doesn't fade anything. Switching to a different, newer session resets the glow
state, so "recently touched" always means within the session currently being followed.

## Features

- **Shapes, not labels.** Every directory and file is a small shape (square = directory, circle
  = file) — no inline text, so large trees stay compact. `HARNESS.md` and routing-index files
  (`SKILLS.md`, etc.) fold into their parent directory's color rather than getting their own
  node. Harness roots, routing directories, and leaves each get a distinct color; anything not
  harness-standard-relevant renders dimmed.
- **Navigation.** Pan by dragging or two-finger scroll, zoom with Ctrl/Cmd+scroll or the toolbar,
  hover for a tooltip, click for a persistent details panel, double-click a file to open it. The
  fit-to-view button re-centers the whole graph; `+1`/`−1` expand or collapse the shallowest- or
  deepest-visible layer everywhere at once, synchronized by depth, so an uneven tree grows or
  shrinks as one flat wavefront instead of one branch racing ahead of its siblings.
- **Collapsible subtrees, built for large trees.** Double-click a directory (or use its info
  panel's "Collapse/Expand subtree" button) to hide or fully reveal its descendants — regardless
  of whatever collapse state they were already in. A small arrow beneath a collapsed node glows
  with the max activity hidden inside, so a hot node buried in a collapsed branch is never
  invisible. Collapsing never walks into the hidden subtree for layout or rendering, so a
  directory with 10,000 hidden descendants costs O(1), not O(10,000).
- **Harnesses navigator: Go To / Isolate.** A separate panel lists every harness root in the
  workspace. **Go To** centers and briefly highlights one. **Isolate** collapses everything
  *except* the path to it and fully expands its own subtree — as if you'd collapsed the whole
  tree, opened just that one path, and hit "Expand subtree" on it.
- **Three-tier prominence.** Beyond hot/cold, anything ever touched in the current session stays
  visually distinct forever (a dim persistent tint) from anything never touched — so you can see
  at a glance everywhere the agent has been this session, not just where it is right now.
- **Opening a folded routing/`HARNESS.md` file.** Since those files never get their own node,
  clicking the directory they belong to shows an "Open SKILLS.md" (or `HARNESS.md`, etc.) button
  in its info panel.

## Settings

`aharVisualizer.maxDepth`, `maxNodesBeforeCollapse`, `maxChildrenBeforeCollapse`, and
`maxNodesOnExpand` control the auto-collapse thresholds a large tree uses to stay readable;
`rescanIntervalMs` controls how often the transcript watcher checks for a more recently active
session. Reach them via the toolbar's gear button, the sidebar's "Open Settings" button, or the
`ahar-visualizer: Open Settings` command.

## Related projects

- **[Agent Harnesses](https://agentharnesses.io)** ([GitHub](https://github.com/agentharnesses/agentharnesses)) —
  the open standard this extension visualizes: a directory format for giving AI agents a role,
  context, and capabilities via progressive disclosure.
- **[`ahar` CLI](https://github.com/agentharnesses/cli)** — scaffold, validate, and inspect
  harnesses from the command line (`pip install agentharnesses-cli`).
- **[agent-harnesses metaskill](https://github.com/agentharnesses/metaskill)** — a drop-in skill
  that lets agents without native Agent Harnesses support explore a harness progressively.

## Development

```bash
npm install
npm run compile
npm test          # node:test, no external dependencies
```

Then `F5` in VS Code (or "Run Extension" via `.vscode/launch.json`) to try it in an Extension
Development Host. See `HARNESS.md` for the codebase tour, the testing philosophy (this
extension's logic is deliberately verified by extracting and running its real client-side script
against a stubbed DOM, not by hand-checking a live window for every change), and
`references/release-process.md` for how a `.vsix` release actually gets built and published.

## License

[Apache 2.0](./LICENSE)
