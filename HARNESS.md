---
name: ahar-visualizer
description: VS Code extension that visualizes an agent-harnesses-standard directory tree and live-tails a running Claude Code session's transcript to show real-time navigation activity on it. TypeScript, single webview-panel architecture, node:test suite covering all client-side logic via VM extraction from the compiled HTML template.
---

## Upon loading the Harness

This repo is the extension itself — see `README.md` for what it does and how it looks (node-link tree, live glow, collapse/expand, the Activity Bar sidebar entry). This `HARNESS.md` is for whoever — human or agent — is developing *on* the extension, not a persona the extension plays.

Five source files carry almost all the logic:

- `src/extension.ts` — activation entry point; registers commands and the sidebar view provider, opens the tree panel unconditionally on activate.
- `src/treePanel.ts` — the whole webview: `HarnessTreePanel` (extension-host side — panel lifecycle, message routing, config reads) plus an inline `<script>` template string containing the *entire* client-side app (layout, pan/zoom, collapse/expand, glow/decay, toolbar, legend, debug log). There is no bundler, so this is genuinely one big self-contained HTML string. See `references/architecture.md` for the host↔webview message protocol.
- `src/transcriptWatcher.ts` — polls `~/.claude/projects/<slug>/*.jsonl` for whichever transcript file is currently most recently modified, tails it incrementally, and extracts `Read`/`Edit`/`Write` file-path touches to feed the live glow. Always follows the most recently active session, re-checking every `aharVisualizer.rescanIntervalMs`.
- `src/harness.ts` — walks the actual workspace directory tree and classifies nodes (harness root / routing / leaf / plain) using the same `.harnessleaf`/`.leaf-detectors` conventions as the `agent-harnesses` skill — independently reimplemented here, not shared code, since this extension has no dependency on that skill's Python.
- `src/sidebarView.ts` — the small Activity Bar sidebar panel (`WebviewViewProvider`): two buttons, open-tree and open-settings.

## Testing

`npm test` compiles then runs `node --test test/*.test.js`. Because the client script only exists inline inside `treePanel.ts`'s template string, `test/webviewLogic.harness.js` extracts it verbatim via string markers and runs it in a small VM-sandboxed stub DOM — tests assert on the *real* client logic, not a reimplementation of it. Never hand-edit the extraction markers (`<script nonce="${nonce}">` / `</script>`, `const nodes = ${data};`, `const config = ${configData};`) without checking the harness still finds them.

The stub DOM's `getBoundingClientRect()`/`getBBox()` return fixed values regardless of actual content — real layout-dependent behavior (the `fitToView` centering math, anything visual) needs a real VS Code window to check. See `skills/dev-preview/SKILL.md` for how to do that without risking whatever session is running the check.

## Skills

- See `skills/SKILLS.md` for the full index.

## References

- See `references/REFERENCES.md` for the full index.
