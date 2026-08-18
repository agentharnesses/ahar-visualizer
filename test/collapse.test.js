const test = require('node:test')
const assert = require('node:assert/strict')
const { runWebview } = require('./webviewLogic.harness.js')

// A directory ('a') with a large number of descendants, to make "collapsing
// hides them and never touches them" a meaningful check rather than a
// coincidence of a tiny fixture. 200 is arbitrary but large enough that any
// accidental O(subtree) traversal into the collapsed branch would still
// leave clearly-visible artifacts (200 extra rendered elements, a slow test,
// etc.) if the "skip collapsed subtrees" logic were broken.
const SUBTREE_SIZE = 200

function buildNodes() {
  const nodes = [
    { id: '/root', parentId: null, name: 'root', isDirectory: true, kind: 'harness-root' },
    { id: '/root/a', parentId: '/root', name: 'a', isDirectory: true, kind: 'group' },
    { id: '/root/b', parentId: '/root', name: 'b.ts', isDirectory: false, kind: 'file' },
    { id: '/root/empty', parentId: '/root', name: 'empty', isDirectory: true, kind: 'group' }
  ]
  for (let i = 0; i < SUBTREE_SIZE; i++) {
    nodes.push({
      id: '/root/a/x' + i,
      parentId: '/root/a',
      name: 'x' + i + '.ts',
      isDirectory: false,
      kind: 'file'
    })
  }
  return nodes
}

const NODES = buildNodes()

test('everything renders by default (nothing collapsed)', () => {
  const w = runWebview(NODES)
  assert.equal(w.renderedNodeIds().length, NODES.length)
  assert.equal(w.renderedEdgeCount(), NODES.length - 1) // every node but root has one edge
})

test('double-clicking a directory with children collapses it and hides its subtree', () => {
  const w = runWebview(NODES)
  assert.equal(w.isRendered('/root/a/x0'), true)

  w.dblclickNode('/root/a')

  assert.equal(w.isCollapsedNode('/root/a'), true)
  assert.equal(w.isRendered('/root/a/x0'), false, 'a hidden descendant must not be rendered at all')
  assert.equal(w.isRendered('/root/a/x' + (SUBTREE_SIZE - 1)), false)
  // The collapsed node itself, and everything NOT under it, stays visible.
  assert.equal(w.isRendered('/root/a'), true)
  assert.equal(w.isRendered('/root'), true)
  assert.equal(w.isRendered('/root/b'), true)
  // Exactly the 200 hidden descendants are gone from the render — nothing
  // more, nothing less.
  assert.equal(w.renderedNodeIds().length, NODES.length - SUBTREE_SIZE)
})

test('double-clicking a collapsed directory again re-expands it', () => {
  const w = runWebview(NODES)
  w.dblclickNode('/root/a')
  assert.equal(w.isRendered('/root/a/x5'), false)

  w.dblclickNode('/root/a')

  assert.equal(w.isCollapsedNode('/root/a'), false)
  assert.equal(w.isRendered('/root/a/x5'), true)
  assert.equal(w.renderedNodeIds().length, NODES.length)
})

test('double-clicking a directory with no children is a harmless no-op', () => {
  const w = runWebview(NODES)
  assert.doesNotThrow(() => w.dblclickNode('/root/empty'))
  assert.equal(w.renderedNodeIds().length, NODES.length, 'nothing should have changed')
})

test('double-clicking a file opens it instead of toggling anything', () => {
  const w = runWebview(NODES)
  // The panel always posts one 'clientDebug' message on load ("panel script
  // loaded...") before anything else happens — not what this test cares
  // about, so filter to the message type actually under test.
  w.dblclickNode('/root/b')
  // Messages cross a vm.createContext() realm boundary, so compare fields
  // individually rather than with deepEqual (objects from a different
  // realm have a different Object.prototype and can fail identity-ish
  // deep-equality checks even with identical shape/values).
  const opens = w.postedMessages.filter((m) => m.type === 'openFile')
  assert.equal(opens.length, 1)
  assert.equal(opens[0].type, 'openFile')
  assert.equal(opens[0].path, '/root/b')
  assert.equal(w.renderedNodeIds().length, NODES.length, 'nothing in the tree should have changed')
})

test('a touch inside a collapsed subtree still registers, and the collapsed node\'s bar reflects it', () => {
  const w = runWebview(NODES)
  w.dblclickNode('/root/a')
  assert.equal(w.collapseIndicatorOpacity('/root/a'), 0, 'nothing touched yet, bar should be off')

  // x7 is hidden (not rendered) but the touch must still be tracked —
  // freshness lives in a plain JS Map keyed by id, entirely independent of
  // whether that id currently has a DOM element.
  w.sendStep(1, ['/root/a/x7'])

  assert.equal(w.collapseIndicatorOpacity('/root/a'), 1, 'bar should reflect the hidden touch at full freshness')

  w.sendStep(21, []) // halfway through the 40-step decay window
  assert.equal(w.collapseIndicatorOpacity('/root/a'), 0.5)
})

test('the collapse indicator bar only exists while the node is actually collapsed', () => {
  const w = runWebview(NODES)
  assert.equal(w.collapseIndicatorOpacity('/root/a'), null, 'no bar when expanded')
  w.dblclickNode('/root/a')
  assert.notEqual(w.collapseIndicatorOpacity('/root/a'), null, 'bar appears once collapsed')
  w.dblclickNode('/root/a')
  assert.equal(w.collapseIndicatorOpacity('/root/a'), null, 'bar disappears again once expanded')
})

test('collapsing one directory does not affect an unrelated sibling', () => {
  const w = runWebview(NODES)
  w.dblclickNode('/root/a')
  assert.equal(w.isRendered('/root/b'), true)
  assert.equal(w.isCollapsedNode('/root/a'), true)
  // /root/empty has no children, so it was never eligible to be "collapsed"
  // in the first place — just confirming collapsing 'a' didn't spuriously
  // mark it.
  assert.doesNotThrow(() => w.dblclickNode('/root/empty'))
})
