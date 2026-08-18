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

function classifyFile(
  name: string,
  parentDirName: string,
  parentLeafType: string | null
): HarnessKind {
  if (name === 'HARNESS.md') return 'harness-md'
  const routingName = `${parentDirName.toUpperCase()}.md`
  if (name === routingName || name === 'SKILLS.md') return 'routing'
  if (parentLeafType && name === `${parentLeafType.toUpperCase()}.md`) return 'leaf-descriptor'
  return 'file'
}

export function buildHarnessIndex(rootPath: string): HarnessIndex {
  const index: HarnessIndex = new Map()

  function scanDir(dirPath: string, name: string): IndexEntry {
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

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue
        const childEntry = scanDir(path.join(dirPath, entry.name), entry.name)
        children.push(childEntry.node)
        if (childEntry.relevant) anyChildRelevant = true
      } else {
        const fileKind = classifyFile(entry.name, name, leafType)
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
      }
    }

    const relevant = RELEVANT_KINDS.has(kind) || anyChildRelevant
    const entry: IndexEntry = { node, children, relevant }
    index.set(dirPath, entry)
    return entry
  }

  scanDir(rootPath, path.basename(rootPath) || rootPath)
  return index
}
