// Shared test harness for exercising the tree-visualization panel's
// client-side logic. It lives inline in a <script> tag inside
// src/treePanel.ts (it has to — VS Code webviews load a single
// self-contained HTML string, there's no bundler in this project to pull in
// an external module). To test it without opening an actual VS Code window,
// this extracts that script verbatim from the .ts source, injects a fixed
// node-list in place of the template placeholder, and runs it against a
// minimal DOM/SVG stub — enough to exercise the pure logic (path-to-node
// resolution, ancestor propagation, freshness decay, edge glow) without
// needing a browser.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const SRC_PATH = path.join(__dirname, '..', 'src', 'treePanel.ts')

// Effectively "off": thresholds high enough that no fixture used in the
// existing tests could ever trigger auto-collapse, so every test written
// before the auto-collapse feature existed keeps its "everything renders by
// default" assumption without needing to know about config at all. Tests
// that specifically exercise auto-collapse pass their own small config via
// runWebview's second argument.
const DISABLED_COLLAPSE_CONFIG = {
  maxDepth: 1e9,
  maxNodesBeforeCollapse: 1e9,
  maxChildrenBeforeCollapse: 1e9,
  maxNodesOnExpand: 1e9
}

function extractScript(fakeNodes, fakeConfig, fakeHarnessNodes) {
  const src = fs.readFileSync(SRC_PATH, 'utf8')
  const startMarker = '<script nonce="${nonce}">'
  const start = src.indexOf(startMarker) + startMarker.length
  const end = src.indexOf('</script>', start)
  if (start < startMarker.length || end === -1) {
    throw new Error('Could not find <script> block in treePanel.ts — extraction markers may be stale')
  }
  let script = src.slice(start, end)
  const nodesMarker = 'const nodes = ${data};'
  const harnessNodesMarker = 'const harnessNodes = ${harnessData};'
  const configMarker = 'const config = ${configData};'
  if (!script.includes(nodesMarker) || !script.includes(harnessNodesMarker) || !script.includes(configMarker)) {
    throw new Error('Could not find node-data/harness-data/config injection point in treePanel.ts — extraction markers may be stale')
  }
  script = script.replace(nodesMarker, 'const nodes = ' + JSON.stringify(fakeNodes) + ';')
  script = script.replace(harnessNodesMarker, 'const harnessNodes = ' + JSON.stringify(fakeHarnessNodes || []) + ';')
  script = script.replace(configMarker, 'const config = ' + JSON.stringify(fakeConfig || DISABLED_COLLAPSE_CONFIG) + ';')
  return script
}

function makeEl(tag) {
  const el = {
    tag,
    attrs: {},
    style: {},
    children: [],
    classList: {
      set: new Set(),
      add(c) {
        this.set.add(c)
      },
      remove(c) {
        this.set.delete(c)
      },
      contains(c) {
        return this.set.has(c)
      },
      toggle(c, force) {
        const on = force === undefined ? !this.set.has(c) : force
        if (on) this.set.add(c)
        else this.set.delete(c)
        return on
      }
    },
    setAttribute(k, v) {
      this.attrs[k] = String(v)
      // Real browsers keep the `class` attribute and `classList` in sync
      // automatically. el() sets classes via setAttribute('class', ...) at
      // creation time, so without this, classList.contains() would never
      // see any class that wasn't *also* toggled later via classList.toggle.
      if (k === 'class') this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean))
    },
    getAttribute(k) {
      return this.attrs[k]
    },
    appendChild(c) {
      this.children.push(c)
      return c
    },
    removeChild(c) {
      const i = this.children.indexOf(c)
      if (i !== -1) this.children.splice(i, 1)
      return c
    },
    get firstChild() {
      return this.children[0]
    },
    _listeners: {},
    addEventListener(type, cb) {
      ;(this._listeners[type] = this._listeners[type] || []).push(cb)
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }
    },
    getBBox() {
      return { x: 0, y: 0, width: 100, height: 100 }
    },
    // Real `closest` walks up the ancestor chain; tests only ever dispatch
    // synthetic events with `target` set directly to the node <g> itself
    // (see dblclickNode/clickNode below), so matching on this element alone
    // is a faithful-enough stand-in for `target.closest('[data-id]')`.
    closest(selector) {
      if (selector === '[data-id]' && this.attrs['data-id'] !== undefined) return this
      return null
    }
  }
  Object.defineProperty(el, 'innerHTML', {
    set(v) {
      this._html = v
    },
    get() {
      return this._html
    }
  })
  return el
}

/** Runs the extracted webview script in an isolated VM context and returns
 *  handles for poking at it: dispatching 'step'/'debug' messages and reading
 *  back glow state via the data-id / data-child-id attributes set on
 *  elements. */
function runWebview(fakeNodes, fakeConfig, fakeHarnessNodes) {
  const script = extractScript(fakeNodes, fakeConfig, fakeHarnessNodes)
  const byIdMap = {}
  const messageListeners = []

  const sandbox = {
    document: {
      createElementNS: (_ns, tag) => makeEl(tag),
      createElement: (tag) => makeEl(tag),
      getElementById: (id) => {
        if (!byIdMap[id]) byIdMap[id] = makeEl('div')
        return byIdMap[id]
      }
    },
    window: {
      addEventListener: (type, cb) => {
        if (type === 'message') messageListeners.push(cb)
      }
    },
    acquireVsCodeApi: () => ({ postMessage: (m) => postedMessages.push(m) }),
    // A no-op, same as fitToView()'s own animation frame — real panning math
    // needs a real window (see HARNESS.md's Testing section), so goTo()'s
    // centerOn()/animateTransform() never actually runs its animation step
    // here. performance.now() still needs to exist, though: animateTransform
    // calls it unconditionally before ever reaching requestAnimationFrame.
    requestAnimationFrame: () => {},
    performance: { now: () => Date.now() },
    // Also a no-op: Go To/Isolate's ephemeral flash/phantom elements schedule
    // their own removal via setTimeout(). Never firing it is fine here — the
    // tests below only assert on the synchronous state changes (selection,
    // collapsed set), never on whether a flash element has faded out yet.
    setTimeout: () => {},
    console
  }
  const postedMessages = []
  vm.createContext(sandbox)
  vm.runInContext(script, sandbox)

  function sendStep(step, filePaths) {
    for (const cb of messageListeners) cb({ data: { type: 'step', step, filePaths } })
  }

  function sendDebug(source, message) {
    for (const cb of messageListeners) cb({ data: { type: 'debug', source, message } })
  }

  function sendSessionReset() {
    for (const cb of messageListeners) cb({ data: { type: 'sessionReset' } })
  }

  function nodeGlowOpacity(nodeId) {
    const g = byIdMap.nodeLayer.children.find((c) => c.attrs['data-id'] === nodeId)
    assert.ok(g, 'no rendered node found for id ' + nodeId)
    return Number(g.children[0].style.opacity)
  }

  function edgeGlowOpacity(childId) {
    const p = byIdMap.edgeGlowLayer.children.find((c) => c.attrs['data-child-id'] === childId)
    assert.ok(p, 'no rendered edge found for child id ' + childId)
    return Number(p.style.opacity)
  }

  function debugLogLines() {
    return byIdMap.debugLogBody.children.map((c) => c.textContent)
  }

  function nodeGroupById(nodeId) {
    return byIdMap.nodeLayer.children.find((c) => c.attrs['data-id'] === nodeId)
  }

  /** A node's on-screen x: its own translate(x,y) composed with the
   *  #viewport group's translate(tx,ty) scale(s) transform — the same math
   *  the browser itself would apply. Used to confirm a node's screen
   *  position stays fixed across a re-render, independent of whatever its
   *  underlying layout x happened to become. */
  function nodeScreenX(nodeId) {
    const g = nodeGroupById(nodeId)
    assert.ok(g, 'no rendered node found for id ' + nodeId)
    const nodeMatch = /translate\(([-\d.]+),/.exec(g.attrs.transform || '')
    assert.ok(nodeMatch, 'node ' + nodeId + ' has no translate() transform')
    const localX = Number(nodeMatch[1])

    const viewportTransform = byIdMap.viewport ? byIdMap.viewport.attrs.transform || '' : ''
    const txMatch = /translate\(([-\d.]+),/.exec(viewportTransform)
    const scaleMatch = /scale\(([-\d.]+)\)/.exec(viewportTransform)
    const tx = txMatch ? Number(txMatch[1]) : 0
    const scale = scaleMatch ? Number(scaleMatch[1]) : 1

    return tx + localX * scale
  }

  function nodeVisited(nodeId) {
    const g = nodeGroupById(nodeId)
    assert.ok(g, 'no rendered node found for id ' + nodeId)
    return g.classList.contains('visited')
  }

  function edgeVisited(childId) {
    const p = byIdMap.edgeLayer.children.find((c) => c.attrs['data-child-id'] === childId)
    assert.ok(p, 'no rendered edge found for child id ' + childId)
    return p.classList.contains('visited')
  }

  function isRendered(nodeId) {
    return !!nodeGroupById(nodeId)
  }

  function renderedNodeIds() {
    return byIdMap.nodeLayer.children.map((c) => c.attrs['data-id'])
  }

  function renderedEdgeCount() {
    return byIdMap.edgeLayer.children.length
  }

  /** Count of ephemeral flash/phantom elements currently in flashLayer —
   *  Go To/Isolate's highlight, never anything persistent. setTimeout is a
   *  no-op in this harness (see the sandbox above), so these never actually
   *  time out and remove themselves mid-test; the count reflects exactly
   *  what one goTo()/isolateNode() call created. */
  function flashElementCount() {
    return byIdMap.flashLayer ? byIdMap.flashLayer.children.length : 0
  }

  /** Reads whether a static (non-tree) DOM element — a toolbar button,
   *  panel, or container referenced by id anywhere in the script — currently
   *  has a given CSS class, e.g. hasClass('debugLog', 'collapsed'). Elements
   *  are created lazily on first getElementById() call, same as the real
   *  DOM, so this only works once the script has actually referenced the
   *  id. */
  /** Overrides the fake geometry a stubbed element reports back — real
   *  layout (getBoundingClientRect/getBBox) doesn't exist in this VM
   *  sandbox, so anything that depends on actual on-screen size (fitToView,
   *  chiefly) needs its inputs faked explicitly per-test. */
  function setElementRect(elementId, rect) {
    const el = byIdMap[elementId] || (byIdMap[elementId] = makeEl('div'))
    el.getBoundingClientRect = () => rect
  }
  function setElementBBox(elementId, bbox) {
    const el = byIdMap[elementId] || (byIdMap[elementId] = makeEl('div'))
    el.getBBox = () => bbox
  }

  /** Reads back the #viewport group's current translate(tx,ty) scale(s)
   *  transform — the same string updateTransform() writes on every pan/
   *  zoom/fit change. */
  function viewportTransform() {
    const t = (byIdMap.viewport && byIdMap.viewport.attrs.transform) || ''
    const txMatch = /translate\(([-\d.]+),([-\d.]+)\)/.exec(t)
    const scaleMatch = /scale\(([-\d.]+)\)/.exec(t)
    return {
      tx: txMatch ? Number(txMatch[1]) : 0,
      ty: txMatch ? Number(txMatch[2]) : 0,
      scale: scaleMatch ? Number(scaleMatch[1]) : 1
    }
  }

  function hasClass(elementId, className) {
    const el = byIdMap[elementId]
    assert.ok(el, 'no element with id ' + elementId + ' has been referenced yet')
    return el.classList.contains(className)
  }

  function isCollapsedNode(nodeId) {
    const g = nodeGroupById(nodeId)
    assert.ok(g, 'no rendered node found for id ' + nodeId)
    return g.classList.contains('collapsed')
  }

  /** True if nodeId's rendered <g> currently carries the 'selected' class —
   *  set by clickNode()/goTo() alike, so this works as the read side for
   *  both. */
  function isSelectedNode(nodeId) {
    const g = nodeGroupById(nodeId)
    assert.ok(g, 'no rendered node found for id ' + nodeId)
    return g.classList.contains('selected')
  }

  // The collapsed-node indicator is a single arrow ('collapse-arrow') whose
  // own opacity tracks freshness — this reads that opacity, same signal the
  // old plain bar used to expose under the name 'collapse-indicator'. Falls
  // back to the CSS baseline (0.55, unvisited) when no inline style is set.
  function collapseIndicatorOpacity(nodeId) {
    const g = nodeGroupById(nodeId)
    assert.ok(g, 'no rendered node found for id ' + nodeId)
    const arrow = g.children.find((c) => c.attrs.class === 'collapse-arrow')
    if (!arrow) return null
    return arrow.style.opacity === '' ? 0.55 : Number(arrow.style.opacity)
  }

  /** Simulates double-clicking a currently-rendered node — dispatches
   *  through the real dblclick listener registered on the canvas <svg>, the
   *  same code path a real double-click in the webview goes through. */
  function dblclickNode(nodeId) {
    const target = nodeGroupById(nodeId)
    assert.ok(target, 'no rendered node found for id ' + nodeId + ' (is it currently visible?)')
    const listeners = byIdMap.canvas._listeners.dblclick || []
    assert.ok(listeners.length > 0, 'no dblclick listener registered on the canvas')
    for (const cb of listeners) cb({ target })
  }

  /** Simulates a single click on a currently-rendered node — selects it and
   *  triggers showInfo(), the same as a real click in the webview. */
  function clickNode(nodeId) {
    const target = nodeGroupById(nodeId)
    assert.ok(target, 'no rendered node found for id ' + nodeId + ' (is it currently visible?)')
    const listeners = byIdMap.canvas._listeners.click || []
    assert.ok(listeners.length > 0, 'no click listener registered on the canvas')
    for (const cb of listeners) cb({ target })
  }

  /** Simulates clicking a button by id — works both for buttons inside the
   *  currently-rendered info panel (e.g. showInfo()'s dynamically-created
   *  "Open File" / "Collapse subtree" buttons) and for static toolbar
   *  buttons (zoom, refresh, collapse-to-depth, expand-1-layer, settings). */
  function clickInfoButton(buttonId) {
    const b = byIdMap[buttonId]
    assert.ok(b, 'no button with id ' + buttonId + ' has been created yet — is the info panel showing it?')
    const listeners = b._listeners.click || []
    assert.ok(listeners.length > 0, 'button ' + buttonId + ' has no click listener registered')
    for (const cb of listeners) cb({})
  }

  /** Finds a "Harnesses" navigator row by the harness id it was built from
   *  (set via row.setAttribute('data-id', id) in renderHarnessList()). */
  function harnessRow(id) {
    const body = byIdMap.harnessListBody
    if (!body) return null
    return body.children.find((c) => c.attrs['data-id'] === id) || null
  }

  /** Simulates clicking a "Harnesses" navigator row's Go To (action='goto')
   *  or Isolate (action='isolate') button — the same code path a real click
   *  on that row's 🎯/⛶ button goes through. */
  function clickHarnessAction(id, action) {
    const row = harnessRow(id)
    assert.ok(row, 'no harness-list row found for id ' + id)
    const btn = row.children.find((c) => c.attrs['data-action'] === action)
    assert.ok(btn, 'no ' + action + ' button found on the row for ' + id)
    const listeners = btn._listeners.click || []
    assert.ok(listeners.length > 0, action + ' button for ' + id + ' has no click listener registered')
    for (const cb of listeners) cb({})
  }

  return {
    sendStep,
    sendDebug,
    sendSessionReset,
    nodeGlowOpacity,
    nodeScreenX,
    edgeGlowOpacity,
    debugLogLines,
    nodeVisited,
    edgeVisited,
    isRendered,
    renderedNodeIds,
    renderedEdgeCount,
    flashElementCount,
    isCollapsedNode,
    isSelectedNode,
    collapseIndicatorOpacity,
    hasClass,
    setElementRect,
    setElementBBox,
    viewportTransform,
    dblclickNode,
    clickNode,
    clickInfoButton,
    clickButton: clickInfoButton,
    harnessRow,
    clickHarnessAction,
    postedMessages
  }
}

module.exports = { runWebview, extractScript, makeEl, DISABLED_COLLAPSE_CONFIG }
