---
description: How to open ahar-visualizer panels pinned to a specific directory and/or transcript file, for side-by-side agent-navigation comparison testing.
---

Default startup behavior, the sidebar buttons, and `aharVisualizer.openTreeVisualization` are
all unchanged — this is a strictly additive, Command-Palette/URI-only path layered on top,
built to support comparison tests like "run the same question in two directories, one with the
agent-harnesses standard and one without, and observe how the agent's navigation differs."

## Two entry points, one underlying mechanism

Both call `HarnessTreePanel.createCustom({ rootPath, sessionFile?, label? })` (`src/treePanel.ts`),
which **always creates a new, independently tracked panel** — unlike the default panel, it is
never reused or revealed on a repeat call. That's what makes side-by-side comparison possible:
open one custom panel per directory/session combination you want to watch at once.

- **`aharVisualizer.openCustomVisualization`** — Command Palette only, not on any menu or
  toolbar. Prompts for a directory, an optional label, and optionally a specific `.jsonl`
  transcript to pin instead of auto-following whichever session is most recently active. Meant
  for interactive, ad hoc use.
- **URI handler** — the scriptable hook, meant for an external test runner:
  ```
  vscode://agentharnesses.ahar-visualizer/openTree?root=<abs-path>&session=<abs-path, optional>&label=<text, optional>
  ```
  A bash script can pop a pre-wired panel with zero UI interaction, e.g. on macOS:
  ```sh
  open "vscode://agentharnesses.ahar-visualizer/openTree?root=$DIR_A&label=with-harness"
  open "vscode://agentharnesses.ahar-visualizer/openTree?root=$DIR_B&label=without-harness"
  ```
  `root` must already exist and be a directory (validated; a bad path shows an error rather than
  silently no-oping). `session`, if given, is deliberately **not** required to exist yet — the
  panel's `TranscriptWatcher` retries every tick until the pinned file appears, so a test script
  can open the panel *before* launching the `claude` CLI session it's meant to watch.

## Pinning a session ("chat continuum")

By default a panel auto-follows whichever `.jsonl` transcript is most recently modified in that
directory's `~/.claude/projects/<slug>/` folder (see `references/architecture.md`). Passing
`session`/pinning via the dialog bypasses that entirely and tails exactly the given file — useful
when a test directory gets reused across multiple runs and "whatever's newest" would otherwise
follow the wrong (or a stale) run, or when replaying a completed session's navigation after the
fact rather than watching one live.

## Debug logs

The default panel keeps the legacy fixed path `/tmp/ahar-visualizer-debug.log`, so existing
`tail -f` workflows are unaffected. Each custom panel gets its own
`/tmp/ahar-visualizer-debug-<slug>.log`, where `<slug>` is the sanitized `label` if given, else
the directory's basename. Two concurrently-open custom panels that end up with the same slug
(same label, or same-basename directories with no label) will collide on one file — use distinct
labels when running more than one comparison panel at a time.

## Out of scope here

Launching the `claude` CLI sessions themselves, timing them, or diffing their final answers is
not part of this extension — that's a future, separate test-runner tool (its own repo). This
doc covers only the visualizer-side hook such a tool would call into.
