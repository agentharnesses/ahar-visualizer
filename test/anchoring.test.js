const test = require('node:test')
const assert = require('node:assert/strict')
const { runWebview } = require('./webviewLogic.harness.js')

// root -> bushy/ (10 file leaves) and root -> lonely.ts (one file leaf).
// bushy/'s leaf count dominates the tidy-tree layout, so collapsing it
// drastically changes root's own logical x (root.x is the average of its
// children's x, and bushy's x is itself the average of ITS 10 leaves' x) —
// exactly the kind of layout swing that used to make the whole graph jump
// sideways on a single collapse/expand click.
function buildLopsidedNodes() {
  const nodes = [
    { id: '/root', parentId: null, name: 'root', isDirectory: true, kind: 'harness-root' },
    { id: '/root/bushy', parentId: '/root', name: 'bushy', isDirectory: true, kind: 'group' },
    { id: '/root/lonely.ts', parentId: '/root', name: 'lonely.ts', isDirectory: false, kind: 'file' }
  ]
  for (let i = 0; i < 10; i++) {
    nodes.push({
      id: '/root/bushy/f' + i,
      parentId: '/root/bushy',
      name: 'f' + i + '.ts',
      isDirectory: false,
      kind: 'file'
    })
  }
  return nodes
}

test('collapsing a lopsided subtree keeps the root visually anchored on screen', () => {
  const nodes = buildLopsidedNodes()
  const w = runWebview(nodes)
  const before = w.nodeScreenX('/root')

  w.dblclickNode('/root/bushy')

  assert.equal(w.isCollapsedNode('/root/bushy'), true)
  assert.equal(w.nodeScreenX('/root'), before, 'root must not visibly shift when a sibling subtree collapses')
})

test('re-expanding it afterward keeps the root anchored too', () => {
  const nodes = buildLopsidedNodes()
  const w = runWebview(nodes)
  const before = w.nodeScreenX('/root')

  w.dblclickNode('/root/bushy')
  w.dblclickNode('/root/bushy') // expand again

  assert.equal(w.isCollapsedNode('/root/bushy'), false)
  assert.equal(w.nodeScreenX('/root'), before)
})

test('the global "-1" / "+1" toolbar actions keep the root anchored too, not just per-node toggling', () => {
  const nodes = buildLopsidedNodes()
  const w = runWebview(nodes)
  const before = w.nodeScreenX('/root')

  w.clickButton('collapseLayerBtn') // collapses bushy (its children are all files)
  assert.equal(w.isCollapsedNode('/root/bushy'), true)
  assert.equal(w.nodeScreenX('/root'), before)

  w.clickButton('expandLayerBtn')
  assert.equal(w.isCollapsedNode('/root/bushy'), false)
  assert.equal(w.nodeScreenX('/root'), before)
})

test('a node other than root shifts freely — only root itself is anchored', () => {
  // lonely.ts's own screen position is a side effect of the layout, not
  // something this feature promises to hold fixed — only root is anchored.
  // This just confirms the anchoring math is actually doing something
  // (shifting tx) rather than coincidentally leaving everything untouched.
  const nodes = buildLopsidedNodes()
  const w = runWebview(nodes)
  const lonelyBefore = w.nodeScreenX('/root/lonely.ts')

  w.dblclickNode('/root/bushy')

  assert.notEqual(w.nodeScreenX('/root/lonely.ts'), lonelyBefore)
})
