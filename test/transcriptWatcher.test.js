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

function readToolUseLine(name, filePath, cwd) {
  const obj = { message: { content: [{ type: 'tool_use', name, input: { file_path: filePath } }] } }
  if (cwd !== undefined) obj.cwd = cwd
  return JSON.stringify(obj)
}

const ROOT = '/fake/workspace/root'

test('project dir slug replaces every non-alphanumeric character, not just /', () => {
  // Regression: confirmed empirically that claude's real project-dir slug rule replaces every
  // non-alphanumeric character (underscores, dots, etc.), not just path separators — a
  // slash-only replacement silently breaks for a rootPath containing any other special
  // character, which e.g. macOS's own temp directory does by default.
  const home = fakeHome()
  withFakeHome(home, () => {
    const rootWithSpecialChars = '/private/var/folders/q4/abc_def.gn/T/x'
    const expectedSlug = '-private-var-folders-q4-abc-def-gn-T-x'
    const dir = path.join(home, '.claude', 'projects', expectedSlug)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'sess.jsonl'), readToolUseLine('Read', rootWithSpecialChars + '/file.ts') + '\n')

    const events = []
    const w = new TranscriptWatcher(rootWithSpecialChars, (step, filePaths) => events.push({ step, filePaths }))
    w['tick']()

    assert.equal(events.length, 1, 'watcher should find the session under the correctly-slugged project dir')
    assert.deepEqual(events[0].filePaths, [rootWithSpecialChars + '/file.ts'])
  })
})

test('resolves a relative file_path against the transcript line\'s own cwd', () => {
  // Regression: the model doesn't always pass Read/Edit/Write an absolute file_path — confirmed
  // live (see toprope-agentdev diary 2026-08-19-1825). Without resolving against `cwd`, a
  // relative path never string-matches any node id (always absolute), and that touch is
  // silently lost rather than lighting up the tree.
  const home = fakeHome()
  withFakeHome(home, () => {
    const dir = projectDirFor(home, ROOT)
    const jsonl = path.join(dir, 'sess.jsonl')
    fs.writeFileSync(jsonl, readToolUseLine('Read', './services/returns/foo.py', ROOT) + '\n')

    const events = []
    const w = new TranscriptWatcher(ROOT, (step, filePaths) => events.push({ step, filePaths }))
    w['tick']()

    assert.equal(events.length, 1)
    assert.deepEqual(events[0].filePaths, [ROOT + '/services/returns/foo.py'])
  })
})

test('leaves an already-absolute file_path alone even when cwd is present', () => {
  const home = fakeHome()
  withFakeHome(home, () => {
    const dir = projectDirFor(home, ROOT)
    const jsonl = path.join(dir, 'sess.jsonl')
    fs.writeFileSync(jsonl, readToolUseLine('Read', ROOT + '/HARNESS.md', ROOT) + '\n')

    const events = []
    const w = new TranscriptWatcher(ROOT, (step, filePaths) => events.push({ step, filePaths }))
    w['tick']()

    assert.deepEqual(events[0].filePaths, [ROOT + '/HARNESS.md'])
  })
})

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
    w['tick']()

    assert.equal(events.length, 1, 'three lines discovered in one tick should be one batched event')
    assert.equal(events[0].step, 3)
    assert.deepEqual(events[0].filePaths, [ROOT + '/a.ts', ROOT + '/b.ts', ROOT + '/c.ts'])
  })
})

test('follows the most recently modified session even if it already existed before the watcher started', () => {
  const home = fakeHome()
  withFakeHome(home, () => {
    const dir = projectDirFor(home, ROOT)
    const existingFile = path.join(dir, 'already-running-session.jsonl')
    fs.writeFileSync(existingFile, readToolUseLine('Read', ROOT + '/already-open.ts') + '\n')

    sleepSync(30) // ensure a real, filesystem-observable time gap before start()

    const events = []
    const w = new TranscriptWatcher(ROOT, (step, filePaths) => events.push({ step, filePaths }))
    w.start() // the session file already existed before this call
    w.stop() // cancel the interval; we'll drive ticks manually from here

    assert.equal(
      events.length,
      1,
      'a session that was already the most recently active one should be picked up immediately, not ignored'
    )
    assert.deepEqual(events[0].filePaths, [ROOT + '/already-open.ts'])

    sleepSync(30)
    const newerFile = path.join(dir, 'newer-session.jsonl')
    fs.writeFileSync(newerFile, readToolUseLine('Read', ROOT + '/newer.ts') + '\n')
    w['tick']()

    assert.deepEqual(
      events.pop().filePaths,
      [ROOT + '/newer.ts'],
      'a regular rescan should switch to whichever session is now most recently modified'
    )
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

test('sessionFileOverride: does not fire events while the pinned file does not exist, and logs the wait only once', () => {
  const home = fakeHome()
  withFakeHome(home, () => {
    projectDirFor(home, ROOT) // project dir exists, but the pinned file does not
    const pinned = path.join(home, '.claude', 'projects', ROOT.replace(/\//g, '-'), 'pinned.jsonl')

    const events = []
    const sessionStarts = []
    const debugMessages = []
    const w = new TranscriptWatcher(
      ROOT,
      (step, filePaths) => events.push({ step, filePaths }),
      (message) => debugMessages.push(message),
      () => sessionStarts.push(true),
      400,
      pinned
    )
    w['tick']()
    w['tick']()
    w['tick']()

    assert.equal(events.length, 0, 'no events should fire while the pinned file does not exist')
    assert.equal(sessionStarts.length, 0)
    assert.equal(
      debugMessages.filter((m) => m.includes('not found yet')).length,
      1,
      'the "not found yet" debug line should log once, not once per tick'
    )
  })
})

test('sessionFileOverride: picks up the pinned file as soon as it appears and ignores other sessions', () => {
  const home = fakeHome()
  withFakeHome(home, () => {
    const dir = projectDirFor(home, ROOT)
    const pinned = path.join(dir, 'pinned.jsonl')
    const other = path.join(dir, 'other.jsonl')
    // A more-recently-active *other* session exists — the pin must ignore it.
    fs.writeFileSync(other, readToolUseLine('Read', ROOT + '/should-be-ignored.ts') + '\n')

    const events = []
    const sessionStarts = []
    const w = new TranscriptWatcher(
      ROOT,
      (step, filePaths) => events.push({ step, filePaths }),
      () => {},
      () => sessionStarts.push(true),
      400,
      pinned
    )
    w['tick']()
    assert.equal(events.length, 0, 'still nothing until the pinned file itself appears')

    fs.writeFileSync(pinned, readToolUseLine('Read', ROOT + '/pinned.ts') + '\n')
    w['tick']()

    assert.equal(events.length, 1)
    assert.deepEqual(events[0].filePaths, [ROOT + '/pinned.ts'])
    assert.equal(sessionStarts.length, 1, 'the pinned file appearing should fire onSessionStart once')
  })
})

test('finding the latest session scans every .jsonl file in the project directory on each tick', () => {
  // There's no longer a rejection cache to short-circuit repeat stats (the
  // old birthtime-cutoff mechanism that provided one was removed along with
  // the cutoff itself — the watcher now needs every file's current mtime on
  // every tick to correctly always follow whichever session is most
  // recently active). This just pins that every file really does get
  // checked, since a future change accidentally reintroducing skips would
  // silently break "switch to a session that predates the watcher" again.
  const home = fakeHome()
  withFakeHome(home, () => {
    const dir = projectDirFor(home, ROOT)

    const files = []
    for (let i = 0; i < 5; i++) {
      const f = path.join(dir, 'sess-' + i + '.jsonl')
      fs.writeFileSync(f, readToolUseLine('Read', ROOT + '/x.ts') + '\n')
      files.push(f)
    }

    const w = new TranscriptWatcher(ROOT, () => {})
    w.start()
    w.stop()

    const realStatSync = fs.statSync
    const statted = new Set()
    fs.statSync = (p, ...rest) => {
      if (files.includes(p)) statted.add(p)
      return realStatSync(p, ...rest)
    }
    try {
      w['tick']()
      assert.equal(statted.size, files.length, 'every session file should be considered on each tick')
    } finally {
      fs.statSync = realStatSync
    }
  })
})
