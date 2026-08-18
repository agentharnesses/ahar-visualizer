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
const { runWebview } = require('./webviewLogic.harness.js')

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

test('a glowing edge never points at an untouched sibling — regression for a real reported bug', () => {
  // Hand-testing surfaced this: touching README.md (root's immediate child)
  // one-hop-marks root fresh, and root has several *other* children besides
  // README.md. Edge glow was computed purely from "is my parent fresh",
  // which lit up every one of those sibling edges too — visually, several
  // glowing connections leading to plain, dark, never-touched boxes. That's
  // backwards for a tool whose whole point is traceability.
  const w = runWebview(NODES)
  w.sendStep(1, ['/root/skills/agent-harnesses/SKILL.md']) // marks SKILL.md + agent-harnesses only

  // The actual touched path's own edge should glow.
  assert.equal(w.edgeGlowOpacity('/root/skills/agent-harnesses/SKILL.md'), 1)
  // /root/other is root's child, same as /root/skills is agent-harnesses's
  // sibling context — neither was touched, so neither edge may glow, even
  // though root and skills are each a fresh node's parent somewhere in the
  // tree.
  assert.equal(w.edgeGlowOpacity('/root/other'), 0)
  assert.equal(w.nodeGlowOpacity('/root/other'), 0)
})

test('an edge only glows through a contiguous chain of touched ancestors, not by jumping to a fresh one further up', () => {
  const w = runWebview(NODES)
  // Root's own HARNESS.md is read first — root has no parent, so this only
  // marks root itself.
  w.sendStep(1, ['/root/HARNESS.md'])
  assert.equal(w.nodeGlowOpacity('/root'), 1)

  // Later (different step, well within the decay window), a completely
  // separate leaf's descriptor is read — marks SKILL.md + agent-harnesses,
  // but NOT skills (agent-harnesses's own parent).
  w.sendStep(5, ['/root/skills/agent-harnesses/SKILL.md'])

  // edge(agent-harnesses -> skills): agent-harnesses is on a touched path,
  // so this edge is eligible to glow — but its *value* is skills's own
  // freshness, and skills was never touched, so it stays dark.
  assert.equal(w.edgeGlowOpacity('/root/skills/agent-harnesses'), 0)
  // edge(skills -> root): skills itself was never touched (not directly,
  // not as anyone's immediate parent), so this edge doesn't qualify to glow
  // at all — even though root, further up, is independently fresh. The
  // chain stops wherever the contiguous touched path stops; it doesn't
  // jump across a dark node to reach a fresh one beyond it.
  assert.equal(w.edgeGlowOpacity('/root/skills'), 0)
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

test('debug log records both host and client messages, and resolution outcomes for each touch', () => {
  const w = runWebview(NODES)
  w.sendDebug('host', 'watcher started · root=/root')
  w.sendStep(1, ['/root/skills/agent-harnesses/SKILL.md', '/outside/tree.ts'])

  const lines = w.debugLogLines()
  assert.ok(lines.some((l) => l.includes('watcher started')), 'host debug message should be recorded')
  assert.ok(
    lines.some((l) => l.includes('/root/skills/agent-harnesses/SKILL.md -> /root/skills/agent-harnesses/SKILL.md')),
    'a successful resolution should be logged with its target node id'
  )
  assert.ok(
    lines.some((l) => l.includes('/outside/tree.ts -> UNRESOLVED')),
    'an unresolved path should be explicitly logged as such, not silently dropped'
  )
})

test('a node stays marked "visited" permanently, even after its glow fully decays', () => {
  const w = runWebview(NODES)
  w.sendStep(1, ['/root/skills/agent-harnesses/SKILL.md']) // marks SKILL.md + agent-harnesses

  assert.equal(w.nodeVisited('/root/skills/agent-harnesses/SKILL.md'), true)
  assert.equal(w.nodeVisited('/root/skills/agent-harnesses'), true)
  assert.equal(w.nodeVisited('/root/other'), false, 'never-touched sibling must not be marked visited')

  w.sendStep(1000, []) // long past DECAY_STEPS (40) — glow is fully gone
  assert.equal(w.nodeGlowOpacity('/root/skills/agent-harnesses/SKILL.md'), 0, 'sanity: glow really did decay to 0')
  assert.equal(w.nodeVisited('/root/skills/agent-harnesses/SKILL.md'), true, 'but visited stays true forever')
  assert.equal(w.nodeVisited('/root/skills/agent-harnesses'), true)
})

test('an edge stays marked "visited" permanently, distinguishing it from a never-touched sibling edge', () => {
  const w = runWebview(NODES)
  w.sendStep(1, ['/root/skills/agent-harnesses/SKILL.md'])
  w.sendStep(1000, []) // fully decayed

  assert.equal(w.edgeGlowOpacity('/root/skills/agent-harnesses/SKILL.md'), 0, 'sanity: edge glow decayed to 0')
  assert.equal(w.edgeVisited('/root/skills/agent-harnesses/SKILL.md'), true, 'the touched path\'s edge stays visited')
  assert.equal(w.edgeVisited('/root/other'), false, 'a sibling edge that was never on a touched path stays plain')
})
