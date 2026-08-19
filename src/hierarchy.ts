import * as path from 'node:path'
import { HarnessIndex } from './harness'

/** A node in the harness-only hierarchy: one entry per HARNESS.md-bearing
 *  directory, parented to its nearest harness-root ANCESTOR — not its
 *  immediate filesystem parent. Everything in between (plain directories,
 *  routing dirs, leaf skills/references) is invisible here; this view is
 *  purely about how harnesses nest inside one another. */
export interface HierarchyNode {
  id: string
  parentId: string | null
  name: string
  /** True only for the single synthetic anchor node used when the workspace
   *  itself isn't a harness root, or contains more than one independent
   *  top-level harness — see buildHarnessHierarchy() below. Never a real
   *  HARNESS.md-bearing directory. */
  virtual?: boolean
}

export const VIRTUAL_ROOT_ID = '__ahar_hierarchy_virtual_root__'

/**
 * Derives the harness-nesting tree from the same HarnessIndex the file-tree
 * view uses: walk the real directory tree, and every time a 'harness-root'
 * directory is found, parent it to whichever harness-root ancestor was most
 * recently seen above it (skipping every plain/leaf/routing directory in
 * between) — exactly the "Nested Harnesses" boundary rule documented in the
 * agent-harnesses skill (a directory's own HARNESS.md resets the boundary
 * for everything beneath it).
 *
 * The common case (a single harness-root at the workspace root, like this
 * repo) needs no synthetic wrapper — that node just IS the tree's root. Only
 * when the workspace root isn't itself a harness root, or the walk finds
 * more than one independent top-level harness, is a single synthetic anchor
 * node introduced so the result is always one connected tree (never a
 * forest) — the client's layout code assumes exactly one root.
 */
export function buildHarnessHierarchy(index: HarnessIndex, rootPath: string): HierarchyNode[] {
  const nodes: HierarchyNode[] = []
  const nodeById = new Map<string, HierarchyNode>()
  const topLevelIds: string[] = []

  function walk(fsPath: string, nearestHarnessAncestorId: string | null): void {
    const entry = index.get(fsPath)
    if (!entry || !entry.node.isDirectory) return
    const n = entry.node
    let nextAncestor = nearestHarnessAncestorId
    if (n.kind === 'harness-root') {
      const hNode: HierarchyNode = { id: n.fsPath, parentId: nearestHarnessAncestorId, name: n.name }
      nodes.push(hNode)
      nodeById.set(hNode.id, hNode)
      if (nearestHarnessAncestorId === null) topLevelIds.push(hNode.id)
      nextAncestor = hNode.id
    }
    for (const child of entry.children) {
      if (child.isDirectory) walk(child.fsPath, nextAncestor)
    }
  }

  walk(rootPath, null)

  const rootIsSoleHarness = topLevelIds.length === 1 && topLevelIds[0] === rootPath
  if (!rootIsSoleHarness) {
    const virtualRoot: HierarchyNode = {
      id: VIRTUAL_ROOT_ID,
      parentId: null,
      name: path.basename(rootPath) || rootPath,
      virtual: true
    }
    for (const id of topLevelIds) {
      const n = nodeById.get(id)
      if (n) n.parentId = VIRTUAL_ROOT_ID
    }
    nodes.unshift(virtualRoot)
  }

  return nodes
}
