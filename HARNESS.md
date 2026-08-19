---
name: ahar-visualizer
description: VS Code extension that visualizes an agent-harnesses-standard directory tree and live-tails a running Claude Code session's transcript to show real-time navigation activity on it. TypeScript, single webview-panel architecture, node:test suite covering all client-side logic via VM extraction from the compiled HTML template.
---

## Upon loading the Harness

This repo is the extension itself — see `README.md` for what it does and how it looks (node-link tree, live glow, collapse/expand, the Activity Bar sidebar entry). This `HARNESS.md` is for whoever — human or agent — is developing *on* the extension, not a persona the extension plays.

Six source files carry almost all the logic:

- `src/extension.ts` — activation entry point; registers commands and the sidebar view provider, opens the tree panel unconditionally on activate. Also registers an advanced, Command-Palette-only command, a URI handler (`vscode://agentharnesses.ahar-visualizer/openTree?...`), and (dev-host only) `devQueue.ts`'s watcher, for opening additional independently-configured panels — see `references/multi-panel-testing.md`.
- `src/devQueue.ts` — dev-mode-only alternative to the URI handler: polls a fixed directory for JSON "open this panel" requests, since a `vscode://` URL can't reliably reach a disposable Extension Development Host (confirmed empirically — see `references/multi-panel-testing.md` and the parent meta-repo's `references/ahar-visualizer-dev-workflow.md`). Gated on `context.extensionMode`, so it's inert for a real installed extension.
- `src/treePanel.ts` — the whole webview: `HarnessTreePanel` (extension-host side — panel lifecycle, message routing, config reads) plus an inline `<script>` template string containing the *entire* client-side app (layout, pan/zoom, collapse/expand, glow/decay, toolbar, legend, debug log). There is no bundler, so this is genuinely one big self-contained HTML string. See `references/architecture.md` for the host↔webview message protocol. `HarnessTreePanel` is a reused singleton only for the default panel (`createOrShow`); additional "custom" panels opened via `createCustom` are pooled independently (`customPanels`) and can coexist with the default panel and each other.
- `src/transcriptWatcher.ts` — polls `~/.claude/projects/<slug>/*.jsonl` for whichever transcript file is currently most recently modified, tails it incrementally, and extracts `Read`/`Edit`/`Write` file-path touches to feed the live glow. Follows the most recently active session by default, re-checking every `aharVisualizer.rescanIntervalMs` — unless a panel pins it to one specific file (`sessionFileOverride`), in which case it tails exactly that file, retrying until it exists. Also tails every subagent (`Task`/`Agent` tool) transcript dispatched during that session — a sibling `<sessionId>/subagents/*.jsonl` directory, re-scanned each tick since new ones can appear mid-run — or a run that delegates most of its exploration to a subagent looks nearly idle. See `references/multi-panel-testing.md` and `references/architecture.md`.
- `src/harness.ts` — walks the actual workspace directory tree and classifies nodes (harness root / routing / leaf / plain) using the same `.harnessleaf`/`.leaf-detectors` conventions as the `agent-harnesses` skill — independently reimplemented here, not shared code, since this extension has no dependency on that skill's Python.
- `src/sidebarView.ts` — the small Activity Bar sidebar panel (`WebviewViewProvider`): two buttons, open-tree and open-settings.

## Testing

`npm test` compiles then runs `node --test test/*.test.js`. Because the client script only exists inline inside `treePanel.ts`'s template string, `test/webviewLogic.harness.js` extracts it verbatim via string markers and runs it in a small VM-sandboxed stub DOM — tests assert on the *real* client logic, not a reimplementation of it. Never hand-edit the extraction markers (`<script nonce="${nonce}">` / `</script>`, `const nodes = ${data};`, `const config = ${configData};`) without checking the harness still finds them.

The stub DOM's `getBoundingClientRect()`/`getBBox()` return fixed values regardless of actual content — real layout-dependent behavior (the `fitToView` centering math, anything visual) needs a real VS Code window to check. See `skills/dev-preview/SKILL.md` for how to do that without risking whatever session is running the check.

## Packaging & Release

Not on the Marketplace — distributed as a `.vsix` built by a tag-triggered GitHub Actions
workflow. See `references/release-process.md` for the full mechanics (packaging, the CI
workflow, cutting a release, how end users install it).

## Skills

- See `skills/SKILLS.md` for the full index.

## References

- See `references/REFERENCES.md` for the full index.
