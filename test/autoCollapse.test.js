const test = require('node:test')
const assert = require('node:assert/strict')
const { runWebview } = require('./webviewLogic.harness.js')

// A harness shaped like: root -> a (depth 1) -> a/deep (depth 2) -> a/deep/x0..x49 (depth 3, files).
// Deep enough and wide enough to exercise depth caps, per-directory child-count
// caps, and the global node-count cap independently.
function buildDeepWideNodes() {
  const nodes = [
    { id: '/root', parentId: null, name: 'root', isDirectory: true, kind: 'harness-root' },
    { id: '/root/a', parentId: '/root', name: 'a', isDirectory: true, kind: 'group' },
    { id: '/root/a/deep', parentId: '/root/a', name: 'deep', isDirectory: true, kind: 'group' },
    { id: '/root/b', parentId: '/root', name: 'b.ts', isDirectory: false, kind: 'file' }
  ]
  for (let i = 0; i < 50; i++) {
    nodes.push({
      id: '/root/a/deep/x' + i,
      parentId: '/root/a/deep',
      name: 'x' + i + '.ts',
      isDirectory: false,
      kind: 'file'
    })
  }
  return nodes
}

test('maxDepth auto-collapses the directory sitting exactly at the configured depth', () => {
  // maxDepth:1 means depth 0 (root) and depth 1 (a) can be visible, but the
  // depth-1 directory itself becomes the collapse boundary — so nothing at
  // depth 2+ (deep, and everything under it) is ever rendered at all.
  const nodes = buildDeepWideNodes()
  const w = runWebview(nodes, {
    maxDepth: 1,
    maxNodesBeforeCollapse: 1e9,
    maxChildrenBeforeCollapse: 1e9,
    maxNodesOnExpand: 1e9
  })
  assert.equal(w.isRendered('/root'), true)
  assert.equal(w.isRendered('/root/a'), true, 'a (depth 1, the boundary) still renders, just collapsed')
  assert.equal(w.isCollapsedNode('/root/a'), true)
  assert.equal(w.isRendered('/root/a/deep'), false, 'depth 2 is past the cap, never rendered')
  assert.equal(w.isRendered('/root/a/deep/x0'), false)
})

test('maxChildrenBeforeCollapse auto-collapses a directory with too many direct children, regardless of depth', () => {
  const nodes = buildDeepWideNodes()
  const w = runWebview(nodes, {
    maxDepth: 1e9,
    maxNodesBeforeCollapse: 1e9,
    maxChildrenBeforeCollapse: 10, // deep/ has 50 children, well over this
    maxNodesOnExpand: 1e9
  })
  assert.equal(w.isCollapsedNode('/root/a/deep'), true)
  assert.equal(w.isRendered('/root/a/deep/x0'), false)
  // 'a' itself only has one child (deep/), so it stays expanded.
  assert.equal(w.isCollapsedNode('/root/a'), false)
})

test('a directory under both caps stays expanded', () => {
  const nodes = buildDeepWideNodes()
  const w = runWebview(nodes, {
    maxDepth: 1e9,
    maxNodesBeforeCollapse: 1e9,
    maxChildrenBeforeCollapse: 1e9,
    maxNodesOnExpand: 1e9
  })
  assert.equal(w.isCollapsedNode('/root/a/deep'), false)
  assert.equal(w.isRendered('/root/a/deep/x0'), true)
  assert.equal(w.renderedNodeIds().length, nodes.length)
})

test('maxNodesBeforeCollapse collapses enough of the tree to bring total visible nodes under the cap', () => {
  const nodes = buildDeepWideNodes()
  const w = runWebview(nodes, {
    maxDepth: 1e9,
    maxNodesBeforeCollapse: 10,
    maxChildrenBeforeCollapse: 1e9,
    maxNodesOnExpand: 1e9
  })
  assert.ok(w.renderedNodeIds().length <= 10, 'visible node count must respect the global cap')
  assert.equal(w.isRendered('/root'), true, 'the root itself always stays visible')
})

// collapseToFit() (used by both the initial auto-collapse and expand-cap
// logic) can only reduce a subtree's visible count by collapsing *nested
// directories* within it — a directory whose children are all flat files has
// nothing further inside it to hide, so maxNodesOnExpand can't partially
// reveal a flat run of files (maxChildrenBeforeCollapse is what keeps such a
// directory from auto-expanding in the first place; once a user forces it
// open, all of its direct file children come with it). This fixture nests
// each file inside its own single-file directory so there's something for
// the cap to actually act on.
function buildNestedDirsNodes() {
  const nodes = [
    { id: '/root', parentId: null, name: 'root', isDirectory: true, kind: 'harness-root' },
    { id: '/root/a', parentId: '/root', name: 'a', isDirectory: true, kind: 'group' },
    { id: '/root/a/deep', parentId: '/root/a', name: 'deep', isDirectory: true, kind: 'group' }
  ]
  for (let i = 0; i < 50; i++) {
    const dirId = '/root/a/deep/d' + i
    nodes.push({ id: dirId, parentId: '/root/a/deep', name: 'd' + i, isDirectory: true, kind: 'group' })
    nodes.push({ id: dirId + '/c.ts', parentId: dirId, name: 'c.ts', isDirectory: false, kind: 'file' })
  }
  return nodes
}

test('expanding an auto-collapsed directory re-collapses enough of it to respect maxNodesOnExpand', () => {
  const nodes = buildNestedDirsNodes()
  const w = runWebview(nodes, {
    maxDepth: 1e9,
    maxNodesBeforeCollapse: 1e9,
    maxChildrenBeforeCollapse: 10, // deep/ (50 subdirectories) starts auto-collapsed
    maxNodesOnExpand: 5 // but expanding it can only reveal 5 nodes' worth
  })
  assert.equal(w.isCollapsedNode('/root/a/deep'), true)

  w.dblclickNode('/root/a/deep')

  // deep/ itself is no longer collapsed (the user explicitly expanded it)...
  assert.equal(w.isCollapsedNode('/root/a/deep'), false)
  // ...but its 50 subdirectories can't all fit under the cap of 5, so most
  // stay collapsed rather than dumping the whole subtree onto the canvas.
  const visibleSubdirCount = nodes
    .filter((n) => n.parentId === '/root/a/deep')
    .filter((n) => w.isRendered(n.id)).length
  assert.equal(visibleSubdirCount, 50, 'the subdirectories themselves are still all revealed...')
  const stillCollapsedCount = nodes
    .filter((n) => n.parentId === '/root/a/deep')
    .filter((n) => w.isCollapsedNode(n.id)).length
  assert.ok(stillCollapsedCount > 0, '...but most of them stay collapsed so their file stays hidden')
})

test('expanding a small collapsed directory that fits under maxNodesOnExpand reveals everything', () => {
  const nodes = buildDeepWideNodes()
  const w = runWebview(nodes, {
    maxDepth: 1e9,
    maxNodesBeforeCollapse: 1e9,
    maxChildrenBeforeCollapse: 10,
    maxNodesOnExpand: 1e9
  })
  w.dblclickNode('/root/a/deep')
  assert.equal(w.isCollapsedNode('/root/a/deep'), false)
  for (let i = 0; i < 50; i++) {
    assert.equal(w.isRendered('/root/a/deep/x' + i), true)
  }
})

test('the "Expand 1 layer" info-panel button reveals only direct children, not grandchildren', () => {
  const nodes = [
    { id: '/root', parentId: null, name: 'root', isDirectory: true, kind: 'harness-root' },
    { id: '/root/a', parentId: '/root', name: 'a', isDirectory: true, kind: 'group' },
    { id: '/root/a/b', parentId: '/root/a', name: 'b', isDirectory: true, kind: 'group' },
    { id: '/root/a/b/c.ts', parentId: '/root/a/b', name: 'c.ts', isDirectory: false, kind: 'file' }
  ]
  const w = runWebview(nodes)
  w.dblclickNode('/root/a') // collapse a/
  assert.equal(w.isCollapsedNode('/root/a'), true)

  w.clickNode('/root/a') // select it so the info panel renders its buttons
  w.clickButton('expandLayerBtn2')

  assert.equal(w.isRendered('/root/a/b'), true, 'direct child revealed')
  assert.equal(w.isCollapsedNode('/root/a/b'), true, 'but b/ itself is left collapsed')
  assert.equal(w.isRendered('/root/a/b/c.ts'), false, 'grandchild stays hidden')
})

test('the global "+1 layer" toolbar button expands every collapsed node by exactly one level', () => {
  const nodes = [
    { id: '/root', parentId: null, name: 'root', isDirectory: true, kind: 'harness-root' },
    { id: '/root/a', parentId: '/root', name: 'a', isDirectory: true, kind: 'group' },
    { id: '/root/a/b', parentId: '/root/a', name: 'b', isDirectory: true, kind: 'group' },
    { id: '/root/a/b/c.ts', parentId: '/root/a/b', name: 'c.ts', isDirectory: false, kind: 'file' }
  ]
  const w = runWebview(nodes)
  w.dblclickNode('/root/a')
  assert.equal(w.isRendered('/root/a/b'), false)

  w.clickButton('expandLayerBtn')

  assert.equal(w.isRendered('/root/a/b'), true)
  assert.equal(w.isCollapsedNode('/root/a/b'), true)
  assert.equal(w.isRendered('/root/a/b/c.ts'), false)
})

test('the "-1" toolbar button collapses the deepest still-expanded directory in a branch', () => {
  // root -> a -> deep -> 50 files. deep's children are all files (no
  // sub-directories), so deep itself is the frontier: the deepest point
  // where you can still see branching. -1 should collapse exactly deep,
  // not a (a still has an expanded child directory — deep — before this
  // click, so it isn't a frontier candidate yet).
  const nodes = buildDeepWideNodes()
  const w = runWebview(nodes)
  assert.equal(w.renderedNodeIds().length, nodes.length, 'starts fully expanded (disabled config)')

  w.clickButton('collapseLayerBtn')

  assert.equal(w.isCollapsedNode('/root/a/deep'), true)
  assert.equal(w.isRendered('/root/a/deep/x0'), false)
  assert.equal(w.isCollapsedNode('/root/a'), false, 'a is not yet the frontier — deep still was, until this click')
  assert.equal(w.isRendered('/root/a'), true)
})

test('"-1" pulls the frontier in one more level each time, eventually reaching the root', () => {
  const nodes = buildDeepWideNodes()
  const w = runWebview(nodes)

  w.clickButton('collapseLayerBtn') // collapses deep
  assert.equal(w.isCollapsedNode('/root/a/deep'), true)

  w.clickButton('collapseLayerBtn') // a's only child dir (deep) is now collapsed, so a becomes the frontier
  assert.equal(w.isCollapsedNode('/root/a'), true)
  assert.equal(w.isRendered('/root/a/deep'), false)

  w.clickButton('collapseLayerBtn') // root's only child dir (a) is now collapsed, so root becomes the frontier
  assert.equal(w.isCollapsedNode('/root'), true)
  assert.equal(w.isRendered('/root/a'), false)

  const beforeIds = w.renderedNodeIds()
  w.clickButton('collapseLayerBtn') // nothing left to collapse — a harmless no-op
  assert.deepEqual(w.renderedNodeIds(), beforeIds)
})

test('"-1" only collapses the tree\'s single greatest depth, leaving shallower branches untouched until deeper ones catch up', () => {
  const nodes = [
    { id: '/root', parentId: null, name: 'root', isDirectory: true, kind: 'harness-root' },
    { id: '/root/A', parentId: '/root', name: 'A', isDirectory: true, kind: 'group' },
    { id: '/root/A/A1', parentId: '/root/A', name: 'A1', isDirectory: true, kind: 'group' },
    { id: '/root/A/A1/leaf.ts', parentId: '/root/A/A1', name: 'leaf.ts', isDirectory: false, kind: 'file' },
    { id: '/root/B', parentId: '/root', name: 'B', isDirectory: true, kind: 'group' },
    { id: '/root/B/leaf.ts', parentId: '/root/B', name: 'leaf.ts', isDirectory: false, kind: 'file' }
  ]
  const w = runWebview(nodes)

  w.clickButton('collapseLayerBtn')

  // A1 (depth 2) is the tree's single deepest frontier, so only it collapses
  // this round — B (depth 1) is also a frontier candidate (it has no
  // sub-directories) but is shallower, so it's left alone.
  assert.equal(w.isCollapsedNode('/root/A/A1'), true)
  assert.equal(w.isCollapsedNode('/root/B'), false, 'B is shallower than A1, so it waits its turn')
  assert.equal(w.isRendered('/root/B/leaf.ts'), true)

  w.clickButton('collapseLayerBtn')

  // A1 is now collapsed, so A (depth 1) becomes a frontier candidate — tied
  // in depth with B (also depth 1) — so this round collapses both together.
  assert.equal(w.isCollapsedNode('/root/A'), true)
  assert.equal(w.isCollapsedNode('/root/B'), true)
})

test('"+1" only expands the tree\'s single shallowest collapsed layer, leaving deeper collapsed nodes untouched until shallower ones catch up', () => {
  const nodes = [
    { id: '/root', parentId: null, name: 'root', isDirectory: true, kind: 'harness-root' },
    { id: '/root/A', parentId: '/root', name: 'A', isDirectory: true, kind: 'group' },
    { id: '/root/A/A1', parentId: '/root/A', name: 'A1', isDirectory: true, kind: 'group' },
    { id: '/root/A/A1/leaf.ts', parentId: '/root/A/A1', name: 'leaf.ts', isDirectory: false, kind: 'file' },
    { id: '/root/B', parentId: '/root', name: 'B', isDirectory: true, kind: 'group' },
    { id: '/root/B/B1', parentId: '/root/B', name: 'B1', isDirectory: true, kind: 'group' },
    { id: '/root/B/B1/leaf.ts', parentId: '/root/B/B1', name: 'leaf.ts', isDirectory: false, kind: 'file' }
  ]
  const w = runWebview(nodes)

  // Manually collapse two nodes at different depths: A (depth 1) and B1
  // (depth 2) — a state -1 itself would never produce in one click, but
  // exercises the +1 side of the same depth-sync invariant directly.
  w.dblclickNode('/root/A')
  w.dblclickNode('/root/B/B1')
  assert.equal(w.isCollapsedNode('/root/A'), true)
  assert.equal(w.isCollapsedNode('/root/B/B1'), true)

  w.clickButton('expandLayerBtn')

  // A (depth 1) is the shallowest collapsed node, so only it expands —
  // revealing A1, itself freshly collapsed one level down (depth 2).
  // B1 (already depth 2) is left untouched this round.
  assert.equal(w.isCollapsedNode('/root/A'), false)
  assert.equal(w.isRendered('/root/A/A1'), true)
  assert.equal(w.isCollapsedNode('/root/A/A1'), true)
  assert.equal(w.isCollapsedNode('/root/B/B1'), true, 'B1 was already at depth 2, deeper than this round\'s target — left alone')
  assert.equal(w.isRendered('/root/B/B1/leaf.ts'), false)

  w.clickButton('expandLayerBtn')

  // A1 and B1 are now tied at depth 2, the new shallowest collapsed depth,
  // so this round expands both together.
  assert.equal(w.isCollapsedNode('/root/A/A1'), false)
  assert.equal(w.isCollapsedNode('/root/B/B1'), false)
  assert.equal(w.isRendered('/root/A/A1/leaf.ts'), true)
  assert.equal(w.isRendered('/root/B/B1/leaf.ts'), true)
})

test('"+1" and "-1" are inverses on a simple tree', () => {
  const nodes = [
    { id: '/root', parentId: null, name: 'root', isDirectory: true, kind: 'harness-root' },
    { id: '/root/a', parentId: '/root', name: 'a', isDirectory: true, kind: 'group' },
    { id: '/root/a/b', parentId: '/root/a', name: 'b', isDirectory: true, kind: 'group' },
    { id: '/root/a/b/c.ts', parentId: '/root/a/b', name: 'c.ts', isDirectory: false, kind: 'file' }
  ]
  const w = runWebview(nodes)
  const fullyExpanded = w.renderedNodeIds().slice().sort()

  w.clickButton('collapseLayerBtn')
  w.clickButton('expandLayerBtn')

  assert.deepEqual(w.renderedNodeIds().slice().sort(), fullyExpanded)
})

test('the settings toolbar button asks the host to open settings', () => {
  const nodes = buildDeepWideNodes()
  const w = runWebview(nodes)
  w.clickButton('settingsBtn')
  const opens = w.postedMessages.filter((m) => m.type === 'openSettings')
  assert.equal(opens.length, 1)
})
