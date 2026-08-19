const test = require('node:test')
const assert = require('node:assert/strict')
const { runWebview, DISABLED_COLLAPSE_CONFIG } = require('./webviewLogic.harness.js')

// Mirrors what serializeHierarchyList() actually produces server-side: one
// entry per harness-root directory, parented to its nearest harness-root
// ANCESTOR (see hierarchy.ts) — a coarser index into the SAME tree `nodes`
// describes, not a second graph.

function isolateFixture() {
  const nodes = [
    { id: '/root', parentId: null, name: 'root', isDirectory: true, kind: 'harness-root' },
    { id: '/root/keep', parentId: '/root', name: 'keep', isDirectory: true, kind: 'group' },
    { id: '/root/keep/target', parentId: '/root/keep', name: 'target', isDirectory: true, kind: 'harness-root' },
    { id: '/root/keep/target/inner', parentId: '/root/keep/target', name: 'inner.ts', isDirectory: false, kind: 'file' },
    { id: '/root/other', parentId: '/root', name: 'other', isDirectory: true, kind: 'group' }
  ]
  for (let i = 0; i < 5; i++) {
    nodes.push({ id: '/root/other/x' + i, parentId: '/root/other', name: 'x' + i, isDirectory: false, kind: 'file' })
  }
  const harnessNodes = [
    { id: '/root', parentId: null, name: 'root', relPath: '.' },
    { id: '/root/keep/target', parentId: '/root', name: 'target', relPath: 'keep/target' }
  ]
  return { nodes, harnessNodes }
}

function nestedFixture() {
  const nodes = [
    { id: '/root', parentId: null, name: 'root', isDirectory: true, kind: 'harness-root' },
    { id: '/root/mid', parentId: '/root', name: 'mid', isDirectory: true, kind: 'group' },
    { id: '/root/mid/target', parentId: '/root/mid', name: 'target', isDirectory: true, kind: 'harness-root' }
  ]
  const harnessNodes = [
    { id: '/root', parentId: null, name: 'root', relPath: '.' },
    { id: '/root/mid/target', parentId: '/root', name: 'target', relPath: 'mid/target' }
  ]
  return { nodes, harnessNodes }
}

test('the Harnesses navigator renders one row per harness node, indented by harness-nesting depth (not file-tree depth)', () => {
  const { nodes, harnessNodes } = nestedFixture()
  const w = runWebview(nodes, DISABLED_COLLAPSE_CONFIG, harnessNodes)

  const rootRow = w.harnessRow('/root')
  const targetRow = w.harnessRow('/root/mid/target')
  assert.ok(rootRow, 'root harness should have a row')
  assert.ok(targetRow, 'nested harness should have a row')

  // root is depth 0, target is depth 1 in the HARNESS hierarchy even though
  // it's two levels deep in the real file tree (root -> mid -> target).
  assert.equal(rootRow.children[0].style.width, '0px')
  assert.equal(targetRow.children[0].style.width, '12px')
})

test('a virtual (synthetic) row has no Go To/Isolate buttons — it is not a real node', () => {
  const { nodes } = nestedFixture()
  const harnessNodes = [
    { id: '__virtual__', parentId: null, name: 'workspace', relPath: 'workspace', virtual: true },
    { id: '/root', parentId: '__virtual__', name: 'root', relPath: '.' }
  ]
  const w = runWebview(nodes, DISABLED_COLLAPSE_CONFIG, harnessNodes)

  const virtualRow = w.harnessRow('__virtual__')
  assert.ok(virtualRow, 'virtual row should still render as a label')
  const buttons = virtualRow.children.filter((c) => c.tag === 'button')
  assert.equal(buttons.length, 0, 'virtual row is not a real tree node, so no actions make sense on it')
})

test('Go To on a fully-visible harness selects it directly', () => {
  const { nodes, harnessNodes } = nestedFixture()
  const w = runWebview(nodes, DISABLED_COLLAPSE_CONFIG, harnessNodes)

  w.clickHarnessAction('/root/mid/target', 'goto')

  assert.equal(w.isSelectedNode('/root/mid/target'), true)
})

test('Go To on a harness with no children flashes just that one node — nothing to spread to', () => {
  const { nodes, harnessNodes } = nestedFixture()
  const w = runWebview(nodes, DISABLED_COLLAPSE_CONFIG, harnessNodes)

  w.clickHarnessAction('/root/mid/target', 'goto')

  assert.equal(w.flashElementCount(), 1, 'just the target\'s own ring — no edge flash for its own inbound edge')
})

test('Go To flashes the target\'s entire visible subtree, not just the target node itself', () => {
  const { nodes, harnessNodes } = isolateFixture()
  const w = runWebview(nodes, DISABLED_COLLAPSE_CONFIG, harnessNodes)

  w.clickHarnessAction('/root/keep/target', 'goto')

  // target + its one child 'inner' => 2 rings, plus 1 edge flash for the
  // child's edge (target's own inbound edge from 'keep' is deliberately
  // excluded — it leads outside the highlighted subtree).
  assert.equal(w.flashElementCount(), 3)
})

test('Go To on a harness hidden behind a collapsed ancestor selects that ancestor instead, without force-expanding it', () => {
  const { nodes, harnessNodes } = nestedFixture()
  const w = runWebview(nodes, DISABLED_COLLAPSE_CONFIG, harnessNodes)

  w.dblclickNode('/root/mid') // collapses 'mid', hiding 'target' beneath it
  assert.equal(w.isRendered('/root/mid/target'), false)

  w.clickHarnessAction('/root/mid/target', 'goto')

  assert.equal(w.isSelectedNode('/root/mid'), true, 'nearest visible ancestor should be selected')
  assert.equal(w.isRendered('/root/mid/target'), false, 'go to does not itself expand anything')
})

test('Isolate collapses every sibling branch off the path, keeps the path and target subtree visible', () => {
  const { nodes, harnessNodes } = isolateFixture()
  const w = runWebview(nodes, DISABLED_COLLAPSE_CONFIG, harnessNodes)

  w.clickHarnessAction('/root/keep/target', 'isolate')

  assert.equal(w.isCollapsedNode('/root/other'), true, 'sibling branch off the path should collapse')
  assert.equal(w.isRendered('/root/other/x0'), false)

  assert.equal(w.isCollapsedNode('/root/keep'), false, 'ancestor on the path must stay expanded')
  assert.equal(w.isRendered('/root/keep/target'), true)
  assert.equal(w.isRendered('/root/keep/target/inner'), true, "target's own subtree stays revealed")

  assert.equal(w.isSelectedNode('/root/keep/target'), true, 'isolate also goes to the target')
})

test('Isolating the root harness is a harmless no-op that just re-affirms the default view', () => {
  const { nodes, harnessNodes } = isolateFixture()
  const w = runWebview(nodes, DISABLED_COLLAPSE_CONFIG, harnessNodes)

  assert.doesNotThrow(() => w.clickHarnessAction('/root', 'isolate'))
  assert.equal(w.isSelectedNode('/root'), true)
})
