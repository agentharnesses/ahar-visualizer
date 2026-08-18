# ahar-vsvis

A lightweight but powerful visualization tool for `ahar` (agent-harnesses standard)-powered
repos: a VS Code extension that observes a running Claude Code session and visualizes its
navigation against the harness/sub-harness structure it's exploring.

## Status: MVP

A minimal VS Code extension is in place: a "Harness Structure" tree view in the Explorer
sidebar that renders the open workspace's directory tree, with `HARNESS.md`/routing/leaf
files visually distinguished (icons), and a "Flatten Harnesses" toggle to collapse down to
just the harness-relevant nodes. Ported by hand from the `agent-harnesses` skill's
`.harnessleaf`/`.leaf-detectors` detection logic in the `toprope-agentdev` meta-repo.

```
npm install
npm run compile
# then F5 in VS Code (or Run Extension via .vscode/launch.json) to try it
# in the Extension Development Host
```

Not yet verified running in a live Extension Development Host window — compiles clean and
was mid-verification when the driving session was interrupted (see the
`toprope-agentdev` diary for the full story). Next: confirm it actually renders, then build
out the live agent-navigation visualizer described in the meta-repo's diary feature plan.
