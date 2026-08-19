// Covers applyNodesUpdate() — the client-side handler for a 'nodesUpdate'
// message, which is how refresh() (the refresh button, the live workspace
// file watcher, and a settings change) now updates an already-running panel
// instead of the extension host replacing the whole webview HTML. The point
// of doing it this way is everything a full reload used to reset: the
// legend/harness-navigator open/closed state, pan/zoom, and manual
// collapse/expand — see anchoring.test.js for the pre-existing root-anchor
// mechanism this reuses for free.

const test = require('node:test')
const assert = require('node:assert/strict')
const { runWebview } = require('./webviewLogic.harness.js')

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

test('a nodesUpdate does not reset the legend or harness-navigator open/closed state', () => {
  const w = runWebview(buildLopsidedNodes())

  w.clickButton('legendHeader')
  w.clickButton('harnessListHeader')
  assert.equal(w.hasClass('legendBody', 'collapsed'), true)
  assert.equal(w.hasClass('harnessListBody', 'collapsed'), true)

  w.sendNodesUpdate(buildLopsidedNodes())

  assert.equal(w.hasClass('legendBody', 'collapsed'), true, 'legend must stay collapsed across a refresh')
  assert.equal(w.hasClass('harnessListBody', 'collapsed'), true, 'harness navigator must stay collapsed across a refresh')
})

test('a nodesUpdate preserves a manual collapse/expand decision on an unchanged node', () => {
  const w = runWebview(buildLopsidedNodes())

  w.dblclickNode('/root/bushy')
  assert.equal(w.isCollapsedNode('/root/bushy'), true)

  w.sendNodesUpdate(buildLopsidedNodes()) // same tree, e.g. an unrelated file elsewhere changed

  assert.equal(w.isCollapsedNode('/root/bushy'), true, 'a refresh must not silently re-expand what the user collapsed')
})

test('a newly created file appears after a nodesUpdate without disturbing other nodes', () => {
  const w = runWebview(buildLopsidedNodes())
  w.dblclickNode('/root/bushy')

  const grown = buildLopsidedNodes()
  grown.push({ id: '/root/new-file.ts', parentId: '/root', name: 'new-file.ts', isDirectory: false, kind: 'file' })
  w.sendNodesUpdate(grown)

  assert.equal(w.isRendered('/root/new-file.ts'), true)
  assert.equal(w.isCollapsedNode('/root/bushy'), true, 'an unrelated collapse decision must survive the same update')
})

test('a deleted file disappears after a nodesUpdate', () => {
  const w = runWebview(buildLopsidedNodes())
  assert.equal(w.isRendered('/root/lonely.ts'), true)

  const shrunk = buildLopsidedNodes().filter((n) => n.id !== '/root/lonely.ts')
  w.sendNodesUpdate(shrunk)

  assert.equal(w.isRendered('/root/lonely.ts'), false)
  assert.equal(w.renderedNodeIds().includes('/root/lonely.ts'), false)
})

test('root stays visually anchored when a nodesUpdate makes the tree grow horizontally', () => {
  const w = runWebview(buildLopsidedNodes())
  const before = w.nodeScreenX('/root')

  const grown = buildLopsidedNodes()
  for (let i = 10; i < 30; i++) {
    grown.push({
      id: '/root/bushy/f' + i,
      parentId: '/root/bushy',
      name: 'f' + i + '.ts',
      isDirectory: false,
      kind: 'file'
    })
  }
  w.sendNodesUpdate(grown)

  assert.equal(w.nodeScreenX('/root'), before, 'root must not visibly shift sideways when new files widen the tree')
})

test('a newly added oversized subtree is auto-collapsed per config, but a pre-existing directory the user expanded stays expanded', () => {
  const config = { maxDepth: 1e9, maxNodesBeforeCollapse: 1e9, maxChildrenBeforeCollapse: 3, maxNodesOnExpand: 1e9 }
  const initialNodes = [
    { id: '/root', parentId: null, name: 'root', isDirectory: true, kind: 'harness-root' },
    { id: '/root/dirA', parentId: '/root', name: 'dirA', isDirectory: true, kind: 'group' }
  ]
  for (let i = 0; i < 5; i++) {
    initialNodes.push({ id: '/root/dirA/f' + i, parentId: '/root/dirA', name: 'f' + i, isDirectory: false, kind: 'file' })
  }
  const w = runWebview(initialNodes, config)

  // dirA has 5 children > maxChildrenBeforeCollapse (3), so the initial load
  // auto-collapses it — same rule a fresh load applies everywhere else.
  assert.equal(w.isCollapsedNode('/root/dirA'), true)
  w.dblclickNode('/root/dirA') // user manually expands it
  assert.equal(w.isCollapsedNode('/root/dirA'), false)

  const updatedNodes = initialNodes.slice()
  updatedNodes.push({ id: '/root/dirB', parentId: '/root', name: 'dirB', isDirectory: true, kind: 'group' })
  for (let i = 0; i < 5; i++) {
    updatedNodes.push({ id: '/root/dirB/g' + i, parentId: '/root/dirB', name: 'g' + i, isDirectory: false, kind: 'file' })
  }
  w.sendNodesUpdate(updatedNodes, [], config)

  assert.equal(w.isCollapsedNode('/root/dirA'), false, 'a pre-existing directory the user expanded must not be silently re-collapsed by a refresh')
  assert.equal(w.isCollapsedNode('/root/dirB'), true, 'a brand-new oversized directory should start auto-collapsed, same as a fresh load would give it')
})

test('the current selection survives a nodesUpdate when the selected node still exists', () => {
  const w = runWebview(buildLopsidedNodes())
  w.clickNode('/root/lonely.ts')
  assert.equal(w.isSelectedNode('/root/lonely.ts'), true)

  w.sendNodesUpdate(buildLopsidedNodes())

  assert.equal(w.isSelectedNode('/root/lonely.ts'), true, 'selection should survive a refresh that leaves the selected node in place')
})
