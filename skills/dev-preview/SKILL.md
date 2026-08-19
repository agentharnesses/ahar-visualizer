---
name: dev-preview
description: Use when a change to ahar-visualizer needs checking in a real VS Code window — anything the automated test suite's fake DOM can't verify (visual layout, the Activity Bar icon, real webview rendering). Launches an isolated, disposable Extension Development Host instance and captures a screenshot, without touching whatever VS Code window/session is currently doing the checking.
---

## The hazard this works around

A Claude Code session doing this work is very often itself running inside the integrated terminal of a VS Code window that has this same extension open via `--extensionDevelopmentPath` — e.g. testing changes to itself, or being driven from a parent repo that vendors this one as a submodule. Reloading, closing, or quitting *that* window kills the session mid-work, with no chance to persist state. Before touching any running VS Code window, check this session's own process ancestry:

```
ps -o pid,ppid,command -p $$
```

and walk `ppid` up a few levels — if a `Code Helper` or `Code --extensionDevelopmentPath=...` process shows up in the chain, that's the window this session lives in. Don't reload or close it.

## Automation is a dead end here — don't try

macOS's Accessibility layer (`osascript`/System Events) only ever exposes **one** `"Code"` GUI process to script against, no matter how many separate Electron instances are actually running at the OS level — and that one is reliably the first-launched, real window. There is no safe way to send keystrokes or window-activate a second instance specifically; any attempt risks typing into the real window instead. Don't use `osascript` keystroke/activate calls against a new dev-host instance for this reason.

## The safe pattern

1. Compile first: `npm run compile`. The Extension Development Host loads `out/`, not `src/` — a stale compile shows stale behavior.
2. Launch a genuinely separate, disposable instance with its own profile:
   ```
   code --extensionDevelopmentPath=/path/to/ahar-visualizer \
        --user-data-dir=/tmp/ahar-visualizer-demo-N \
        --skip-welcome --skip-release-notes \
        /path/to/some/workspace
   ```
   Increment `N` each time to avoid colliding with a still-running earlier instance. The workspace just needs *some* real directory structure worth rendering — ideally one with a `HARNESS.md` so the tree has harness-relevant color to check.
3. **Don't pass `--new-window` alongside the workspace path.** That combination has silently failed to load the folder (opened to an empty welcome screen, no folder, no Explorer content) when tested. Omitting `--new-window` and relying on the fresh `--user-data-dir` to force a new window works correctly.
4. Confirm it launched via `ps`, not System Events — `ps` sees every process regardless of what Accessibility will expose:
   ```
   ps aux | grep -- "--user-data-dir=/tmp/ahar-visualizer-demo-N"
   ```
5. Look at it with a plain screenshot — no window targeting needed. `activate()` opens the tree panel unconditionally, and Activity Bar icons appear without any click, so everything worth checking is already on screen the moment the window finishes loading:
   ```
   screencapture -x /path/to/output.png
   ```
6. Beyond that first screenshot, hand it back to whoever's driving to click around themselves, rather than trying to drive the new window further — that sidesteps the automation dead end above entirely.

## Cleanup

Each instance leaves behind a real `/tmp/ahar-visualizer-demo-N` profile directory and a handful of Electron helper processes. Disposable — `rm -rf` when done, or let old ones accumulate under `/tmp` (harmless clutter, not a leak that affects anything else).
