const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')

const { buildHarnessIndex } = require('../out/harness.js')
const { buildHarnessHierarchy, VIRTUAL_ROOT_ID } = require('../out/hierarchy.js')

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ahar-hierarchy-test-'))
}

function write(root, relPath, content = '') {
  const full = path.join(root, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

function byName(nodes) {
  return Object.fromEntries(nodes.map((n) => [n.name, n]))
}

test('a lone workspace-root harness needs no synthetic wrapper', () => {
  const root = tmpRepo()
  write(root, 'HARNESS.md')
  write(root, 'skills/SKILLS.md')

  const index = buildHarnessIndex(root)
  const hierarchy = buildHarnessHierarchy(index, root)

  assert.equal(hierarchy.length, 1)
  assert.equal(hierarchy[0].id, root)
  assert.equal(hierarchy[0].parentId, null)
  assert.equal(hierarchy[0].virtual, undefined)
})

test('a nested harness is parented to its nearest harness-root ancestor, skipping plain directories', () => {
  const root = tmpRepo()
  write(root, 'HARNESS.md')
  write(root, 'skills/SKILLS.md')
  write(root, 'skills/sub/deeper/HARNESS.md')

  const index = buildHarnessIndex(root)
  const hierarchy = buildHarnessHierarchy(index, root)
  const nodes = byName(hierarchy)

  assert.equal(hierarchy.length, 2)
  assert.equal(nodes[path.basename(root)].parentId, null)
  const subHarnessId = path.join(root, 'skills/sub/deeper')
  const subHarness = hierarchy.find((n) => n.id === subHarnessId)
  assert.ok(subHarness, 'nested harness-root should appear as its own node')
  assert.equal(subHarness.parentId, root, 'parented to the workspace root harness, not to skills/ or skills/sub/')
})

test('a harness nested inside another nested harness chains correctly, three levels deep', () => {
  const root = tmpRepo()
  write(root, 'HARNESS.md')
  write(root, 'a/HARNESS.md')
  write(root, 'a/b/c/HARNESS.md')

  const index = buildHarnessIndex(root)
  const hierarchy = buildHarnessHierarchy(index, root)

  const rootId = root
  const aId = path.join(root, 'a')
  const cId = path.join(root, 'a/b/c')

  assert.equal(hierarchy.length, 3)
  assert.equal(hierarchy.find((n) => n.id === aId).parentId, rootId)
  assert.equal(hierarchy.find((n) => n.id === cId).parentId, aId)
})

test('a workspace root with no HARNESS.md of its own gets a synthetic anchor', () => {
  const root = tmpRepo()
  write(root, 'project-a/HARNESS.md')

  const index = buildHarnessIndex(root)
  const hierarchy = buildHarnessHierarchy(index, root)

  const virtual = hierarchy.find((n) => n.id === VIRTUAL_ROOT_ID)
  assert.ok(virtual, 'synthetic anchor should be present')
  assert.equal(virtual.virtual, true)
  assert.equal(virtual.parentId, null)

  const projectA = hierarchy.find((n) => n.id === path.join(root, 'project-a'))
  assert.equal(projectA.parentId, VIRTUAL_ROOT_ID)
})

test('multiple independent top-level harnesses are collected under one synthetic anchor, not left as a forest', () => {
  const root = tmpRepo()
  write(root, 'project-a/HARNESS.md')
  write(root, 'project-b/HARNESS.md')

  const index = buildHarnessIndex(root)
  const hierarchy = buildHarnessHierarchy(index, root)

  const virtualNodes = hierarchy.filter((n) => n.virtual)
  assert.equal(virtualNodes.length, 1, 'exactly one synthetic anchor, even with two independent harnesses')

  const projectA = hierarchy.find((n) => n.id === path.join(root, 'project-a'))
  const projectB = hierarchy.find((n) => n.id === path.join(root, 'project-b'))
  assert.equal(projectA.parentId, VIRTUAL_ROOT_ID)
  assert.equal(projectB.parentId, VIRTUAL_ROOT_ID)
})

test('a workspace with no harnesses at all still returns a single synthetic anchor node', () => {
  const root = tmpRepo()
  write(root, 'README.md')

  const index = buildHarnessIndex(root)
  const hierarchy = buildHarnessHierarchy(index, root)

  assert.equal(hierarchy.length, 1)
  assert.equal(hierarchy[0].virtual, true)
})
