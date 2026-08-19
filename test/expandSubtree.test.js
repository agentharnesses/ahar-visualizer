// Regression coverage for "Expand subtree" (both the double-click toggle and
// the info panel's button, which share expandWithinCap()): a child directory
// collapsed independently of its ancestor used to survive that ancestor's
// own collapse-then-expand cycle, because collapseToFit()'s traversal
// stopped at any already-collapsed descendant and never revisited it.
// expandWithinCap() now clears the whole subtree first (clearCollapsedSubtree)
// before re-applying the maxNodesOnExpand cap, so "expand subtree" really
// means everything under it, not "everything except whatever happened to
// already be collapsed".

const test = require('node:test')
const assert = require('node:assert/strict')
const { runWebview } = require('./webviewLogic.harness.js')

function buildNodes() {
  return [
    { id: '/root', parentId: null, name: 'root', isDirectory: true, kind: 'harness-root' },
    { id: '/root/parent', parentId: '/root', name: 'parent', isDirectory: true, kind: 'group' },
    { id: '/root/parent/childDir', parentId: '/root/parent', name: 'childDir', isDirectory: true, kind: 'group' },
    { id: '/root/parent/childDir/leaf0', parentId: '/root/parent/childDir', name: 'leaf0.ts', isDirectory: false, kind: 'file' },
    { id: '/root/parent/childDir/leaf1', parentId: '/root/parent/childDir', name: 'leaf1.ts', isDirectory: false, kind: 'file' },
    { id: '/root/parent/siblingLeaf', parentId: '/root/parent', name: 'siblingLeaf.ts', isDirectory: false, kind: 'file' },
    { id: '/root/other', parentId: '/root', name: 'other.ts', isDirectory: false, kind: 'file' }
  ]
}

test('double-click "expand subtree" also expands a child that was collapsed independently', () => {
  const w = runWebview(buildNodes())

  w.dblclickNode('/root/parent/childDir') // user collapses the child on its own first
  assert.equal(w.isCollapsedNode('/root/parent/childDir'), true)

  w.dblclickNode('/root/parent') // then collapses the parent too (hides everything under it)
  assert.equal(w.isCollapsedNode('/root/parent'), true)

  w.dblclickNode('/root/parent') // "expand subtree": re-expand the parent

  assert.equal(w.isCollapsedNode('/root/parent'), false)
  assert.equal(w.isCollapsedNode('/root/parent/childDir'), false, 'a child collapsed independently must not survive the parent\'s own expand')
  assert.equal(w.isRendered('/root/parent/childDir/leaf0'), true)
  assert.equal(w.isRendered('/root/parent/childDir/leaf1'), true)
  assert.equal(w.isRendered('/root/parent/siblingLeaf'), true)
})

test('the info panel\'s "Expand subtree" button has the same behavior as the double-click toggle', () => {
  const w = runWebview(buildNodes())

  w.dblclickNode('/root/parent/childDir')
  w.dblclickNode('/root/parent')
  assert.equal(w.isCollapsedNode('/root/parent'), true)

  w.clickNode('/root/parent') // select it so the info panel (and its button) exist
  w.clickButton('collapseBtn') // labeled "Expand subtree" while parent is collapsed

  assert.equal(w.isCollapsedNode('/root/parent'), false)
  assert.equal(w.isCollapsedNode('/root/parent/childDir'), false)
  assert.equal(w.isRendered('/root/parent/childDir/leaf0'), true)
})

test('expanding a subtree with a very small cap still respects it, even after clearing prior independent collapses', () => {
  const config = { maxDepth: 1e9, maxNodesBeforeCollapse: 1e9, maxChildrenBeforeCollapse: 1e9, maxNodesOnExpand: 4 }
  const nodes = [
    { id: '/root', parentId: null, name: 'root', isDirectory: true, kind: 'harness-root' },
    { id: '/root/parent', parentId: '/root', name: 'parent', isDirectory: true, kind: 'group' },
    { id: '/root/parent/childDir', parentId: '/root/parent', name: 'childDir', isDirectory: true, kind: 'group' }
  ]
  for (let i = 0; i < 5; i++) {
    nodes.push({ id: '/root/parent/childDir/g' + i, parentId: '/root/parent/childDir', name: 'g' + i, isDirectory: true, kind: 'group' })
    nodes.push({ id: '/root/parent/childDir/g' + i + '/leaf', parentId: '/root/parent/childDir/g' + i, name: 'leaf.ts', isDirectory: false, kind: 'file' })
  }
  const w = runWebview(nodes, config)

  w.dblclickNode('/root/parent/childDir') // independent collapse
  assert.equal(w.isCollapsedNode('/root/parent/childDir'), true)
  w.dblclickNode('/root/parent') // then collapse the parent too
  assert.equal(w.isCollapsedNode('/root/parent'), true)

  w.dblclickNode('/root/parent') // "expand subtree" on parent

  assert.equal(w.isCollapsedNode('/root/parent'), false, 'the node the user actually asked to expand must never stay collapsed')
  // The 12-node subtree under parent can't all fit under a cap of 4 — some
  // deep directory must still end up collapsed, proving the cap survived
  // being cleared and reapplied fresh rather than being bypassed.
  assert.ok(w.renderedNodeIds().length < nodes.length, 'the small maxNodesOnExpand cap should still re-collapse something')
})

test('expanding a subtree does not disturb an unrelated sibling\'s own collapse state', () => {
  const nodes = buildNodes()
  nodes.push({ id: '/root/otherDir', parentId: '/root', name: 'otherDir', isDirectory: true, kind: 'group' })
  nodes.push({ id: '/root/otherDir/x', parentId: '/root/otherDir', name: 'x.ts', isDirectory: false, kind: 'file' })
  const w = runWebview(nodes)

  w.dblclickNode('/root/otherDir') // collapsed, and unrelated to 'parent'
  w.dblclickNode('/root/parent/childDir')
  w.dblclickNode('/root/parent')

  w.dblclickNode('/root/parent') // expand subtree on parent only

  assert.equal(w.isCollapsedNode('/root/otherDir'), true, 'a sibling subtree\'s own collapse state must be untouched')
})
