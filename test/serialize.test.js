const test = require('node:test')
const assert = require('node:assert/strict')
const { loadSerialize, fakeIndex } = require('./serialize.harness.js')

const { serialize } = loadSerialize()

const ROOT = '/root'

test('a harness-root directory records its folded HARNESS.md path', () => {
  const index = fakeIndex(ROOT, {
    dirs: [{ id: ROOT, name: 'root', kind: 'harness-root' }],
    files: [{ id: ROOT + '/HARNESS.md', parentId: ROOT, name: 'HARNESS.md', kind: 'harness-md' }]
  })

  const nodes = serialize(index, ROOT)

  assert.equal(nodes.length, 1, 'HARNESS.md should not become its own node')
  assert.equal(nodes[0].foldedFilePath, ROOT + '/HARNESS.md')
})

test('a directory with a routing index records its folded routing file path', () => {
  const index = fakeIndex(ROOT, {
    dirs: [
      { id: ROOT, name: 'root', kind: 'harness-root' },
      { id: ROOT + '/skills', name: 'skills', parentId: ROOT, kind: 'group', hasRoutingChild: true }
    ],
    files: [
      { id: ROOT + '/HARNESS.md', parentId: ROOT, name: 'HARNESS.md', kind: 'harness-md' },
      { id: ROOT + '/skills/SKILLS.md', parentId: ROOT + '/skills', name: 'SKILLS.md', kind: 'routing' }
    ]
  })

  const nodes = serialize(index, ROOT)
  const skillsNode = nodes.find((n) => n.id === ROOT + '/skills')

  assert.equal(nodes.length, 2, 'neither HARNESS.md nor SKILLS.md should become their own node')
  assert.equal(skillsNode.foldedFilePath, ROOT + '/skills/SKILLS.md')
  assert.equal(nodes.find((n) => n.id === ROOT).foldedFilePath, ROOT + '/HARNESS.md')
})

test('a directory with neither has no foldedFilePath', () => {
  const index = fakeIndex(ROOT, {
    dirs: [
      { id: ROOT, name: 'root', kind: 'harness-root' },
      { id: ROOT + '/plain', name: 'plain', parentId: ROOT, kind: 'group' }
    ],
    files: [{ id: ROOT + '/HARNESS.md', parentId: ROOT, name: 'HARNESS.md', kind: 'harness-md' }]
  })

  const nodes = serialize(index, ROOT)
  const plainNode = nodes.find((n) => n.id === ROOT + '/plain')

  assert.equal(plainNode.foldedFilePath, undefined)
})

test('a leaf-descriptor file is NOT folded and keeps its own node with no foldedFilePath', () => {
  const index = fakeIndex(ROOT, {
    dirs: [
      { id: ROOT, name: 'root', kind: 'harness-root' },
      { id: ROOT + '/skill', name: 'skill', parentId: ROOT, kind: 'leaf' }
    ],
    files: [
      { id: ROOT + '/HARNESS.md', parentId: ROOT, name: 'HARNESS.md', kind: 'harness-md' },
      { id: ROOT + '/skill/SKILL.md', parentId: ROOT + '/skill', name: 'SKILL.md', kind: 'leaf-descriptor' }
    ]
  })

  const nodes = serialize(index, ROOT)

  assert.equal(nodes.length, 3, 'the leaf descriptor keeps its own node, unlike HARNESS.md/routing')
  const descriptorNode = nodes.find((n) => n.id === ROOT + '/skill/SKILL.md')
  assert.ok(descriptorNode)
  assert.equal(descriptorNode.foldedFilePath, undefined)
})
