const test = require('node:test')
const assert = require('node:assert/strict')
const { runWebview } = require('./webviewLogic.harness.js')

// Minimal single-node tree — these tests exercise static panel chrome
// (legend, debug log) rather than tree-rendering logic, so the tree shape
// itself doesn't matter.
function buildMinimalNodes() {
  return [{ id: '/root', parentId: null, name: 'root', isDirectory: true, kind: 'harness-root' }]
}

test('toggling the legend header shrinks the whole legend, not just its body', () => {
  const w = runWebview(buildMinimalNodes())

  w.clickButton('legendHeader')
  assert.equal(w.hasClass('legendBody', 'collapsed'), true)
  assert.equal(w.hasClass('legend', 'collapsed'), true, 'the outer #legend container also shrinks when collapsed')

  w.clickButton('legendHeader')
  assert.equal(w.hasClass('legendBody', 'collapsed'), false)
  assert.equal(w.hasClass('legend', 'collapsed'), false)
})

test('the debug log toggle button shows/hides the debug log panel', () => {
  const w = runWebview(buildMinimalNodes())

  w.clickButton('debugLogToggle')
  assert.equal(w.hasClass('debugLog', 'collapsed'), false, 'first click opens it')

  w.clickButton('debugLogToggle')
  assert.equal(w.hasClass('debugLog', 'collapsed'), true, 'second click closes it again')
})

test('opening the debug log nudges the legend out of the way, closing it puts the legend back', () => {
  const w = runWebview(buildMinimalNodes())

  assert.equal(w.hasClass('legend', 'debugOpen'), false)

  w.clickButton('debugLogToggle') // open
  assert.equal(w.hasClass('legend', 'debugOpen'), true)

  w.clickButton('debugLogToggle') // close
  assert.equal(w.hasClass('legend', 'debugOpen'), false)
})
