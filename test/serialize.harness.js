// serialize() (and its isFoldedIntoParent() helper) live in treePanel.ts,
// which imports 'vscode' at module scope — unavailable outside a real
// extension host, so the compiled out/treePanel.js can't be require()'d
// directly in a plain Node test. Neither function actually touches vscode
// though, so this extracts just those two function definitions from the
// .ts source and transpiles that snippet with the real TypeScript compiler
// (already a devDependency) rather than hand-rolling a regex-based type
// stripper.

const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const SRC_PATH = path.join(__dirname, '..', 'src', 'treePanel.ts')

function loadSerialize() {
  const src = fs.readFileSync(SRC_PATH, 'utf8')
  const start = src.indexOf('function isFoldedIntoParent')
  const end = src.indexOf('function getNonce')
  if (start === -1 || end === -1) {
    throw new Error('Could not find isFoldedIntoParent/serialize in treePanel.ts — extraction markers may be stale')
  }
  const snippet = src.slice(start, end)
  const js = ts.transpileModule(snippet, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText

  const moduleObj = { exports: {} }
  const fn = new Function('module', 'exports', js + '\nmodule.exports = { isFoldedIntoParent, serialize };')
  fn(moduleObj, moduleObj.exports)
  return moduleObj.exports
}

/** Builds a fake HarnessIndex (the Map<string, IndexEntry> shape harness.ts's
 *  buildHarnessIndex() produces) from a plain description, so tests don't
 *  need a real filesystem. `dirs` and `files` describe nodes by fsPath. */
function fakeIndex(rootPath, describe) {
  const index = new Map()
  const childrenByParent = new Map()

  for (const d of describe.dirs || []) {
    index.set(d.id, {
      node: { fsPath: d.id, name: d.name, isDirectory: true, kind: d.kind, hasRoutingChild: !!d.hasRoutingChild },
      children: [],
      relevant: true
    })
    if (d.parentId) {
      if (!childrenByParent.has(d.parentId)) childrenByParent.set(d.parentId, [])
      childrenByParent.get(d.parentId).push(d.id)
    }
  }
  for (const f of describe.files || []) {
    index.set(f.id, {
      node: { fsPath: f.id, name: f.name, isDirectory: false, kind: f.kind },
      children: [],
      relevant: true
    })
    if (!childrenByParent.has(f.parentId)) childrenByParent.set(f.parentId, [])
    childrenByParent.get(f.parentId).push(f.id)
  }
  for (const [id, entry] of index) {
    entry.children = (childrenByParent.get(id) || []).map((cid) => index.get(cid).node)
  }
  return index
}

module.exports = { loadSerialize, fakeIndex }
