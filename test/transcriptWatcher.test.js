const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')

const { TranscriptWatcher } = require('../out/transcriptWatcher.js')

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}

function fakeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ahar-test-home-'))
}

function withFakeHome(home, fn) {
  const real = os.homedir
  os.homedir = () => home
  try {
    return fn()
  } finally {
    os.homedir = real
  }
}

function projectDirFor(home, rootPath) {
  const dir = path.join(home, '.claude', 'projects', rootPath.replace(/\//g, '-'))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function readToolUseLine(name, filePath) {
  return JSON.stringify({ message: { content: [{ type: 'tool_use', name, input: { file_path: filePath } }] } })
}

const ROOT = '/fake/workspace/root'

test('reads a whole fast exchange that completed before the first tick', () => {
  const home = fakeHome()
  withFakeHome(home, () => {
    const dir = projectDirFor(home, ROOT)
    const jsonl = path.join(dir, 'sess.jsonl')
    const lines = [
      JSON.stringify({ message: { content: [{ type: 'text', text: 'hi' }] } }),
      readToolUseLine('Read', ROOT + '/HARNESS.md')
    ]
    fs.writeFileSync(jsonl, lines.join('\n') + '\n')

    const events = []
    const w = new TranscriptWatcher(ROOT, (step, filePaths) => events.push({ step, filePaths }))
    w['watcherStartMs'] = 0 // don't exercise the birthtime cutoff in this test
    w['tick']()

    assert.equal(events.length, 1)
    assert.equal(events[0].step, 2)
    assert.deepEqual(events[0].filePaths, [ROOT + '/HARNESS.md'])
  })
})

test('buffers a partial line across ticks instead of dropping or double-processing it', () => {
  const home = fakeHome()
  withFakeHome(home, () => {
    const dir = projectDirFor(home, ROOT)
    const jsonl = path.join(dir, 'sess.jsonl')
    fs.writeFileSync(jsonl, '')

    const events = []
    const w = new TranscriptWatcher(ROOT, (step, filePaths) => events.push({ step, filePaths }))
    w['watcherStartMs'] = 0
    w['tick']() // attaches to the empty file, no events yet
    assert.equal(events.length, 0)

    const full = readToolUseLine('Edit', ROOT + '/src/bar.ts')
    fs.appendFileSync(jsonl, full.slice(0, 20)) // no trailing newline: a partial line
    w['tick']()
    assert.equal(events.length, 0, 'a partial line must not fire an event yet')

    fs.appendFileSync(jsonl, full.slice(20) + '\n')
    w['tick']()
    assert.equal(events.length, 1)
    assert.deepEqual(events[0].filePaths, [ROOT + '/src/bar.ts'])
  })
})

test('batches every line from one tick into a single onEvent call', () => {
  const home = fakeHome()
  withFakeHome(home, () => {
    const dir = projectDirFor(home, ROOT)
    const jsonl = path.join(dir, 'sess.jsonl')
    const lines = [
      readToolUseLine('Read', ROOT + '/a.ts'),
      readToolUseLine('Read', ROOT + '/b.ts'),
      readToolUseLine('Read', ROOT + '/c.ts')
    ]
    fs.writeFileSync(jsonl, lines.join('\n') + '\n')

    const events = []
    const w = new TranscriptWatcher(ROOT, (step, filePaths) => events.push({ step, filePaths }))
    w['watcherStartMs'] = 0
    w['tick']()

    assert.equal(events.length, 1, 'three lines discovered in one tick should be one batched event')
    assert.equal(events[0].step, 3)
    assert.deepEqual(events[0].filePaths, [ROOT + '/a.ts', ROOT + '/b.ts', ROOT + '/c.ts'])
  })
})

test('ignores a session file that predates the watcher, even if it is the most recently modified', () => {
  const home = fakeHome()
  withFakeHome(home, () => {
    const dir = projectDirFor(home, ROOT)
    const oldFile = path.join(dir, 'old-long-running-session.jsonl')
    fs.writeFileSync(oldFile, readToolUseLine('Read', ROOT + '/should-not-be-seen.ts') + '\n')

    sleepSync(30) // ensure a real, filesystem-observable time gap

    const events = []
    const w = new TranscriptWatcher(ROOT, (step, filePaths) => events.push({ step, filePaths }))
    w.start() // real start(): stamps watcherStartMs to now, after oldFile's birthtime
    w.stop() // cancel the interval; we'll drive ticks manually from here

    // Touch the old file so it's *also* the most-recently-modified — this is
    // exactly the failure mode being fixed: mtime alone would pick it.
    fs.appendFileSync(oldFile, readToolUseLine('Read', ROOT + '/also-not-seen.ts') + '\n')
    w['tick']()
    assert.equal(events.length, 0, 'a session that predates the watcher must never be followed')

    sleepSync(30)
    const newFile = path.join(dir, 'new-session.jsonl')
    fs.writeFileSync(newFile, readToolUseLine('Read', ROOT + '/should-be-seen.ts') + '\n')
    w['tick']()

    assert.equal(events.length, 1)
    assert.deepEqual(events[0].filePaths, [ROOT + '/should-be-seen.ts'])
  })
})

test('follows the newest post-start session when more than one exists', () => {
  const home = fakeHome()
  withFakeHome(home, () => {
    const dir = projectDirFor(home, ROOT)

    const events = []
    const w = new TranscriptWatcher(ROOT, (step, filePaths) => events.push({ step, filePaths }))
    w.start()
    w.stop()

    const first = path.join(dir, 'first.jsonl')
    fs.writeFileSync(first, readToolUseLine('Read', ROOT + '/first.ts') + '\n')
    w['tick']()
    assert.deepEqual(events.pop().filePaths, [ROOT + '/first.ts'])

    sleepSync(30)
    const second = path.join(dir, 'second.jsonl')
    fs.writeFileSync(second, readToolUseLine('Read', ROOT + '/second.ts') + '\n')
    w['tick']()
    assert.deepEqual(events.pop().filePaths, [ROOT + '/second.ts'], 'should switch to the newer session')
  })
})
