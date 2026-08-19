---
description: How to package ahar-visualizer as a .vsix and cut a release — the vsce packaging step, the tag-triggered CI workflow that automates it, and how end users install the result.
---

## Packaging

`npm run package` (== `vsce package`) runs the `vscode:prepublish` hook to build `out/`, then
bundles `package.json`, `out/`, `readme.md`, and `media/` into a `.vsix`. Everything else
(`src/`, `test/`, `references/`, `skills/`, `HARNESS.md`) is excluded via `.vscodeignore`.

`vsce package` requires `publisher` and `repository` fields in `package.json` (present since
`0.1.0`) or it refuses to run — `"private": true` does *not* block it, that field is unrelated.
It also warns, but doesn't fail, about the missing `LICENSE` file.

## Releasing

`.github/workflows/release.yml` triggers on any pushed tag matching `v*`:

1. `npm ci`, `npm test` — the full suite must pass.
2. Verifies the tag (`vX.Y.Z`) matches `package.json`'s `version` — fails the build on a
   mismatch, so a wrongly-tagged artifact can't ship silently.
3. `vsce package`, then `gh release create <tag> ./*.vsix --generate-notes` — publishes a
   GitHub Release with the `.vsix` attached.

To cut a release: bump `version` in `package.json`, commit, then

```
git tag -a vX.Y.Z -m "..."
git push origin vX.Y.Z
```

CI does the rest. First release: `v0.1.0`
(https://github.com/agentharnesses/ahar-visualizer/releases/tag/v0.1.0).

## How end users install it

No Marketplace or Open VSX publish yet — this is deliberately just a shareable `.vsix` for now
(no publisher account set up, extension isn't public-facing). Download the `.vsix` from a
Release, then either:

- `code --install-extension ahar-visualizer-X.Y.Z.vsix`, or
- Extensions view → `...` menu → "Install from VSIX..."

There's no auto-update mechanism — a new version means downloading and re-installing the new
`.vsix`.
