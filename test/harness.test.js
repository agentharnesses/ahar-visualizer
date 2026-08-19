const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')

const { buildHarnessIndex } = require('../out/harness.js')

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ahar-harness-test-'))
}

function write(root, relPath, content = '') {
  const full = path.join(root, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

test('a routing file is named after the top-level directory, not its own immediate directory', () => {
  // This is the exact bug reported by hand: skills/maintenance/'s routing
  // file must be SKILLS.md (inherited from skills/, the directory
  // immediately below the harness root), never MAINTENANCE.md.
  const root = tmpRepo()
  write(root, 'HARNESS.md')
  write(root, 'skills/SKILLS.md')
  write(root, 'skills/maintenance/SKILLS.md')

  const index = buildHarnessIndex(root)
  const maintenanceSkillsMd = index.get(path.join(root, 'skills/maintenance/SKILLS.md'))
  assert.equal(maintenanceSkillsMd.node.kind, 'routing')

  const maintenanceDir = index.get(path.join(root, 'skills/maintenance'))
  assert.equal(maintenanceDir.node.hasRoutingChild, true)
})

test('a file matching its own immediate directory name, but not the top-level directory, is NOT routing', () => {
  // The exact real-world case: references/diary/DIARY.md matches diary's own
  // name, but the top-level directory is "references" (diary's ancestor), so it should
  // be classified as a plain file, not routing.
  const root = tmpRepo()
  write(root, 'HARNESS.md')
  write(root, 'references/REFERENCES.md')
  write(root, 'references/diary/DIARY.md')

  const index = buildHarnessIndex(root)
  const diaryMd = index.get(path.join(root, 'references/diary/DIARY.md'))
  assert.equal(diaryMd.node.kind, 'file', 'DIARY.md does not match the "references" top-level directory name')

  const diaryDir = index.get(path.join(root, 'references/diary'))
  assert.equal(diaryDir.node.hasRoutingChild, false, 'diary/ has no valid routing file at all')
})

test('renaming to match the top-level directory name (REFERENCES.md) fixes the classification', () => {
  const root = tmpRepo()
  write(root, 'HARNESS.md')
  write(root, 'references/REFERENCES.md')
  write(root, 'references/diary/REFERENCES.md')

  const index = buildHarnessIndex(root)
  const referencesMd = index.get(path.join(root, 'references/diary/REFERENCES.md'))
  assert.equal(referencesMd.node.kind, 'routing')

  const diaryDir = index.get(path.join(root, 'references/diary'))
  assert.equal(diaryDir.node.hasRoutingChild, true)
})

test('a nested HARNESS.md resets the top-level directory for its own descendants', () => {
  const root = tmpRepo()
  write(root, 'HARNESS.md')
  write(root, 'skills/SKILLS.md')
  write(root, 'skills/sub-harness/HARNESS.md')
  write(root, 'skills/sub-harness/docs/DOCS.md')
  // Also confirm the OLD top-level directory name (skills/SKILLS.md-style) no longer
  // applies once a nested harness root is crossed.
  write(root, 'skills/sub-harness/docs/SKILLS.md')

  const index = buildHarnessIndex(root)
  const docsDir = index.get(path.join(root, 'skills/sub-harness/docs'))
  assert.equal(docsDir.node.hasRoutingChild, true)

  const docsDocsMd = index.get(path.join(root, 'skills/sub-harness/docs/DOCS.md'))
  assert.equal(docsDocsMd.node.kind, 'routing', 'DOCS.md matches the reset top-level directory ("docs")')

  const staleSkillsMd = index.get(path.join(root, 'skills/sub-harness/docs/SKILLS.md'))
  assert.equal(staleSkillsMd.node.kind, 'file', 'SKILLS.md no longer applies past the nested harness-root boundary')

  const subHarnessDir = index.get(path.join(root, 'skills/sub-harness'))
  assert.equal(subHarnessDir.node.kind, 'harness-root')
})

test('leaf-descriptor classification (SKILL.md) is unaffected by the top-level-directory-name fix', () => {
  const root = tmpRepo()
  write(root, 'HARNESS.md')
  write(root, 'skills/SKILLS.md')
  write(root, 'skills/maintenance/SKILLS.md')
  write(root, 'skills/maintenance/modify-harness/.harnessleaf', 'skill\n')
  write(root, 'skills/maintenance/modify-harness/SKILL.md')

  const index = buildHarnessIndex(root)
  const skillMd = index.get(path.join(root, 'skills/maintenance/modify-harness/SKILL.md'))
  assert.equal(skillMd.node.kind, 'leaf-descriptor')

  const leafDir = index.get(path.join(root, 'skills/maintenance/modify-harness'))
  assert.equal(leafDir.node.kind, 'leaf')
  assert.equal(leafDir.node.leafType, 'skill')
})

test('HARNESS.md itself is always classified as harness-md regardless of top-level directory name', () => {
  const root = tmpRepo()
  write(root, 'HARNESS.md')
  write(root, 'skills/SKILLS.md')

  const index = buildHarnessIndex(root)
  const harnessMd = index.get(path.join(root, 'HARNESS.md'))
  assert.equal(harnessMd.node.kind, 'harness-md')

  const rootEntry = index.get(root)
  assert.equal(rootEntry.node.kind, 'harness-root')
})
