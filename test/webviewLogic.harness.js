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

function extractScript(fakeNodes) {
  const src = fs.readFileSync(SRC_PATH, 'utf8')
  const startMarker = '<script nonce="${nonce}">'
  const start = src.indexOf(startMarker) + startMarker.length
  const end = src.indexOf('</script>', start)
  if (start < startMarker.length || end === -1) {
    throw new Error('Could not find <script> block in treePanel.ts — extraction markers may be stale')
  }
  let script = src.slice(start, end)
  const marker = 'const nodes = ${data};'
  if (!script.includes(marker)) {
    throw new Error('Could not find node-data injection point in treePanel.ts — extraction markers may be stale')
  }
  return script.replace(marker, 'const nodes = ' + JSON.stringify(fakeNodes) + ';')
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
      }
    },
    setAttribute(k, v) {
      this.attrs[k] = String(v)
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
    addEventListener() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }
    },
    getBBox() {
      return { x: 0, y: 0, width: 100, height: 100 }
    },
    closest() {
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
function runWebview(fakeNodes) {
  const script = extractScript(fakeNodes)
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
    acquireVsCodeApi: () => ({ postMessage: () => {} }),
    requestAnimationFrame: () => {},
    console
  }
  vm.createContext(sandbox)
  vm.runInContext(script, sandbox)

  function sendStep(step, filePaths) {
    for (const cb of messageListeners) cb({ data: { type: 'step', step, filePaths } })
  }

  function sendDebug(source, message) {
    for (const cb of messageListeners) cb({ data: { type: 'debug', source, message } })
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

  return { sendStep, sendDebug, nodeGlowOpacity, edgeGlowOpacity, debugLogLines }
}

module.exports = { runWebview, extractScript, makeEl }
