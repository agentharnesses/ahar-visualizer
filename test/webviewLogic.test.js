// The tree-visualization panel's client-side logic lives inline in a
// <script> tag inside src/treePanel.ts (it has to — VS Code webviews load a
// single self-contained HTML string, there's no bundler in this project to
// pull in an external module). To test it without opening an actual VS Code
// window, this extracts that script verbatim from the .ts source, injects a
// fixed nonce/node-list in place of the template placeholders, and runs it
// against a minimal DOM/SVG stub — enough to exercise the pure logic
// (path-to-node resolution, ancestor propagation, freshness decay, edge glow)
// without needing a browser.

const test = require('node:test')
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
 *  handles for poking at it: dispatching 'step' messages and reading back
 *  glow state via the data-id / data-child-id attributes set on elements. */
function runWebview(fakeNodes) {
  const script = extractScript(fakeNodes)
  const byIdMap = {}
  const messageListeners = []

  const sandbox = {
    document: {
      createElementNS: (_ns, tag) => makeEl(tag),
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

  return { sendStep, nodeGlowOpacity, edgeGlowOpacity }
}

const NODES = [
  { id: '/root', parentId: null, name: 'root', isDirectory: true, kind: 'harness-root' },
  { id: '/root/skills', parentId: '/root', name: 'skills', isDirectory: true, kind: 'group', hasRoutingChild: true },
  {
    id: '/root/skills/agent-harnesses',
    parentId: '/root/skills',
    name: 'agent-harnesses',
    isDirectory: true,
    kind: 'leaf',
    leafType: 'skill'
  },
  {
    id: '/root/skills/agent-harnesses/SKILL.md',
    parentId: '/root/skills/agent-harnesses',
    name: 'SKILL.md',
    isDirectory: false,
    kind: 'leaf-descriptor'
  },
  { id: '/root/other', parentId: '/root', name: 'other', isDirectory: true, kind: 'group' }
]

test('the script loads without throwing (regression: TDZ ordering bug)', () => {
  assert.doesNotThrow(() => runWebview(NODES))
})

test('touching a file lights up itself and its immediate containing directory, not further ancestors', () => {
  const w = runWebview(NODES)
  w.sendStep(1, ['/root/skills/agent-harnesses/SKILL.md'])

  assert.equal(w.nodeGlowOpacity('/root/skills/agent-harnesses/SKILL.md'), 1)
  assert.equal(w.nodeGlowOpacity('/root/skills/agent-harnesses'), 1, 'the immediate containing directory should light up')
  // Deliberately bounded to one hop: a single touch must not make every
  // ancestor up to root "fresh" — that would light up every top-level
  // edge in the whole tree (including totally unrelated subtrees) on any
  // touch anywhere, which is the opposite of traceable.
  assert.equal(w.nodeGlowOpacity('/root/skills'), 0)
  assert.equal(w.nodeGlowOpacity('/root'), 0)
  assert.equal(w.nodeGlowOpacity('/root/other'), 0)
})

test('a touched path with no node of its own resolves up to its nearest tracked ancestor, then one hop further', () => {
  const w = runWebview(NODES)
  // /root/skills/agent-harnesses/HARNESS.md doesn't exist as a node (folded
  // files never get serialized) — resolveToNodeId has to walk up to find
  // the containing leaf directory; the one-hop rule then also marks *its*
  // parent, same as it would for any other resolved node.
  w.sendStep(1, ['/root/skills/agent-harnesses/HARNESS.md'])
  assert.equal(w.nodeGlowOpacity('/root/skills/agent-harnesses'), 1)
  assert.equal(w.nodeGlowOpacity('/root/skills'), 1)
  assert.equal(w.nodeGlowOpacity('/root'), 0)
})

test('independent touches only chain together through ancestors that are independently fresh', () => {
  const w = runWebview(NODES)
  // Root's own HARNESS.md is read first — root has no parent, so this only
  // marks root itself.
  w.sendStep(1, ['/root/HARNESS.md'])
  assert.equal(w.nodeGlowOpacity('/root'), 1)

  // Later (different step, well within the decay window), a completely
  // separate leaf's descriptor is read.
  w.sendStep(5, ['/root/skills/agent-harnesses/SKILL.md'])

  // edge(skills -> root): skills itself was never touched, but root was
  // independently fresh from its own earlier touch (at step 1, now step 5:
  // 1 - 4/40 = 0.9) — the edge should still glow, because the rule is
  // "freshness of the parent", full stop.
  assert.equal(w.edgeGlowOpacity('/root/skills'), 0.9, 'edge up to an independently-fresh root should glow')
  // But skills itself (the node) never became fresh — it was never touched,
  // directly or as anyone's immediate parent.
  assert.equal(w.nodeGlowOpacity('/root/skills'), 0)
})

test('a path entirely outside the tree resolves to nothing and glows nothing', () => {
  const w = runWebview(NODES)
  assert.doesNotThrow(() => w.sendStep(1, ['/somewhere/else/entirely.ts']))
  for (const n of NODES) assert.equal(w.nodeGlowOpacity(n.id), 0)
})

test('freshness decays linearly by step count and clamps at 0, never negative', () => {
  const w = runWebview(NODES)
  w.sendStep(10, ['/root/skills/agent-harnesses/SKILL.md']) // touched at step 10

  w.sendStep(10, []) // no-op step bump, same step (re-send is fine, just re-evaluates)
  assert.equal(w.nodeGlowOpacity('/root/skills/agent-harnesses/SKILL.md'), 1)

  w.sendStep(30, []) // DECAY_STEPS is 40 in treePanel.ts; halfway through
  assert.equal(w.nodeGlowOpacity('/root/skills/agent-harnesses/SKILL.md'), 0.5)

  w.sendStep(50, []) // fully decayed
  assert.equal(w.nodeGlowOpacity('/root/skills/agent-harnesses/SKILL.md'), 0)

  w.sendStep(1000, []) // long after — must stay clamped at 0, not go negative
  assert.equal(w.nodeGlowOpacity('/root/skills/agent-harnesses/SKILL.md'), 0)
})

test("an edge's glow equals the freshness of the node above it, not the node below it", () => {
  const w = runWebview(NODES)
  w.sendStep(10, ['/root/skills/agent-harnesses/SKILL.md'])

  // edge(SKILL.md -> agent-harnesses): glow = freshness(agent-harnesses), and
  // agent-harnesses IS fresh here (immediate parent of the touched file).
  assert.equal(w.edgeGlowOpacity('/root/skills/agent-harnesses/SKILL.md'), 1)
  // edge(agent-harnesses -> skills): glow = freshness(skills) — skills was
  // never touched (one hop stops at agent-harnesses), so this stays dark.
  assert.equal(w.edgeGlowOpacity('/root/skills/agent-harnesses'), 0)
  assert.equal(w.edgeGlowOpacity('/root/skills'), 0)
  assert.equal(w.edgeGlowOpacity('/root/other'), 0)

  w.sendStep(30, []) // half-decayed
  assert.equal(w.edgeGlowOpacity('/root/skills/agent-harnesses/SKILL.md'), 0.5)
})
