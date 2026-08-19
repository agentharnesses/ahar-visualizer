import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Ported from the agent-harnesses skill's disclose.py / map_references.py —
 * same .harnessleaf / .leaf-detectors / routing-filename conventions, kept
 * in sync by hand since there's no shared package between the two yet.
 */

export type HarnessKind =
  | 'harness-root'
  | 'group'
  | 'leaf'
  | 'harness-md'
  | 'routing'
  | 'leaf-descriptor'
  | 'file'

export interface HarnessNode {
  fsPath: string
  name: string
  isDirectory: boolean
  kind: HarnessKind
  leafType?: string
  /** Directories only: true if a direct child file is a routing index (e.g. SKILLS.md). */
  hasRoutingChild?: boolean
}

export interface IndexEntry {
  node: HarnessNode
  children: HarnessNode[]
  relevant: boolean
}

export type HarnessIndex = Map<string, IndexEntry>

const SKIP_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'out',
  'dist',
  'build',
  '.vscode-test',
  '.next',
  '__pycache__',
  '.venv',
  'venv'
])

/** Exposed so callers outside this module (e.g. the workspace file watcher
 *  that triggers a live tree refresh) can skip the same directories this
 *  scan already ignores, instead of re-deriving or duplicating the list. */
export function isSkippedDirName(name: string): boolean {
  return SKIP_DIR_NAMES.has(name)
}

const RELEVANT_KINDS = new Set<HarnessKind>([
  'harness-root',
  'leaf',
  'harness-md',
  'routing',
  'leaf-descriptor'
])

function parseLeafDetectors(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const leafType = line.slice(0, eq).trim()
    const relPath = line.slice(eq + 1).trim()
    if (leafType && relPath) result[leafType] = relPath
  }
  return result
}

function findLeafDetectors(dir: string): Record<string, string> | null {
  let current = dir
  while (true) {
    const configPath = path.join(current, '.leaf-detectors')
    if (fs.existsSync(configPath)) {
      try {
        return parseLeafDetectors(fs.readFileSync(configPath, 'utf-8'))
      } catch {
        return null
      }
    }
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function detectLeafType(dir: string): string | null {
  const harnessLeafPath = path.join(dir, '.harnessleaf')
  if (fs.existsSync(harnessLeafPath)) {
    try {
      const text = fs.readFileSync(harnessLeafPath, 'utf-8')
      const firstLine = text
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0)
      if (firstLine) return firstLine
    } catch {
      // fall through to structural detection
    }
  }
  const detectors = findLeafDetectors(dir)
  if (!detectors) return null
  for (const [leafType, relPath] of Object.entries(detectors)) {
    if (fs.existsSync(path.join(dir, relPath))) return leafType
  }
  return null
}

/**
 * The name every routing file directly inside a directory must use is NOT
 * that directory's own name — it's the name of whichever ancestor-or-self
 * directory sits immediately below the nearest harness-root boundary (the
 * overall root, or a nested harness — a directory with its own HARNESS.md),
 * propagated unchanged through every nesting level beneath that boundary.
 * E.g. skills/maintenance/'s routing file is SKILLS.md (inherited from
 * skills/, the top-level directory), not MAINTENANCE.md — until a nested
 * harness resets the boundary and propagation starts over from whatever
 * sits directly below *that*. See the "Nested Harnesses" section of
 * vendor/agentharnesses/docs/specification.mdx for the spec-level writeup,
 * and find_top_level_dir_name() in the agent-harnesses skill's disclose.py
 * for the equivalent Python implementation — kept in sync by hand, see the
 * module comment above.
 */
function classifyFile(name: string, topLevelDirName: string, parentLeafType: string | null): HarnessKind {
  if (name === 'HARNESS.md') return 'harness-md'
  const routingName = `${topLevelDirName.toUpperCase()}.md`
  if (name === routingName) return 'routing'
  if (parentLeafType && name === `${parentLeafType.toUpperCase()}.md`) return 'leaf-descriptor'
  return 'file'
}

export function buildHarnessIndex(rootPath: string): HarnessIndex {
  const index: HarnessIndex = new Map()

  function scanDir(dirPath: string, name: string, topLevelDirName: string): IndexEntry {
    const leafType = detectLeafType(dirPath)
    const isHarnessRoot = fs.existsSync(path.join(dirPath, 'HARNESS.md'))
    const kind: HarnessKind = isHarnessRoot ? 'harness-root' : leafType ? 'leaf' : 'group'
    const node: HarnessNode = {
      fsPath: dirPath,
      name,
      isDirectory: true,
      kind,
      leafType: leafType ?? undefined
    }

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true })
    } catch {
      entries = []
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    const children: HarnessNode[] = []
    let anyChildRelevant = false
    let hasRoutingChild = false

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue
        // A harness-root boundary resets the top-level directory: each of
        // its direct children becomes its own fresh top-level directory for
        // its own subtree, rather than inheriting the parent's.
        const childTopLevelDirName = isHarnessRoot ? entry.name : topLevelDirName
        const childEntry = scanDir(path.join(dirPath, entry.name), entry.name, childTopLevelDirName)
        children.push(childEntry.node)
        if (childEntry.relevant) anyChildRelevant = true
      } else {
        const fileKind = classifyFile(entry.name, topLevelDirName, leafType)
        const fileNode: HarnessNode = {
          fsPath: path.join(dirPath, entry.name),
          name: entry.name,
          isDirectory: false,
          kind: fileKind
        }
        children.push(fileNode)
        const fileRelevant = RELEVANT_KINDS.has(fileKind)
        index.set(fileNode.fsPath, { node: fileNode, children: [], relevant: fileRelevant })
        if (fileRelevant) anyChildRelevant = true
        if (fileKind === 'routing') hasRoutingChild = true
      }
    }

    node.hasRoutingChild = hasRoutingChild
    const relevant = RELEVANT_KINDS.has(kind) || anyChildRelevant
    const entry: IndexEntry = { node, children, relevant }
    index.set(dirPath, entry)
    return entry
  }

  const rootName = path.basename(rootPath) || rootPath
  scanDir(rootPath, rootName, rootName)
  return index
}
