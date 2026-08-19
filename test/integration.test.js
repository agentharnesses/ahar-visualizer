// End-to-end reproduction of the exact scenario reported while testing by
// hand: open the Extension Development Host, start a fresh `claude` session
// in its integrated terminal, ask it to read a plain root-level file (e.g.
// .gitignore), and expect that file's node — and its immediate containing
// directory (root, here) — to glow. This wires TranscriptWatcher's real
// output straight into the real webview script, the same way treePanel.ts
// actually connects them (postMessage payload shape and all), rather than
// testing each half in isolation.

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')

const { TranscriptWatcher } = require('../out/transcriptWatcher.js')
const { runWebview } = require('./webviewLogic.harness.js')

function fakeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ahar-test-home-'))
}

const ROOT = '/fake/workspace/root'

const NODES = [
  { id: ROOT, parentId: null, name: 'root', isDirectory: true, kind: 'harness-root' },
  { id: ROOT + '/.gitignore', parentId: ROOT, name: '.gitignore', isDirectory: false, kind: 'file' },
  { id: ROOT + '/src', parentId: ROOT, name: 'src', isDirectory: true, kind: 'group' }
]

test('reading a plain root-level file in a fresh nested session lights it up in the actual panel', () => {
  const home = fakeHome()
  const realHomedir = os.homedir
  os.homedir = () => home

  try {
    const dir = path.join(home, '.claude', 'projects', ROOT.replace(/\//g, '-'))
    fs.mkdirSync(dir, { recursive: true })

    const debugMessages = []
    const wireMessages = []
    const watcher = new TranscriptWatcher(
      ROOT,
      (step, filePaths) => wireMessages.push({ step, filePaths }),
      (message) => debugMessages.push(message)
    )
    watcher.start() // nothing exists yet, so the initial tick is a no-op
    watcher.stop() // drive ticks manually for determinism

    // Simulate the nested terminal session: user asks a question, Claude
    // reads .gitignore, answers — written to disk as one small transcript,
    // same as a real `claude` session would (created *after* watcher.start()).
    const sessionFile = path.join(dir, 'nested-session.jsonl')
    const lines = [
      JSON.stringify({ message: { content: [{ type: 'text', text: 'open the gitignore and read it' }] } }),
      JSON.stringify({
        message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: ROOT + '/.gitignore' } }] }
      }),
      JSON.stringify({ message: { content: [{ type: 'text', text: 'It ignores four things...' }] } })
    ]
    fs.writeFileSync(sessionFile, lines.join('\n') + '\n')

    watcher['tick']()

    assert.equal(wireMessages.length, 1, 'expected exactly one batched event from the watcher')
    assert.deepEqual(wireMessages[0].filePaths, [ROOT + '/.gitignore'])
    assert.ok(
      debugMessages.some((m) => m.includes('switched to session file')),
      'watcher should log that it picked up the new session'
    )
    assert.ok(
      debugMessages.some((m) => m.includes('.gitignore')),
      'watcher should log the extracted file touch'
    )

    // Now feed that exact wire payload into the real webview script, the
    // same shape treePanel.ts's postMessage call uses.
    const w = runWebview(NODES)
    w.sendStep(wireMessages[0].step, wireMessages[0].filePaths)

    assert.equal(w.nodeGlowOpacity(ROOT + '/.gitignore'), 1, '.gitignore node itself should glow')
    assert.equal(w.nodeGlowOpacity(ROOT), 1, 'root, as .gitignore\'s immediate parent, should glow')
    assert.equal(w.nodeGlowOpacity(ROOT + '/src'), 0, 'unrelated sibling should not glow')
    assert.equal(w.edgeGlowOpacity(ROOT + '/.gitignore'), 1, 'the edge on the actual touched path should glow')
    assert.equal(
      w.edgeGlowOpacity(ROOT + '/src'),
      0,
      'the sibling edge must not glow just because root (its parent) is fresh'
    )
  } finally {
    os.homedir = realHomedir
  }
})
