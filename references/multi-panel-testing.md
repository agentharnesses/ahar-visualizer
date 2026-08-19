---
description: How to open ahar-visualizer panels pinned to a specific directory and/or transcript file, for side-by-side agent-navigation comparison testing.
---

Default startup behavior, the sidebar buttons, and `aharVisualizer.openTreeVisualization` are
all unchanged — this is a strictly additive, Command-Palette/URI-only path layered on top,
built to support comparison tests like "run the same question in two directories, one with the
agent-harnesses standard and one without, and observe how the agent's navigation differs."

## Three entry points, one underlying mechanism

All three call `HarnessTreePanel.createCustom({ rootPath, sessionFile?, label? })`
(`src/treePanel.ts`), which **always creates a new, independently tracked panel** — unlike the
default panel, it is never reused or revealed on a repeat call. That's what makes side-by-side
comparison possible: open one custom panel per directory/session combination you want to watch
at once.

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
- **Dev-mode queue** (`src/devQueue.ts`) — the same request shape, but delivered by writing a
  JSON file to a fixed directory instead of firing a URL. Only active when
  `context.extensionMode === vscode.ExtensionMode.Development` (i.e. running as an Extension
  Development Host) — never for a real installed extension. Exists because a `vscode://` URL
  always routes to the single registered Code app bundle, not to whichever `--user-data-dir`
  instance is "meant" to receive it — confirmed empirically (see
  `references/ahar-visualizer-dev-workflow.md` in the parent meta-repo), so the URI handler
  above cannot reach a disposable dev-host used to test this extension itself. See "Dev-mode:
  reaching a dev-host directly" below.

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

## Dev-mode: reaching a dev-host directly

`traversal-compare` needs a live `ahar-visualizer` to visualize against — normally its own
installed copy. But when *developing ahar-visualizer itself*, that installed copy is stale
relative to whatever's being worked on, and the safe way to test fresh code is a disposable
Extension Development Host (`skills/dev-preview/SKILL.md`), launched separately so it can't touch
whatever window is hosting the current session. The URI handler can't reach that dev-host though —
confirmed by testing it directly: firing `openTree` while a dev-host was running still routed to
the main window, never the dev-host, because macOS resolves `vscode://` to the one registered
`Code` app bundle regardless of `--user-data-dir`.

`devQueue.ts` sidesteps the OS entirely for this case. When running as a dev-host
(`context.extensionMode === vscode.ExtensionMode.Development`), it polls a fixed directory,
`/tmp/ahar-visualizer-dev-queue/`, every ~500ms for `*.json` request files (same
`{rootPath, sessionFile?, label?}` shape as the URI handler), and touches a `.heartbeat` file in
that directory on every poll — live or not — so a caller can tell a genuinely-running watcher
apart from a stale directory a since-killed dev-host left behind, rather than writing requests
into the void. `traversal-compare`'s `viewer.py` checks that heartbeat's freshness (< 3s old)
before choosing this path over the URI handler, so it's fully automatic: run a dev-host, then run
`traversal-compare run ... `, and its panels land in the dev-host with no flags or config needed.
No effect on a normal install — `DEV_QUEUE_DIR` simply won't exist, and even if it somehow did,
`extensionMode` gates the watcher from ever starting outside a dev-host.

## Out of scope here

Launching the `claude` CLI sessions themselves, timing them, or diffing their final answers is
`traversal-compare`'s job (a sibling submodule of this repo), not this extension's — this doc
covers only the visualizer-side hooks it calls into.
