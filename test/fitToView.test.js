const test = require('node:test')
const assert = require('node:assert/strict')
const { runWebview } = require('./webviewLogic.harness.js')

function buildSimpleNodes() {
  return [
    { id: '/root', parentId: null, name: 'root', isDirectory: true, kind: 'harness-root' },
    { id: '/root/a', parentId: '/root', name: 'a.ts', isDirectory: false, kind: 'file' }
  ]
}

// A panel much wider than it is tall, and a graph much taller than it is
// wide — deliberately asymmetric on both axes so a formula that centers
// only horizontally (or pads from the top instead of centering vertically)
// produces a visibly different tx/ty than one that centers on both axes.
function fakePanelAndGraph(w) {
  w.setElementRect('canvas', { left: 0, top: 0, right: 800, bottom: 200, width: 800, height: 200 })
  w.setElementBBox('viewport', { x: 10, y: 5, width: 100, height: 500 })
}

test('the resize button centers the graph on both axes, not just horizontally', () => {
  const w = runWebview(buildSimpleNodes())
  fakePanelAndGraph(w)

  w.clickButton('zoomReset')

  const { tx, ty, scale } = w.viewportTransform()
  const pad = 60
  const expectedScale = Math.min((800 - pad) / 100, (200 - pad) / 500, 3)
  const expectedTx = (800 - 100 * expectedScale) / 2 - 10 * expectedScale
  const expectedTy = (200 - 500 * expectedScale) / 2 - 5 * expectedScale

  assert.equal(scale, expectedScale)
  assert.ok(Math.abs(tx - expectedTx) < 1e-9, 'tx should center horizontally')
  assert.ok(Math.abs(ty - expectedTy) < 1e-9, 'ty should center vertically, not just pad from the top')
})

test('pressing the resize button always snaps back to the same centered location for unchanged content', () => {
  const w = runWebview(buildSimpleNodes())
  fakePanelAndGraph(w)

  w.clickButton('zoomReset')
  const first = w.viewportTransform()

  // Disturb the view (zoom in, which changes scale/tx/ty)...
  w.clickButton('zoomIn')
  const disturbed = w.viewportTransform()
  assert.notDeepEqual(disturbed, first, 'sanity: zooming in actually changed the transform')

  // ...then resize again — same graph, same panel, so it must land on
  // exactly the same transform as the first time, not some other fit.
  w.clickButton('zoomReset')
  const second = w.viewportTransform()
  assert.deepEqual(second, first)
})
