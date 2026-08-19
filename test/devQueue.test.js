const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { DevQueueWatcher } = require('../out/devQueue.js')

function fakeQueueDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ahar-devqueue-test-'))
}

test('start() creates the queue dir and writes an initial heartbeat', () => {
  const dir = fakeQueueDir()
  const queueDir = path.join(dir, 'nested', 'queue')
  const w = new DevQueueWatcher(queueDir, () => {})
  w.start()
  w.stop()

  assert.ok(fs.existsSync(queueDir), 'queue dir should be created, including missing parents')
  assert.ok(fs.existsSync(path.join(queueDir, '.heartbeat')), 'heartbeat should be written on start')
})

test('tick() touches the heartbeat file with a fresh timestamp every call', () => {
  const dir = fakeQueueDir()
  const w = new DevQueueWatcher(dir, () => {})
  w.start()
  w.stop()

  const heartbeatPath = path.join(dir, '.heartbeat')
  const first = fs.readFileSync(heartbeatPath, 'utf8')

  w['tick']()
  const second = fs.readFileSync(heartbeatPath, 'utf8')

  assert.ok(Number(second) >= Number(first), 'heartbeat timestamp should not go backwards')
})

test('processes a valid request file and deletes it', () => {
  const dir = fakeQueueDir()
  const requests = []
  const w = new DevQueueWatcher(dir, (req) => requests.push(req))
  w.start()
  w.stop()

  const file = path.join(dir, 'req1.json')
  fs.writeFileSync(file, JSON.stringify({ rootPath: '/some/dir', sessionFile: '/some/session.jsonl', label: 'test' }))
  w['tick']()

  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0], { rootPath: '/some/dir', sessionFile: '/some/session.jsonl', label: 'test' })
  assert.equal(fs.existsSync(file), false, 'processed request file should be removed')
})

test('processes multiple request files in filename order', () => {
  const dir = fakeQueueDir()
  const requests = []
  const w = new DevQueueWatcher(dir, (req) => requests.push(req.rootPath))
  w.start()
  w.stop()

  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ rootPath: '/b' }))
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ rootPath: '/a' }))
  w['tick']()

  assert.deepEqual(requests, ['/a', '/b'])
})

test('a malformed JSON file is dropped, not reprocessed, and does not throw', () => {
  const dir = fakeQueueDir()
  const requests = []
  const w = new DevQueueWatcher(dir, (req) => requests.push(req))
  w.start()
  w.stop()

  const file = path.join(dir, 'bad.json')
  fs.writeFileSync(file, '{ not valid json')
  w['tick']()

  assert.equal(requests.length, 0)
  assert.equal(fs.existsSync(file), false, 'malformed file should still be removed so it is not retried forever')
})

test('a request missing rootPath is dropped', () => {
  const dir = fakeQueueDir()
  const requests = []
  const w = new DevQueueWatcher(dir, (req) => requests.push(req))
  w.start()
  w.stop()

  fs.writeFileSync(path.join(dir, 'no-root.json'), JSON.stringify({ label: 'oops' }))
  w['tick']()

  assert.equal(requests.length, 0)
})

test('non-.json files in the queue dir are ignored', () => {
  const dir = fakeQueueDir()
  const requests = []
  const w = new DevQueueWatcher(dir, (req) => requests.push(req))
  w.start()
  w.stop()

  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello')
  w['tick']()

  assert.equal(requests.length, 0)
  assert.ok(fs.existsSync(path.join(dir, 'notes.txt')), 'non-.json files should be left alone')
})

test('a missing queue dir on tick() does not throw', () => {
  const dir = fakeQueueDir()
  const missing = path.join(dir, 'does-not-exist')
  const w = new DevQueueWatcher(missing, () => {})
  assert.doesNotThrow(() => w['tick']())
})
