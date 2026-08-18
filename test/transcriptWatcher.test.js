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

test('fires onSessionStart on every session switch and resets the step counter', () => {
  const home = fakeHome()
  withFakeHome(home, () => {
    const dir = projectDirFor(home, ROOT)

    const sessionStarts = []
    const events = []
    const w = new TranscriptWatcher(
      ROOT,
      (step, filePaths) => events.push({ step, filePaths }),
      () => {},
      () => sessionStarts.push(true)
    )
    w.start()
    w.stop()
    assert.equal(sessionStarts.length, 0, 'no session exists yet, so nothing to start')

    const first = path.join(dir, 'first.jsonl')
    fs.writeFileSync(
      first,
      [readToolUseLine('Read', ROOT + '/a.ts'), readToolUseLine('Read', ROOT + '/b.ts')].join('\n') + '\n'
    )
    w['tick']()
    assert.equal(sessionStarts.length, 1, 'first session file discovered should fire onSessionStart')
    assert.equal(events.pop().step, 2, 'step counts from 1 for this session')

    sleepSync(30)
    const second = path.join(dir, 'second.jsonl')
    fs.writeFileSync(second, readToolUseLine('Read', ROOT + '/c.ts') + '\n')
    w['tick']()
    assert.equal(sessionStarts.length, 2, 'switching to a different session fires onSessionStart again')
    assert.equal(events.pop().step, 1, 'step restarts from 1 for the new session, not continuing from the old one')
  })
})

test('never re-stats a file once it has been rejected by the birthtime cutoff', () => {
  const home = fakeHome()
  withFakeHome(home, () => {
    const dir = projectDirFor(home, ROOT)

    // A pile of historical sessions, all predating the watcher — simulates
    // a repo with a lot of session history already sitting in its project
    // directory before this panel was ever opened.
    const oldFiles = []
    for (let i = 0; i < 15; i++) {
      const f = path.join(dir, 'old-' + i + '.jsonl')
      fs.writeFileSync(f, readToolUseLine('Read', ROOT + '/old.ts') + '\n')
      oldFiles.push(f)
    }
    // A real, unambiguous gap before the watcher's cutoff timestamp — without
    // this, file creation and `Date.now()` can land in the same millisecond,
    // and birthtime-vs-cutoff comparisons at that resolution aren't reliably
    // ordered (same class of race the "ignores a session file that predates
    // the watcher" test above already accounts for).
    sleepSync(30)

    const w = new TranscriptWatcher(ROOT, () => {})
    // start() itself runs an initial tick, which is enough to see and
    // reject every old file at least once — run a couple more up front so
    // the cache is fully warmed before measurement starts, since the exact
    // tick on which each file first gets seen isn't the point of this test.
    w.start()
    w.stop()
    w['tick']()
    w['tick']()

    const realStatSync = fs.statSync
    let statCallsOnOldFiles = 0
    fs.statSync = (p, ...rest) => {
      if (oldFiles.includes(p)) statCallsOnOldFiles++
      return realStatSync(p, ...rest)
    }
    try {
      w['tick']()
      w['tick']()
      w['tick']()

      assert.equal(
        statCallsOnOldFiles,
        0,
        'once cached as rejected, an old file must never be stat-ed again on any later tick'
      )
    } finally {
      fs.statSync = realStatSync
    }
  })
})
