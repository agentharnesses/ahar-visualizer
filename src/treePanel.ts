import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { buildHarnessIndex, HarnessIndex } from './harness'
import { buildHarnessHierarchy, HierarchyNode } from './hierarchy'
import { TranscriptWatcher } from './transcriptWatcher'

// Fixed, well-known path (not a per-session temp dir) so the debug trail can
// be read directly from outside the Extension Development Host — e.g. `tail
// -f /tmp/ahar-visualizer-debug.log` — while iterating on the live-glow pipeline,
// without needing to relay screenshots of the in-panel log back and forth.
const DEBUG_LOG_PATH = '/tmp/ahar-visualizer-debug.log'

function appendDebugLog(message: string): void {
  try {
    fs.appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${message}\n`)
  } catch {
    // Best-effort only; never let logging itself break the extension.
  }
}

interface VizNode {
  id: string
  parentId: string | null
  name: string
  isDirectory: boolean
  kind: string
  leafType?: string
  hasRoutingChild?: boolean
  /** Absolute path of the HARNESS.md/routing file folded into this directory
   *  (if any) — folded files don't get their own node, so without this,
   *  there'd be no way to open them from the tree at all. */
  foldedFilePath?: string
}

/** Files that are purely structural (HARNESS.md, routing indexes) don't get their own
 *  node — they only inform their parent directory's color, already computed as
 *  hasRoutingChild / the harness-root kind in harness.ts. */
function isFoldedIntoParent(kind: string): boolean {
  return kind === 'harness-md' || kind === 'routing'
}

function serialize(index: HarnessIndex, rootPath: string): VizNode[] {
  const nodes: VizNode[] = []
  const nodeById = new Map<string, VizNode>()

  function walk(fsPath: string, parentId: string | null): void {
    const entry = index.get(fsPath)
    if (!entry) return
    const n = entry.node
    if (isFoldedIntoParent(n.kind)) {
      // Record the folded file's path on its parent's already-created viz
      // node so the tree can still offer to open it, even though the file
      // itself never became a node.
      if (parentId) {
        const parentNode = nodeById.get(parentId)
        if (parentNode) parentNode.foldedFilePath = n.fsPath
      }
      return
    }
    const vizNode: VizNode = {
      id: n.fsPath,
      parentId,
      name: n.name,
      isDirectory: n.isDirectory,
      kind: n.kind,
      leafType: n.leafType,
      hasRoutingChild: n.hasRoutingChild
    }
    nodes.push(vizNode)
    nodeById.set(vizNode.id, vizNode)
    for (const child of entry.children) {
      walk(child.fsPath, n.fsPath)
    }
  }

  walk(rootPath, null)
  return nodes
}

/** One row of the "Harnesses" navigator panel — id matches a real node id
 *  from serialize() above 1:1 (both are keyed by the harness-root
 *  directory's own fsPath), so the client can look it up directly in the
 *  same `byId` map the main tree already uses; there is no second graph
 *  here, just a differently-shaped index into the same one. */
interface VizHarnessNode {
  id: string
  parentId: string | null
  name: string
  relPath: string
  virtual?: boolean
}

function serializeHierarchyList(hierarchy: HierarchyNode[], rootPath: string): VizHarnessNode[] {
  return hierarchy.map((n) => {
    const relPath = n.virtual ? n.name : (() => {
      const rel = path.relative(rootPath, n.id)
      return rel === '' ? '.' : rel
    })()
    return { id: n.id, parentId: n.parentId, name: n.name, relPath, virtual: n.virtual }
  })
}

export interface CollapseConfig {
  maxDepth: number
  maxNodesBeforeCollapse: number
  maxChildrenBeforeCollapse: number
  maxNodesOnExpand: number
}

/** Shared with hierarchyPanel.ts — both panels obey the same four
 *  `aharVisualizer.max*` settings ("max nodes rules"), so there is exactly
 *  one place that reads them. */
export function readCollapseConfig(): CollapseConfig {
  const cfg = vscode.workspace.getConfiguration('aharVisualizer')
  return {
    maxDepth: cfg.get<number>('maxDepth', 6),
    maxNodesBeforeCollapse: cfg.get<number>('maxNodesBeforeCollapse', 400),
    maxChildrenBeforeCollapse: cfg.get<number>('maxChildrenBeforeCollapse', 50),
    maxNodesOnExpand: cfg.get<number>('maxNodesOnExpand', 200)
  }
}

export function getNonce(): string {
  let text = ''
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length))
  return text
}

export class HarnessTreePanel {
  static current: HarnessTreePanel | undefined

  private readonly panel: vscode.WebviewPanel
  private readonly rootPath: string
  private readonly disposables: vscode.Disposable[] = []
  private readonly watcher: TranscriptWatcher

  static createOrShow(rootPath: string): void {
    if (HarnessTreePanel.current) {
      HarnessTreePanel.current.panel.reveal(vscode.ViewColumn.Beside)
      HarnessTreePanel.current.refresh()
      return
    }
    const panel = vscode.window.createWebviewPanel(
      'aharVisualizer.treeVisualization',
      'Harness Tree',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    )
    HarnessTreePanel.current = new HarnessTreePanel(panel, rootPath)
  }

  static refreshIfOpen(): void {
    HarnessTreePanel.current?.refresh()
  }

  private constructor(panel: vscode.WebviewPanel, rootPath: string) {
    this.panel = panel
    this.rootPath = rootPath

    try {
      fs.writeFileSync(DEBUG_LOG_PATH, '') // fresh log per panel session
    } catch {
      // best-effort
    }
    appendDebugLog(`panel constructed · rootPath=${rootPath}`)

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables)
    this.panel.webview.onDidReceiveMessage(
      async (message: { type: string; path?: string; message?: string }) => {
        if (message.type === 'openFile' && message.path) {
          const uri = vscode.Uri.file(message.path)
          await vscode.window.showTextDocument(uri, { preview: true })
          await vscode.commands.executeCommand('revealInExplorer', uri)
        } else if (message.type === 'refresh') {
          this.refresh()
        } else if (message.type === 'clientDebug' && message.message) {
          appendDebugLog(`[client] ${message.message}`)
        } else if (message.type === 'openSettings') {
          await vscode.commands.executeCommand('workbench.action.openSettings', 'aharVisualizer')
        }
      },
      null,
      this.disposables
    )

    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (e.affectsConfiguration('aharVisualizer')) this.refresh()
      },
      null,
      this.disposables
    )

    // Render first so the webview's script is loaded (and its message
    // listener attached) before the watcher can post anything to it —
    // otherwise the earliest debug/step messages have nothing listening yet
    // and are silently dropped.
    this.refresh()

    this.watcher = new TranscriptWatcher(
      rootPath,
      (step, filePaths) => {
        void this.panel.webview.postMessage({ type: 'step', step, filePaths })
      },
      (message) => {
        appendDebugLog(`[host] ${message}`)
        void this.panel.webview.postMessage({ type: 'debug', source: 'host', message })
      },
      () => {
        void this.panel.webview.postMessage({ type: 'sessionReset' })
      },
      vscode.workspace.getConfiguration('aharVisualizer').get<number>('rescanIntervalMs', 400)
    )
    this.watcher.start()
  }

  refresh(): void {
    const index = buildHarnessIndex(this.rootPath)
    const nodes = serialize(index, this.rootPath)
    const harnessNodes = serializeHierarchyList(buildHarnessHierarchy(index, this.rootPath), this.rootPath)
    this.panel.webview.html = renderHtml(nodes, harnessNodes, readCollapseConfig())
  }

  private dispose(): void {
    HarnessTreePanel.current = undefined
    this.watcher.stop()
    this.panel.dispose()
    while (this.disposables.length) {
      this.disposables.pop()?.dispose()
    }
  }
}

function renderHtml(nodes: VizNode[], harnessNodes: VizHarnessNode[], collapseConfig: CollapseConfig): string {
  const nonce = getNonce()
  const data = JSON.stringify(nodes)
  const harnessData = JSON.stringify(harnessNodes)
  const configData = JSON.stringify(collapseConfig)

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  :root { color-scheme: dark light; }
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
  #canvas { width: 100%; height: 100%; display: block; cursor: grab; }
  #canvas.panning { cursor: grabbing; }
  /* Three readable tiers, each strictly more prominent than the last:
     never-visited (dim/plain) < visited-but-cold (clearly brighter, static,
     permanent) < hot (bright animated glow on top of the visited styling).
     Visited must never end up LESS prominent than never-visited — that was
     a real bug here (visited edges were rendering at *lower* opacity than
     plain ones) — so the never-visited baselines below are deliberately
     dim to leave headroom for "visited" to clearly outrank them. */
  .node .shape { stroke: var(--vscode-editor-background); stroke-width: 1; opacity: 0.75; }
  .node .glow { fill: none; stroke: var(--vscode-charts-orange); stroke-width: 3; opacity: 0; pointer-events: none; }
  .node.muted .shape { opacity: 0.32; }
  .node.visited .shape {
    opacity: 1; stroke: var(--vscode-charts-orange); stroke-opacity: 0.75; stroke-width: 1.5;
  }
  .node.visited.muted .shape { opacity: 0.8; }
  .node.selected .shape { stroke: var(--vscode-focusBorder); stroke-width: 2; }
  .node.hovered .shape { stroke: var(--vscode-foreground); stroke-width: 1.5; }
  .node.has-children .shape { cursor: pointer; }
  /* Collapsed-directory indicator: a single arrow, always shown while
     collapsed (so it reads as "collapsed, click to expand" even with no
     activity inside). Its own opacity/fill track the max freshness hidden
     inside — dim by default, a static brighter orange once anything inside
     has been visited, brightening further while that activity is hot. */
  .collapse-arrow { fill: var(--vscode-descriptionForeground); opacity: 0.55; pointer-events: none; }
  .collapse-arrow.visited { fill: var(--vscode-charts-orange); }
  .edge { fill: none; stroke: var(--vscode-widget-border, #454545); stroke-width: 1; opacity: 0.3; }
  .edge.visited { stroke: var(--vscode-charts-orange); stroke-width: 1.25; opacity: 0.8; }
  .edge-glow { fill: none; stroke: var(--vscode-charts-orange); stroke-width: 4; opacity: 0; pointer-events: none; }
  #tooltip, #info {
    position: absolute; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, #454545);
    border-radius: 6px; padding: 8px 10px; font-size: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.3); pointer-events: none;
  }
  #tooltip { display: none; z-index: 10; }
  #tooltip.visible { display: block; }
  #tooltip .name { font-weight: 600; }
  #tooltip .kind { color: var(--vscode-descriptionForeground); }
  #info {
    top: 12px; right: 12px; width: 260px; max-height: calc(100% - 24px); overflow: auto;
    display: none; pointer-events: auto;
  }
  #info.visible { display: block; }
  #info h3 { margin: 0 0 6px 0; font-size: 13px; word-break: break-word; }
  #info .row { margin: 4px 0; color: var(--vscode-descriptionForeground); }
  #info .path { word-break: break-all; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
  #info button {
    margin-top: 8px; margin-right: 6px; background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 3px; padding: 4px 10px; cursor: pointer; font-size: 12px;
  }
  #info button:hover { background: var(--vscode-button-hoverBackground); }
  #info button.secondary { background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border: 1px solid var(--vscode-widget-border, #454545); }
  #info button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
  /* Tucked into the corner and dimmed until touched, so it stays out of the
     way of the tree itself rather than competing with it for attention. */
  #toolbar {
    position: absolute; top: 8px; left: 8px; display: flex; gap: 9px;
    opacity: 0.45; transition: opacity 0.12s ease;
  }
  #toolbar:hover, #toolbar:focus-within { opacity: 1; }
  .toolbar-group { display: flex; gap: 3px; }
  #toolbar button {
    background: var(--vscode-editorWidget-background); color: var(--vscode-foreground);
    border: 1px solid var(--vscode-widget-border, #454545); border-radius: 4px; width: 22px; height: 22px; cursor: pointer;
    font-size: 11px;
  }
  #toolbar button:hover { background: var(--vscode-list-hoverBackground); }
  /* --- Legend: sleek, grouped, collapsible --- */
  #legend {
    position: absolute; bottom: 16px; left: 8px; width: 210px;
    background: var(--vscode-editorWidget-background);
    backdrop-filter: blur(10px);
    border: 1px solid var(--vscode-widget-border, #454545);
    border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.35);
    font-size: 11px;
    overflow: hidden;
    transition: width 0.12s ease;
  }
  /* Collapsed: shrink down to just enough for the label + toggle, instead of
     leaving a full-width empty header sitting on screen. */
  #legend.collapsed { width: auto; opacity: 0.6; }
  #legend.collapsed:hover { opacity: 1; }
  /* Shifted up out of the way whenever the debug log panel is open, since
     that panel would otherwise sit on top of it at the bottom of the view. */
  #legend.debugOpen { bottom: 176px; }
  #legendHeader {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    padding: 6px 10px; font-size: 11px; font-weight: 600; letter-spacing: 0.02em;
    border-bottom: 1px solid var(--vscode-widget-border, #454545);
    cursor: pointer; user-select: none;
  }
  #legend.collapsed #legendHeader { padding: 3px 6px 3px 8px; font-size: 10px; border-bottom: none; }
  #legendHeader:hover { background: var(--vscode-list-hoverBackground); }
  #legendToggle {
    background: transparent; border: none; color: var(--vscode-descriptionForeground);
    font-size: 12px; line-height: 1; width: 16px; height: 16px; cursor: pointer;
  }
  #legendBody { padding: 8px 10px 10px; max-height: 260px; overflow-y: auto; }
  #legendBody.collapsed { display: none; }
  .legend-title {
    font-size: 9px; text-transform: uppercase; letter-spacing: 0.09em;
    color: var(--vscode-descriptionForeground); opacity: 0.8; margin: 8px 0 4px;
  }
  .legend-title:first-child { margin-top: 0; }
  .legend-row { display: flex; align-items: center; gap: 7px; margin: 3px 0; color: var(--vscode-foreground); }
  .legend-row.dim { color: var(--vscode-descriptionForeground); }
  .legend-swatch { display: inline-block; width: 10px; height: 10px; flex-shrink: 0; box-sizing: border-box; }
  .legend-swatch.sq { border-radius: 3px; }
  .legend-swatch.ci { border-radius: 50%; }
  .legend-swatch.muted { opacity: 0.45; }
  .legend-swatch.ring { background: transparent; border: 1.5px solid var(--vscode-charts-orange); opacity: 0.85; }
  .legend-swatch.hot { background: var(--vscode-charts-orange); box-shadow: 0 0 5px 1px var(--vscode-charts-orange); }
  .legend-swatch.arrow {
    width: 0; height: 0; background: transparent;
    border-left: 5px solid transparent; border-right: 5px solid transparent;
    border-top: 6px solid var(--vscode-charts-orange); opacity: 0.85;
  }
  .legend-swatch.flash { border: 1.5px solid var(--vscode-focusBorder); background: transparent; }
  .legend-swatch.phantom { border: 1.5px dashed var(--vscode-charts-purple, var(--vscode-charts-orange)); background: transparent; }
  .legend-divider { height: 1px; background: var(--vscode-widget-border, #454545); opacity: 0.6; margin: 6px 0; }
  /* --- Harnesses navigator: same sleek/collapsible chrome as the legend,
     mirrored to the opposite corner so the two never compete for space. A
     flat, depth-indented list of every HARNESS.md-bearing directory —
     independent of current collapse state, since its whole purpose is to
     reach a harness the graph might currently be hiding. */
  #harnessList {
    position: absolute; bottom: 16px; right: 8px; width: 250px;
    background: var(--vscode-editorWidget-background);
    backdrop-filter: blur(10px);
    border: 1px solid var(--vscode-widget-border, #454545);
    border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.35);
    font-size: 11px;
    overflow: hidden;
    transition: width 0.12s ease;
  }
  #harnessList.collapsed { width: auto; opacity: 0.6; }
  #harnessList.collapsed:hover { opacity: 1; }
  #harnessList.debugOpen { bottom: 176px; }
  #harnessListHeader {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    padding: 6px 10px; font-size: 11px; font-weight: 600; letter-spacing: 0.02em;
    border-bottom: 1px solid var(--vscode-widget-border, #454545);
    cursor: pointer; user-select: none;
  }
  #harnessList.collapsed #harnessListHeader { padding: 3px 6px 3px 8px; font-size: 10px; border-bottom: none; }
  #harnessListHeader:hover { background: var(--vscode-list-hoverBackground); }
  #harnessListToggle {
    background: transparent; border: none; color: var(--vscode-descriptionForeground);
    font-size: 12px; line-height: 1; width: 16px; height: 16px; cursor: pointer;
  }
  #harnessListBody { max-height: 280px; overflow-y: auto; padding: 4px 4px 6px; }
  #harnessListBody.collapsed { display: none; }
  #harnessListEmpty { padding: 10px; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .harness-row { display: flex; align-items: center; gap: 4px; padding: 3px 6px; border-radius: 4px; }
  .harness-row:hover { background: var(--vscode-list-hoverBackground); }
  .harness-indent { flex-shrink: 0; }
  .harness-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .harness-name.virtual { color: var(--vscode-descriptionForeground); font-style: italic; }
  .harness-row button {
    flex-shrink: 0; background: transparent; color: var(--vscode-foreground);
    border: 1px solid var(--vscode-widget-border, #454545); border-radius: 3px;
    width: 20px; height: 20px; font-size: 11px; cursor: pointer; line-height: 1; padding: 0;
  }
  .harness-row button:hover { background: var(--vscode-list-hoverBackground); }
  /* --- Go To / Isolate: ephemeral only — every element these create times
     itself out and removes itself; nothing here is persistent state. --- */
  @keyframes aharFlashPulse { 0% { opacity: 0; } 18% { opacity: 0.95; } 100% { opacity: 0; } }
  .flash-ring { fill: none; stroke: var(--vscode-focusBorder); stroke-width: 3; pointer-events: none; animation: aharFlashPulse 1.3s ease-out forwards; }
  .flash-edge { fill: none; stroke: var(--vscode-focusBorder); stroke-width: 4; pointer-events: none; animation: aharFlashPulse 1.3s ease-out forwards; }
  .phantom-edge { fill: none; stroke: var(--vscode-charts-purple, var(--vscode-charts-orange)); stroke-width: 2.5; stroke-dasharray: 3 3; pointer-events: none; animation: aharFlashPulse 2.2s ease-out forwards; }
  .phantom-marker { fill: var(--vscode-editor-background); stroke: var(--vscode-charts-purple, var(--vscode-charts-orange)); stroke-width: 2; pointer-events: none; animation: aharFlashPulse 2.2s ease-out forwards; }
  .phantom-label { fill: var(--vscode-charts-purple, var(--vscode-charts-orange)); font-size: 10px; pointer-events: none; animation: aharFlashPulse 2.2s ease-out forwards; }
  /* Tiny always-visible pill that's the *only* thing on screen for the
     debug log until someone actually wants it — sits above the panel
     itself (higher z-index) so it stays reachable to collapse again once
     the panel is open. Centered at the bottom rather than pinned to either
     corner, since both corners are already spoken for by the legend
     (bottom-left) and the Harnesses navigator (bottom-right). */
  #debugLogToggle {
    position: absolute; left: 50%; transform: translateX(-50%); bottom: 8px; z-index: 7;
    padding: 2px 6px; font-size: 9px; line-height: 1.4; letter-spacing: 0.02em;
    background: var(--vscode-editorWidget-background); color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-widget-border, #454545); border-radius: 3px; cursor: pointer;
    opacity: 0.45; transition: opacity 0.12s ease;
  }
  #debugLogToggle:hover { opacity: 1; }
  #debugLog {
    position: absolute; left: 0; right: 0; bottom: 0; height: 160px; z-index: 6;
    background: var(--vscode-editor-background); border-top: 1px solid var(--vscode-widget-border, #454545);
    display: flex; flex-direction: column;
  }
  #debugLog.collapsed { display: none; }
  #debugLogHeader {
    display: flex; align-items: center; justify-content: space-between; padding: 3px 8px;
    border-bottom: 1px solid var(--vscode-widget-border, #454545); font-size: 11px;
    color: var(--vscode-descriptionForeground); flex-shrink: 0;
  }
  #debugLogHeader button {
    background: transparent; color: var(--vscode-descriptionForeground); border: none; cursor: pointer; font-size: 11px;
    text-decoration: underline;
  }
  #debugLogBody {
    flex: 1; overflow-y: auto; padding: 4px 8px; font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10.5px; line-height: 1.5;
  }
  #debugLogBody .line { white-space: pre-wrap; word-break: break-all; }
  #debugLogBody .host { color: var(--vscode-charts-blue); }
  #debugLogBody .client { color: var(--vscode-charts-green); }
  #debugLogBody .step { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<svg id="canvas">
  <g id="viewport">
    <g id="edgeGlowLayer"></g>
    <g id="edgeLayer"></g>
    <g id="nodeLayer"></g>
    <g id="flashLayer"></g>
  </g>
</svg>
<div id="toolbar">
  <div class="toolbar-group" id="navGroup">
    <button id="zoomIn" title="Zoom in">+</button>
    <button id="zoomOut" title="Zoom out">−</button>
    <button id="zoomReset" title="Fit to view">⤢</button>
  </div>
  <div class="toolbar-group" id="refreshGroup">
    <button id="refreshBtn" title="Refresh from disk">⟳</button>
  </div>
  <div class="toolbar-group" id="treeOpsGroup">
    <button id="collapseLayerBtn" title="Collapse the tree's single deepest visible layer">−1</button>
    <button id="expandLayerBtn" title="Expand the tree's shallowest collapsed layer">+1</button>
  </div>
  <div class="toolbar-group" id="settingsGroup">
    <button id="settingsBtn" title="Open ahar-visualizer settings">⚙</button>
  </div>
</div>
<div id="legend">
  <div id="legendHeader">
    <span>Legend</span>
    <button id="legendToggle" title="Collapse legend">−</button>
  </div>
  <div id="legendBody">
    <div class="legend-title">Structure</div>
    <div class="legend-row"><span class="legend-swatch sq" style="background:var(--vscode-charts-red)"></span>Harness root</div>
    <div class="legend-row"><span class="legend-swatch sq" style="background:var(--vscode-charts-yellow)"></span>Routing directory</div>
    <div class="legend-row"><span class="legend-swatch sq" style="background:var(--vscode-charts-blue)"></span>Leaf directory</div>
    <div class="legend-row"><span class="legend-swatch ci" style="background:var(--vscode-charts-blue)"></span>Leaf descriptor</div>
    <div class="legend-row dim"><span class="legend-swatch sq muted" style="background:var(--vscode-descriptionForeground)"></span>Not harness-relevant</div>
    <div class="legend-row dim">▢ directory &nbsp; ● file</div>
    <div class="legend-divider"></div>
    <div class="legend-title">This session</div>
    <div class="legend-row"><span class="legend-swatch sq ring"></span>Visited, now cold</div>
    <div class="legend-row"><span class="legend-swatch sq hot"></span>Currently hot</div>
    <div class="legend-row dim"><span class="legend-swatch arrow"></span>Collapsed — arrow brightens with max activity inside</div>
    <div class="legend-divider"></div>
    <div class="legend-title">Go to / Isolate</div>
    <div class="legend-row dim"><span class="legend-swatch sq flash"></span>Ephemeral highlight (fades on its own)</div>
    <div class="legend-row dim"><span class="legend-swatch sq phantom"></span>Phantom edge — target is hidden beneath here</div>
  </div>
</div>
<div id="harnessList">
  <div id="harnessListHeader">
    <span>Harnesses</span>
    <button id="harnessListToggle" title="Collapse list">−</button>
  </div>
  <div id="harnessListBody"></div>
</div>
<svg id="connectorSvg" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5;">
  <line id="connectorLine" x1="0" y1="0" x2="0" y2="0" stroke="var(--vscode-focusBorder)" stroke-width="1.5" stroke-dasharray="4 3" opacity="0" />
</svg>
<div id="tooltip"></div>
<div id="info"></div>
<button id="debugLogToggle" title="Show/hide the debug log">log</button>
<div id="debugLog">
  <div id="debugLogHeader">
    <span>Debug log — blue: transcript watcher, green: this panel's own touch resolution</span>
    <button id="debugLogClear">clear</button>
  </div>
  <div id="debugLogBody"></div>
</div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const nodes = ${data};
  const harnessNodes = ${harnessData};
  const config = ${configData};

  const SIZE = 16, H_GAP = 12, V_GAP = 42;
  const DECAY_STEPS = 40; // freshness fades to 0 over this many observed transcript lines, not wall-clock time

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenOf = new Map(nodes.map((n) => [n.id, []]));
  let root = null;
  for (const n of nodes) {
    if (n.parentId === null) root = n;
    else if (childrenOf.has(n.parentId)) childrenOf.get(n.parentId).push(n.id);
  }

  /** Greedily adds directories within rootId's subtree to collapsedSet
   *  (rootId itself is never added) until the number of visible nodes in
   *  that subtree is at or under cap, preferring to collapse the deepest
   *  directories first so shallow structure stays visible as long as
   *  possible. Bounded by whatever's currently visible in the subtree, not
   *  by total tree size, so it stays cheap even on a very large harness.
   *
   *  This is a heuristic, not an exact solver: when the frontier contains
   *  nested ancestor/descendant pairs (the common case for a wide tree), a
   *  later ancestor pick can be credited for size already removed by an
   *  earlier descendant pick, so in rare cases the final visible count can
   *  land a little above cap rather than exactly at it. That's an
   *  acceptable trade-off for a soft, best-effort cap — it never
   *  under-collapses catastrophically or loops indefinitely. */
  function collapseToFit(rootId, cap, collapsedSet) {
    const subtreeSize = new Map();
    function sizeOf(id) {
      if (subtreeSize.has(id)) return subtreeSize.get(id);
      let s = 1;
      for (const k of childrenOf.get(id) || []) s += sizeOf(k);
      subtreeSize.set(id, s);
      return s;
    }

    const frontier = [];
    let visibleCount = 0;
    function collect(id, depth) {
      visibleCount++;
      const n = byId.get(id);
      const kids = childrenOf.get(id) || [];
      if (n.isDirectory && kids.length > 0 && !collapsedSet.has(id)) {
        if (id !== rootId) frontier.push({ id, depth });
        for (const k of kids) collect(k, depth + 1);
      }
    }
    collect(rootId, 0);

    if (visibleCount <= cap) return;
    frontier.sort((a, b) => b.depth - a.depth); // deepest first
    for (const { id } of frontier) {
      if (visibleCount <= cap) break;
      if (collapsedSet.has(id)) continue;
      collapsedSet.add(id);
      visibleCount -= sizeOf(id) - 1;
    }
  }

  /** Initial auto-collapse applied on load/refresh: first a single O(n) pass
   *  collapsing anything past config.maxDepth or with more than
   *  config.maxChildrenBeforeCollapse direct children, then a
   *  collapseToFit() pass (scoped to whatever that first pass left visible)
   *  to bring the total under config.maxNodesBeforeCollapse. */
  function computeAutoCollapse() {
    const autoCollapsed = new Set();
    function firstPass(id, depth) {
      const n = byId.get(id);
      const kids = childrenOf.get(id) || [];
      if (n.isDirectory && kids.length > 0) {
        if (depth >= config.maxDepth || kids.length > config.maxChildrenBeforeCollapse) {
          autoCollapsed.add(id);
          return;
        }
      }
      for (const k of kids) firstPass(k, depth + 1);
    }
    if (root) firstPass(root.id, 0);
    if (root) collapseToFit(root.id, config.maxNodesBeforeCollapse, autoCollapsed);
    return autoCollapsed;
  }

  function isRelevant(n) {
    if (n.isDirectory) return n.kind === 'harness-root' || n.hasRoutingChild || n.kind === 'leaf';
    return n.kind === 'leaf-descriptor';
  }

  function colorFor(n) {
    if (!isRelevant(n)) return 'var(--vscode-descriptionForeground)';
    if (n.isDirectory) {
      if (n.kind === 'harness-root') return 'var(--vscode-charts-red)';
      if (n.hasRoutingChild) return 'var(--vscode-charts-yellow)';
      return 'var(--vscode-charts-blue)'; // leaf
    }
    return 'var(--vscode-charts-blue)'; // leaf-descriptor
  }

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.getElementById('canvas');
  const viewport = document.getElementById('viewport');
  const edgeGlowLayer = document.getElementById('edgeGlowLayer');
  const edgeLayer = document.getElementById('edgeLayer');
  const nodeLayer = document.getElementById('nodeLayer');
  const flashLayer = document.getElementById('flashLayer');

  function el(tag, attrs) {
    const e = document.createElementNS(svgNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  // These maps only ever hold entries for the CURRENTLY VISIBLE/rendered
  // elements — they're cleared and rebuilt by renderTree() every time
  // visibility changes, so anything iterating them is automatically scoped
  // to "what's on screen right now", not the whole (potentially huge) tree.
  const edgeGlowById = new Map(); // child id -> glow path element for edge(child, parent)
  const edgeById = new Map(); // child id -> plain edge path element for edge(child, parent)
  const nodeGlowById = new Map(); // node id -> glow shape element
  const nodeGroupById = new Map(); // node id -> the node's <g> element
  const collapseArrowById = new Map(); // node id -> its collapsed-indicator arrow element
  // Unlike the maps above, this persists node position regardless of shape —
  // used by the "Harnesses" navigator's Go To/Isolate actions to center on
  // and flash-highlight a node that may not be the one currently
  // hovered/selected. Same "only currently visible" scoping as the rest.
  const nodeXY = new Map(); // node id -> {x, y} top-left of its shape, in viewport space

  const collapsed = computeAutoCollapse(); // directory node ids currently collapsed

  // Pan/zoom state. Declared here (rather than down by the wheel/drag
  // listeners that actually use tx/ty/scale for panning) because renderTree()
  // below also needs to read and adjust tx — and renderTree() is called once
  // during initial script setup, before that listener-wiring code below ever
  // runs. Moving just this declaration up avoids a temporal-dead-zone crash
  // on load (see the "TDZ ordering bug" regression test).
  let scale = 1, tx = 40, ty = 40;
  // The root node's logical x from the last render, so renderTree() can
  // shift tx to compensate for however much the tidy-tree layout moved
  // root's x this time — keeping root visually anchored on screen across
  // collapse/expand instead of the whole graph jumping sideways.
  let lastRootX = null;

  // --- Live glow, driven by conversation steps (transcript lines), not time ---
  let currentStep = 0;
  const lastTouchedStep = new Map(); // node id -> step at which it was last touched

  function resolveToNodeId(filePath) {
    let p = filePath;
    while (p && p.length > 1) {
      if (byId.has(p)) return p;
      const idx = p.lastIndexOf('/');
      if (idx <= 0) break;
      p = p.slice(0, idx);
    }
    return null;
  }

  function freshnessOf(id) {
    const t = lastTouchedStep.get(id);
    if (t === undefined) return 0;
    const delta = currentStep - t;
    return Math.max(0, 1 - delta / DECAY_STEPS);
  }

  /** Max current freshness (and whether anything was ever touched) among a
   *  node's DESCENDANTS — used only for collapsed nodes' summary bar, so
   *  this walk is bounded by however many nodes are actually collapsed at
   *  once (typically a handful), not by tree size. */
  function subtreeSummary(id) {
    let maxFreshness = 0;
    let anyVisited = false;
    function walk(nid) {
      if (lastTouchedStep.has(nid)) {
        anyVisited = true;
        const f = freshnessOf(nid);
        if (f > maxFreshness) maxFreshness = f;
      }
      for (const c of childrenOf.get(nid) || []) walk(c);
    }
    for (const c of childrenOf.get(id) || []) walk(c);
    return { maxFreshness, anyVisited };
  }

  /** Tidy-tree layout restricted to the currently-visible node set: a
   *  collapsed directory is treated as childless here, so this never
   *  recurses into a collapsed subtree — an O(1) cost for that branch no
   *  matter how many thousands of descendants it's hiding. Layout cost is
   *  always proportional to what's actually on screen, never to total tree
   *  size, which is the whole point for a "very very large" tree. */
  function computeVisible() {
    const order = [];
    const vx = new Map();
    const vDepth = new Map();
    let leafCounter = 0;

    function visit(id, d) {
      order.push(id);
      vDepth.set(id, d);
      const n = byId.get(id);
      const kids = n.isDirectory && !collapsed.has(id) ? childrenOf.get(id) || [] : [];
      if (kids.length === 0) {
        const x = leafCounter * (SIZE + H_GAP);
        leafCounter++;
        vx.set(id, x);
        return x;
      }
      const xs = kids.map((k) => visit(k, d + 1));
      const x = (Math.min(...xs) + Math.max(...xs)) / 2;
      vx.set(id, x);
      return x;
    }
    if (root) visit(root.id, 0);
    return { order, vx, vDepth };
  }

  const tooltip = document.getElementById('tooltip');
  const info = document.getElementById('info');
  const connectorLine = document.getElementById('connectorLine');
  // Declared here (rather than down by the header-click wiring that uses
  // them) because renderHarnessList() — called once, right after the first
  // renderTree() — needs harnessListBody long before the bottom-of-script
  // wiring section runs. Same TDZ-avoidance rationale as tx/ty/scale above.
  const harnessList = document.getElementById('harnessList');
  const harnessListHeader = document.getElementById('harnessListHeader');
  const harnessListBody = document.getElementById('harnessListBody');
  const harnessListToggle = document.getElementById('harnessListToggle');
  let selectedEl = null;
  let hoveredEl = null;

  function updateConnector() {
    if (!selectedEl || !info.classList.contains('visible')) {
      connectorLine.setAttribute('opacity', '0');
      return;
    }
    const nodeRect = selectedEl.getBoundingClientRect();
    const infoRect = info.getBoundingClientRect();
    const nx = nodeRect.left + nodeRect.width / 2;
    const ny = nodeRect.top + nodeRect.height / 2;
    const ix = infoRect.left;
    const iy = Math.min(Math.max(ny, infoRect.top + 10), infoRect.bottom - 10);
    connectorLine.setAttribute('x1', String(nx));
    connectorLine.setAttribute('y1', String(ny));
    connectorLine.setAttribute('x2', String(ix));
    connectorLine.setAttribute('y2', String(iy));
    connectorLine.setAttribute('opacity', '0.8');
  }

  function updateGlow() {
    // Only ever touches elements that exist right now (the maps are
    // rebuilt to exactly the visible set on every renderTree() call), so
    // this is O(visible), not O(total nodes).
    for (const [id, glowEl] of nodeGlowById) {
      glowEl.style.opacity = String(freshnessOf(id));
      const group = nodeGroupById.get(id);
      if (group) group.classList.toggle('visited', lastTouchedStep.has(id));
    }
    for (const [childId, edgeGlow] of edgeGlowById) {
      const n = byId.get(childId);
      // Edge glow's *value* is the parent's freshness, but it's gated on
      // the child having some freshness entry of its own (touched
      // directly, or marked as an immediate parent via the one-hop rule
      // below). Without that gate, EVERY child of a fresh node gets a
      // glowing edge leading to it — including siblings that were never
      // touched at all, which looks like a connection to nowhere.
      const childIsOnATouchedPath = lastTouchedStep.has(childId);
      edgeGlow.style.opacity = String(childIsOnATouchedPath ? freshnessOf(n.parentId) : 0);
      const edge = edgeById.get(childId);
      if (edge) edge.classList.toggle('visited', childIsOnATouchedPath);
    }
    for (const [id, arrow] of collapseArrowById) {
      const { maxFreshness, anyVisited } = subtreeSummary(id);
      arrow.classList.toggle('visited', anyVisited);
      // Once anything inside has ever been visited, opacity never drops
      // back below 0.35 (a permanent "visited-cold" floor, same as nodes
      // and edges elsewhere) — it only rises above that toward 1 while the
      // touch is still hot. Left at '' (the CSS baseline, 0.55, dim gray)
      // until anything inside is visited at all.
      arrow.style.opacity = anyVisited ? String(Math.max(maxFreshness, 0.35)) : '';
    }
  }

  /** Clears and rebuilds the DOM for exactly the currently-visible node
   *  set. Called on load and on every collapse/expand toggle — cost is
   *  always O(visible), never O(total), because computeVisible() above
   *  never walks into a collapsed subtree in the first place. */
  function renderTree(reselectId) {
    while (edgeGlowLayer.firstChild) edgeGlowLayer.removeChild(edgeGlowLayer.firstChild);
    while (edgeLayer.firstChild) edgeLayer.removeChild(edgeLayer.firstChild);
    while (nodeLayer.firstChild) nodeLayer.removeChild(nodeLayer.firstChild);
    edgeGlowById.clear();
    edgeById.clear();
    nodeGlowById.clear();
    nodeGroupById.clear();
    collapseArrowById.clear();
    nodeXY.clear();

    const { order, vx, vDepth } = computeVisible();

    // Collapsing/expanding anywhere re-runs the tidy-tree layout, which can
    // shift every logical x — including root's own, since it's the average
    // of its children's x all the way down. Left alone, that makes the
    // whole graph visibly jump sideways on every toggle. Compensate by
    // shifting tx the opposite amount root's x just moved, so root (and by
    // extension the whole graph relative to it) stays visually anchored on
    // screen. Skipped on the very first render — nothing to anchor against
    // yet, just record the baseline.
    if (root) {
      const newRootX = vx.get(root.id);
      if (lastRootX !== null) tx += (lastRootX - newRootX) * scale;
      lastRootX = newRootX;
    }

    for (const id of order) {
      const n = byId.get(id);
      if (n.parentId === null) continue;
      const px = vx.get(n.parentId) + SIZE / 2;
      const py = vDepth.get(n.parentId) * (SIZE + V_GAP) + SIZE;
      const cx = vx.get(id) + SIZE / 2;
      const cy = vDepth.get(id) * (SIZE + V_GAP);
      const midY = (py + cy) / 2;
      const d = 'M ' + px + ' ' + py + ' C ' + px + ' ' + midY + ', ' + cx + ' ' + midY + ', ' + cx + ' ' + cy;
      const glowPath = el('path', { class: 'edge-glow', 'data-child-id': id, d });
      edgeGlowLayer.appendChild(glowPath);
      edgeGlowById.set(id, glowPath);
      const edgePath = el('path', { class: 'edge', 'data-child-id': id, d });
      edgeLayer.appendChild(edgePath);
      edgeById.set(id, edgePath);
    }

    for (const id of order) {
      const n = byId.get(id);
      const x = vx.get(id);
      const y = vDepth.get(id) * (SIZE + V_GAP);
      nodeXY.set(id, { x, y });
      const relevant = isRelevant(n);
      const kids = childrenOf.get(id) || [];
      const hasChildren = n.isDirectory && kids.length > 0;
      const isCollapsed = hasChildren && collapsed.has(id);
      let cls = 'node';
      if (!relevant) cls += ' muted';
      if (hasChildren) cls += ' has-children';
      if (isCollapsed) cls += ' collapsed';
      const g = el('g', { class: cls, 'data-id': id, transform: 'translate(' + x + ',' + y + ')' });
      const color = colorFor(n);
      const glowShape = n.isDirectory
        ? el('rect', { class: 'glow', x: -4, y: -4, width: SIZE + 8, height: SIZE + 8, rx: 5 })
        : el('circle', { class: 'glow', cx: SIZE / 2, cy: SIZE / 2, r: SIZE / 2 + 4 });
      g.appendChild(glowShape);
      nodeGlowById.set(id, glowShape);
      nodeGroupById.set(id, g);
      if (n.isDirectory) {
        g.appendChild(el('rect', { class: 'shape', width: SIZE, height: SIZE, rx: 3, fill: color }));
      } else {
        g.appendChild(el('circle', { class: 'shape', cx: SIZE / 2, cy: SIZE / 2, r: SIZE / 2, fill: color }));
      }
      if (isCollapsed) {
        // A single small downward chevron beneath the node, always shown
        // while collapsed; its own opacity/fill (set in updateGlow) track
        // the max freshness hidden inside. Positioned clear of the node's
        // glow ring below (ring's outer edge sits at roughly SIZE + 5.5,
        // from the -4 padding plus half its 3px stroke) so the two never
        // overlap.
        const arrowTop = SIZE + 8, arrowH = 6;
        const arrowD = 'M 0 ' + arrowTop + ' L ' + SIZE + ' ' + arrowTop + ' L ' + (SIZE / 2) + ' ' + (arrowTop + arrowH) + ' Z';
        const arrow = el('path', { class: 'collapse-arrow', d: arrowD });
        g.appendChild(arrow);
        collapseArrowById.set(id, arrow);
      }
      // Generous invisible hit area so small shapes are easy to hover/click.
      const hitHeight = SIZE + 12 + (isCollapsed ? 10 : 0);
      g.appendChild(el('rect', { x: -6, y: -6, width: SIZE + 12, height: hitHeight, fill: 'transparent' }));
      nodeLayer.appendChild(g);
    }

    // Old element references are gone now — either restore selection onto
    // the (still-visible) node that triggered this re-render, or clear it.
    if (reselectId && nodeGroupById.has(reselectId)) {
      const newEl = nodeGroupById.get(reselectId);
      newEl.classList.add('selected');
      selectedEl = newEl;
      showInfo(byId.get(reselectId));
    } else {
      selectedEl = null;
      hoveredEl = null;
      info.classList.remove('visible');
      tooltip.classList.remove('visible');
    }

    updateGlow();
    updateTransform(); // applies the tx anchor-compensation above; also refreshes the connector line
  }

  /** Fully expands 'id' (removes it from collapsed), but re-collapses just
   *  enough of the newly-revealed subtree — deepest directories first — to
   *  keep what a single expand action reveals under config.maxNodesOnExpand.
   *  So one click on a huge collapsed subtree can never dump thousands of
   *  nodes onto the canvas at once.
   *
   *  Note: collapseToFit() can only hide *nested directories*, so a
   *  directory whose children are all flat files (no subdirectories to
   *  re-collapse) reveals every one of them regardless of this cap —
   *  config.maxChildrenBeforeCollapse is what keeps such a directory from
   *  auto-expanding in the first place; this only limits what a manual
   *  expand can cascade into further down. */
  function expandWithinCap(id) {
    collapsed.delete(id);
    collapseToFit(id, config.maxNodesOnExpand, collapsed);
  }

  /** Reveals just the direct children of 'id', keeping any grandchildren
   *  (children that are themselves non-empty directories) collapsed — a
   *  true "one layer at a time" expand, as opposed to expandWithinCap()'s
   *  "as much as fits" full expand. */
  function expandOneLayer(id) {
    collapsed.delete(id);
    for (const childId of childrenOf.get(id) || []) {
      const child = byId.get(childId);
      if (child.isDirectory && (childrenOf.get(childId) || []).length > 0) {
        collapsed.add(childId);
      }
    }
  }

  /** Depth (root = 0) of every node, keyed by id. Depth is a property of the
   *  static tree shape, not of what's currently collapsed/rendered, so this
   *  is always safe to recompute in full — used to synchronize +1/-1 across
   *  the *whole* tree by depth rather than letting each branch race ahead
   *  independently. */
  function depthOfEachNode() {
    const depths = new Map();
    function walk(id, depth) {
      depths.set(id, depth);
      for (const k of childrenOf.get(id) || []) walk(k, depth + 1);
    }
    if (root) walk(root.id, 0);
    return depths;
  }

  /** Global version of expandOneLayer(), synchronized by depth across the
   *  whole tree: finds the shallowest depth at which any node is still
   *  collapsed, and expands only the collapsed nodes at that depth — leaving
   *  every deeper collapsed node untouched. That shallowest layer is always
   *  fully filled in before a later click can reach any layer beneath it,
   *  so an uneven tree grows outward as one flat wavefront rather than its
   *  deepest branch racing ahead of its shallower siblings. */
  function expandOneLayerEverywhere() {
    if (collapsed.size === 0) return;
    const depths = depthOfEachNode();
    let minDepth = Infinity;
    for (const id of collapsed) {
      const d = depths.get(id);
      if (d !== undefined && d < minDepth) minDepth = d;
    }
    if (minDepth === Infinity) return;
    for (const id of Array.from(collapsed)) {
      if (depths.get(id) === minDepth) expandOneLayer(id);
    }
    renderTree();
  }

  /** Inverse of expandOneLayerEverywhere(), synchronized by depth across the
   *  whole tree: first finds every currently-expanded directory whose own
   *  children are all leaves/files/already-collapsed directories (i.e. the
   *  deepest still-visible branching point in its branch), same as before —
   *  but then collapses only the candidates sitting at the single greatest
   *  depth reached by *any* branch, leaving shallower branches' frontiers
   *  untouched until deeper branches have collapsed down to meet them. */
  function collapseOneLayerEverywhere() {
    const depths = depthOfEachNode();
    const candidates = [];
    function walk(id) {
      const n = byId.get(id);
      const kids = childrenOf.get(id) || [];
      if (!n.isDirectory || kids.length === 0 || collapsed.has(id)) return;
      const expandedChildDirs = kids.filter((cid) => {
        const c = byId.get(cid);
        const cKids = childrenOf.get(cid) || [];
        return c.isDirectory && cKids.length > 0 && !collapsed.has(cid);
      });
      if (expandedChildDirs.length === 0) {
        candidates.push(id);
      } else {
        for (const cid of expandedChildDirs) walk(cid);
      }
    }
    if (root) walk(root.id);
    if (candidates.length === 0) return; // already fully collapsed
    const maxDepth = Math.max(...candidates.map((id) => depths.get(id)));
    for (const id of candidates) {
      if (depths.get(id) === maxDepth) collapsed.add(id);
    }
    renderTree();
  }

  // --- "Harnesses" navigator: Go To / Isolate act on this same tree/graph
  // (byId, childrenOf, collapsed, nodeGroupById, edgeById) — there is no
  // second graph. All of it lives in the harnessNodes-driven panel below;
  // see renderHarnessList() near the bottom of this script.

  /** Every ancestor id of 'id', root-first, NOT including 'id' itself. */
  function strictAncestorsOf(id) {
    const chain = [];
    let cur = byId.get(id) ? byId.get(id).parentId : null;
    while (cur) {
      chain.push(cur);
      cur = byId.get(cur).parentId;
    }
    chain.reverse();
    return chain;
  }

  /** Every ancestor id of 'id', root-first, INCLUDING 'id' itself. */
  function chainFromRoot(id) {
    return strictAncestorsOf(id).concat([id]);
  }

  /** "Collapse all but that harness": expands every node on the path from
   *  root to targetId, collapses every sibling branch off that path, then
   *  caps whatever targetId's own subtree reveals the same way a manual
   *  expand does (config.maxNodesOnExpand via collapseToFit) — the "max
   *  nodes rules" this tree obeys everywhere else. */
  function isolateNode(targetId) {
    if (!byId.has(targetId)) return;
    const chain = chainFromRoot(targetId);
    const onPath = new Set(chain);
    for (const id of chain) collapsed.delete(id);
    for (const id of chain) {
      for (const childId of childrenOf.get(id) || []) {
        if (onPath.has(childId)) continue;
        const child = byId.get(childId);
        if (child.isDirectory && (childrenOf.get(childId) || []).length > 0) collapsed.add(childId);
      }
    }
    collapseToFit(targetId, config.maxNodesOnExpand, collapsed);
    renderTree(targetId);
    goTo(targetId);
  }

  /** Walks targetId's strict ancestors, root-first, and returns the first
   *  one that's currently collapsed — everything below a collapsed node is
   *  hidden, so that's the deepest node actually on screen along this path.
   *  Returns targetId itself (not cut off) if every ancestor is expanded. */
  function nearestVisibleAncestor(targetId) {
    for (const id of strictAncestorsOf(targetId)) {
      if (collapsed.has(id)) return { visibleId: id, cutoff: true };
    }
    return { visibleId: targetId, cutoff: false };
  }

  function animateTransform(targetTx, targetTy, targetScale, duration) {
    const startTx = tx, startTy = ty, startScale = scale;
    const startTime = performance.now();
    function step(now) {
      const t = Math.min(1, (now - startTime) / duration);
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      tx = startTx + (targetTx - startTx) * ease;
      ty = startTy + (targetTy - startTy) * ease;
      scale = startScale + (targetScale - startScale) * ease;
      updateTransform();
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  /** Every currently-rendered id in rootId's subtree: rootId itself, plus
   *  every descendant reachable without crossing a collapsed node (a
   *  collapsed node's own children are, by definition, not rendered).
   *  Bounded by what's actually on screen under rootId, same as
   *  computeVisible() — never walks into a collapsed branch. */
  function visibleSubtreeIds(rootId) {
    const ids = [rootId];
    function walk(id) {
      const kids = collapsed.has(id) ? [] : childrenOf.get(id) || [];
      for (const k of kids) {
        ids.push(k);
        walk(k);
      }
    }
    walk(rootId);
    return ids;
  }

  /** Bounding box (in viewport space) of every id in ids that's currently
   *  rendered — null if none are (shouldn't happen in practice, since every
   *  caller already confirmed rootId itself is rendered). */
  function boundsOfIds(ids) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of ids) {
      const xy = nodeXY.get(id);
      if (!xy) continue;
      minX = Math.min(minX, xy.x);
      minY = Math.min(minY, xy.y);
      maxX = Math.max(maxX, xy.x + SIZE);
      maxY = Math.max(maxY, xy.y + SIZE);
    }
    if (minX === Infinity) return null;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /** Scoped version of fitToView(): fits/centers the view on just this
   *  bounding box instead of the whole graph — same padding and max-zoom
   *  clamp, so "go to" a single leaf and "go to" a big subtree both land at
   *  a sensible, readable zoom instead of one static center point. */
  function centerOnBounds(bounds) {
    if (!bounds) return;
    const svgRect = svg.getBoundingClientRect();
    const pad = 60;
    const scaleX = (svgRect.width - pad) / Math.max(bounds.width, 1);
    const scaleY = (svgRect.height - pad) / Math.max(bounds.height, 1);
    const targetScale = Math.min(scaleX, scaleY, 3);
    const cx = bounds.x + bounds.width / 2, cy = bounds.y + bounds.height / 2;
    const targetTx = svgRect.width / 2 - cx * targetScale;
    const targetTy = svgRect.height / 2 - cy * targetScale;
    animateTransform(targetTx, targetTy, targetScale, 380);
  }

  function flashEdge(edgeEl) {
    if (!edgeEl) return;
    const flash = el('path', { class: 'flash-edge', d: edgeEl.getAttribute('d') });
    flashLayer.appendChild(flash);
    setTimeout(() => flash.remove(), 1350);
  }

  /** Ephemeral highlight: pulses rootId itself plus every node/edge in its
   *  currently-visible subtree (rootId's own inbound edge from ITS parent is
   *  deliberately left out — that edge leads outside the highlighted
   *  subtree). Purely visual — nothing here changes collapsed/selection
   *  state, and every element it creates removes itself on a timer. */
  function flashSubtree(rootId, ids) {
    for (const id of ids) {
      const xy = nodeXY.get(id);
      const n = byId.get(id);
      if (xy && n) {
        const ring = n.isDirectory
          ? el('rect', { class: 'flash-ring', x: xy.x - 4, y: xy.y - 4, width: SIZE + 8, height: SIZE + 8, rx: 5 })
          : el('circle', { class: 'flash-ring', cx: xy.x + SIZE / 2, cy: xy.y + SIZE / 2, r: SIZE / 2 + 4 });
        flashLayer.appendChild(ring);
        setTimeout(() => ring.remove(), 1350);
      }
      if (id !== rootId) flashEdge(edgeById.get(id));
    }
  }

  /** Renders a short dashed "phantom edge" hanging off visibleId, denoting
   *  that targetName's subgraph is nested somewhere beneath it but isn't
   *  currently rendered (some ancestor between the two is collapsed).
   *  Purely ephemeral, like flashSubtree() — removes itself after a few
   *  seconds; this is a visualization aid only, not new tree structure. */
  function renderPhantom(visibleId, targetName) {
    const xy = nodeXY.get(visibleId);
    if (!xy) return;
    const x0 = xy.x + SIZE / 2, y0 = xy.y + SIZE + 20;
    const y1 = y0 + 26;
    const phantomPath = el('path', { class: 'phantom-edge', d: 'M ' + x0 + ' ' + y0 + ' L ' + x0 + ' ' + y1 });
    const marker = el('circle', { class: 'phantom-marker', cx: x0, cy: y1, r: 5 });
    const label = el('text', { class: 'phantom-label', x: x0 + 9, y: y1 + 4 });
    label.textContent = targetName + ' is nested below here';
    flashLayer.appendChild(phantomPath);
    flashLayer.appendChild(marker);
    flashLayer.appendChild(label);
    setTimeout(() => { phantomPath.remove(); marker.remove(); label.remove(); }, 2250);
  }

  /** Selects and highlights targetId's whole currently-visible subtree (or,
   *  if targetId itself is hidden inside a collapsed ancestor, the nearest
   *  visible ancestor's subtree instead — which is just that one node, plus
   *  a phantom edge marking where the rest of it lives) — fitting/centering
   *  the view on the whole highlighted portion, not just a single point. */
  function goTo(targetId) {
    const target = byId.get(targetId);
    if (!target) return;
    const { visibleId, cutoff } = nearestVisibleAncestor(targetId);
    const g = nodeGroupById.get(visibleId);
    if (!g) return;

    if (selectedEl) selectedEl.classList.remove('selected');
    g.classList.add('selected');
    selectedEl = g;
    showInfo(byId.get(visibleId));
    updateConnector();

    const subtreeIds = visibleSubtreeIds(visibleId);
    centerOnBounds(boundsOfIds(subtreeIds));
    flashSubtree(visibleId, subtreeIds);
    if (cutoff) renderPhantom(visibleId, target.name);
  }

  /** Depth of every harness node WITHIN the harness-only hierarchy (root
   *  harness = 0, a harness nested one HARNESS.md boundary below it = 1,
   *  etc.) — deliberately independent of depthOfEachNode() above, which
   *  measures depth in the full file tree; a harness nested many plain
   *  directories deep should still indent by just one step here. */
  function harnessDepthOf(harnessChildrenOf, harnessRootId) {
    const depths = new Map();
    function walk(id, depth) {
      depths.set(id, depth);
      for (const k of harnessChildrenOf.get(id) || []) walk(k, depth + 1);
    }
    if (harnessRootId) walk(harnessRootId, 0);
    return depths;
  }

  /** Flat, depth-indented, always-complete list of every harness — unlike
   *  the graph, this ignores current collapse state entirely, since its
   *  whole purpose is to reach a harness that the graph might currently be
   *  hiding. Built once from harnessNodes (a separate, coarser index into
   *  the SAME tree — every id here is also a real id in byId, except the
   *  synthetic workspace anchor, which has no row actions since it isn't a
   *  real node). */
  function renderHarnessList() {
    const body = harnessListBody;
    body.innerHTML = '';
    if (harnessNodes.length === 0) {
      const empty = document.createElement('div');
      empty.id = 'harnessListEmpty';
      empty.textContent = 'No harnesses found in this workspace.';
      body.appendChild(empty);
      return;
    }
    const hById = new Map(harnessNodes.map((n) => [n.id, n]));
    const hChildrenOf = new Map(harnessNodes.map((n) => [n.id, []]));
    let hRoot = null;
    for (const n of harnessNodes) {
      if (n.parentId === null) hRoot = n;
      else if (hChildrenOf.has(n.parentId)) hChildrenOf.get(n.parentId).push(n.id);
    }
    const depths = harnessDepthOf(hChildrenOf, hRoot ? hRoot.id : null);

    function walk(id) {
      const n = hById.get(id);
      const row = document.createElement('div');
      row.className = 'harness-row';
      row.setAttribute('data-id', id);
      const indent = document.createElement('span');
      indent.className = 'harness-indent';
      indent.style.width = ((depths.get(id) || 0) * 12) + 'px';
      row.appendChild(indent);
      const nameEl = document.createElement('span');
      nameEl.className = 'harness-name' + (n.virtual ? ' virtual' : '');
      nameEl.textContent = n.name;
      nameEl.title = n.relPath;
      row.appendChild(nameEl);
      // The synthetic workspace anchor isn't a real node in byId — no
      // Go To/Isolate actions make sense on it, so it's label-only.
      if (!n.virtual) {
        const gotoBtn = document.createElement('button');
        gotoBtn.textContent = '👁️';
        gotoBtn.title = 'Go to ' + n.name + ' (centers it and briefly highlights the path to it)';
        gotoBtn.setAttribute('data-action', 'goto');
        gotoBtn.addEventListener('click', () => goTo(id));
        row.appendChild(gotoBtn);
        const isolateBtn = document.createElement('button');
        isolateBtn.textContent = '⛶';
        isolateBtn.title = 'Isolate ' + n.name + ' (collapse everything else, keeping the path to it)';
        isolateBtn.setAttribute('data-action', 'isolate');
        isolateBtn.addEventListener('click', () => isolateNode(id));
        row.appendChild(isolateBtn);
      }
      body.appendChild(row);
      for (const childId of hChildrenOf.get(id) || []) walk(childId);
    }
    if (hRoot) walk(hRoot.id);
  }

  const debugLogBody = document.getElementById('debugLogBody');
  function logDebug(source, message) {
    const line = document.createElement('div');
    line.className = 'line ' + source;
    line.textContent = '[' + source + '] ' + message;
    debugLogBody.appendChild(line);
    while (debugLogBody.children.length > 300) debugLogBody.removeChild(debugLogBody.firstChild);
    debugLogBody.scrollTop = debugLogBody.scrollHeight;
    // Relay client-side lines back to the extension host so they land in the
    // same unified /tmp/ahar-visualizer-debug.log as the host-side ones — 'host'
    // messages already originated there, so only 'client' ones get relayed
    // back (otherwise every host message would echo forever).
    if (source === 'client') vscode.postMessage({ type: 'clientDebug', message: message });
  }
  document.getElementById('debugLogClear').addEventListener('click', () => { debugLogBody.innerHTML = ''; });
  logDebug('client', 'panel script loaded (' + nodes.length + ' nodes), waiting for the transcript watcher...');

  renderTree();
  renderHarnessList(); // independent of collapse state, so only needs building once per refresh

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'debug') {
      logDebug(msg.source || 'host', msg.message);
      return;
    }
    if (msg.type === 'sessionReset') {
      lastTouchedStep.clear();
      currentStep = 0;
      updateGlow();
      logDebug('client', 'new session detected — cleared visited/hot state from any previous session');
      return;
    }
    if (msg.type === 'step') {
      currentStep = msg.step;
      const resolvedTouches = [];
      for (const fp of msg.filePaths || []) {
        // Mark the touched node fresh, plus its immediate containing
        // directory (one hop up), same step. The one-hop part matters for
        // files that keep their own node — e.g. a leaf's SKILL.md — because
        // without it, only that small file node would ever light up, never
        // the leaf directory it describes; a folded file (HARNESS.md/
        // routing) doesn't have this problem since resolveToNodeId already
        // has to walk up to *its* container to find any node at all.
        //
        // Deliberately NOT walking further up than one hop: freshness has
        // to stay something a node earns from an actual touch (its own, or
        // its immediate contents'), not something that leaks all the way to
        // root and back down every unrelated sibling subtree's edges. The
        // "go up the tree" effect the edge-glow rule below produces is real,
        // but it only chains through ancestors that are independently
        // fresh — from their *own* one-hop touches — not synthetically.
        const resolved = resolveToNodeId(fp);
        if (resolved) {
          lastTouchedStep.set(resolved, currentStep);
          const parentId = byId.get(resolved)?.parentId;
          if (parentId) lastTouchedStep.set(parentId, currentStep);
          resolvedTouches.push(fp + ' -> ' + resolved + (parentId ? ' (+parent ' + parentId + ')' : ' (root, no parent)'));
        } else {
          resolvedTouches.push(fp + ' -> UNRESOLVED (outside this tree, or no node matched)');
        }
      }
      if ((msg.filePaths || []).length > 0) {
        logDebug('client', 'step ' + currentStep + ': ' + resolvedTouches.join(' | '));
      }
      updateGlow();
      updateConnector();
    }
  });

  // Pan/zoom drag state (scale/tx/ty themselves are declared earlier, next
  // to computeAutoCollapse() — see the comment there).
  let panning = false, dragStartX = 0, dragStartY = 0, didDrag = false;

  function updateTransform() {
    viewport.setAttribute('transform', 'translate(' + tx + ',' + ty + ') scale(' + scale + ')');
    updateConnector();
  }
  updateTransform();

  /** Scales/centers the graph to fit the panel — both horizontally and
   *  vertically, dead center, not just fit-width-and-pad-from-top. Called
   *  once on initial load (see the requestAnimationFrame() call at the
   *  bottom of this script) and again on every "resize" (zoomReset) button
   *  click, so both share this one computation: the default view *is* what
   *  the button produces, and since it's a pure function of the current
   *  graph bounds, pressing the button always snaps back to that same
   *  centered position rather than some other fit. */
  function fitToView() {
    const bounds = viewport.getBBox();
    const svgRect = svg.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return;
    const pad = 60;
    const scaleX = (svgRect.width - pad) / bounds.width;
    const scaleY = (svgRect.height - pad) / bounds.height;
    scale = Math.min(scaleX, scaleY, 3);
    tx = (svgRect.width - bounds.width * scale) / 2 - bounds.x * scale;
    ty = (svgRect.height - bounds.height * scale) / 2 - bounds.y * scale;
    updateTransform();
  }

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const rect = svg.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const newScale = Math.min(Math.max(scale * (1 - e.deltaY * 0.01), 0.1), 5);
      tx = cx - ((cx - tx) * newScale) / scale;
      ty = cy - ((cy - ty) * newScale) / scale;
      scale = newScale;
    } else {
      tx -= e.deltaX;
      ty -= e.deltaY;
    }
    updateTransform();
  }, { passive: false });

  svg.addEventListener('mousedown', (e) => {
    panning = true;
    didDrag = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    svg.classList.add('panning');
  });
  window.addEventListener('mousemove', (e) => {
    if (!panning) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag = true;
    tx += e.movementX;
    ty += e.movementY;
    updateTransform();
  });
  window.addEventListener('mouseup', () => {
    panning = false;
    svg.classList.remove('panning');
  });

  document.getElementById('zoomIn').addEventListener('click', () => { scale = Math.min(scale * 1.2, 5); updateTransform(); });
  document.getElementById('zoomOut').addEventListener('click', () => { scale = Math.max(scale / 1.2, 0.1); updateTransform(); });
  document.getElementById('zoomReset').addEventListener('click', fitToView);
  document.getElementById('refreshBtn').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  document.getElementById('collapseLayerBtn').addEventListener('click', collapseOneLayerEverywhere);
  document.getElementById('expandLayerBtn').addEventListener('click', expandOneLayerEverywhere);
  document.getElementById('settingsBtn').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));

  const legend = document.getElementById('legend');
  const legendHeader = document.getElementById('legendHeader');
  const legendBody = document.getElementById('legendBody');
  const legendToggle = document.getElementById('legendToggle');
  legendHeader.addEventListener('click', () => {
    const collapsedNow = legendBody.classList.toggle('collapsed');
    legend.classList.toggle('collapsed', collapsedNow);
    legendToggle.textContent = collapsedNow ? '+' : '−';
  });

  harnessListHeader.addEventListener('click', () => {
    const collapsedNow = harnessListBody.classList.toggle('collapsed');
    harnessList.classList.toggle('collapsed', collapsedNow);
    harnessListToggle.textContent = collapsedNow ? '+' : '−';
  });

  const debugLog = document.getElementById('debugLog');
  const debugLogToggle = document.getElementById('debugLogToggle');
  debugLog.classList.add('collapsed'); // starts tucked away; set here (not just in markup) so it's a single source of truth
  debugLogToggle.addEventListener('click', () => {
    const collapsedNow = debugLog.classList.toggle('collapsed');
    legend.classList.toggle('debugOpen', !collapsedNow);
    harnessList.classList.toggle('debugOpen', !collapsedNow);
  });

  function kindLabel(n) {
    if (n.isDirectory) {
      if (n.kind === 'harness-root') return 'harness root';
      if (n.hasRoutingChild) return 'directory (routing)';
      if (n.kind === 'leaf') return 'leaf (' + (n.leafType || '?') + ')';
      return 'directory';
    }
    if (n.kind === 'leaf-descriptor') return 'leaf descriptor';
    return 'file';
  }

  svg.addEventListener('mouseover', (e) => {
    const target = e.target.closest('[data-id]');
    if (!target || target === hoveredEl) return;
    if (hoveredEl) hoveredEl.classList.remove('hovered');
    hoveredEl = target;
    hoveredEl.classList.add('hovered');
    const n = byId.get(target.getAttribute('data-id'));
    const hint = target.classList.contains('has-children')
      ? '<div class="kind">double-click to ' + (target.classList.contains('collapsed') ? 'expand' : 'collapse') + '</div>'
      : '';
    tooltip.innerHTML = '<div class="name">' + escapeHtml(n.name) + '</div><div class="kind">' + escapeHtml(kindLabel(n)) + '</div>' + hint;
    tooltip.classList.add('visible');
  });
  svg.addEventListener('mousemove', (e) => {
    if (!tooltip.classList.contains('visible')) return;
    tooltip.style.left = (e.clientX + 14) + 'px';
    tooltip.style.top = (e.clientY + 14) + 'px';
  });
  svg.addEventListener('mouseout', (e) => {
    const target = e.target.closest('[data-id]');
    const to = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('[data-id]') : null;
    if (target && target === to) return;
    if (hoveredEl) hoveredEl.classList.remove('hovered');
    hoveredEl = null;
    tooltip.classList.remove('visible');
  });

  svg.addEventListener('click', (e) => {
    if (didDrag) return;
    const target = e.target.closest('[data-id]');
    if (selectedEl) selectedEl.classList.remove('selected');
    if (!target) {
      info.classList.remove('visible');
      selectedEl = null;
      updateConnector();
      return;
    }
    target.classList.add('selected');
    selectedEl = target;
    const n = byId.get(target.getAttribute('data-id'));
    showInfo(n);
    updateConnector();
  });

  svg.addEventListener('dblclick', (e) => {
    const target = e.target.closest('[data-id]');
    if (!target) return;
    const id = target.getAttribute('data-id');
    const n = byId.get(id);
    if (!n) return;
    if (n.isDirectory) {
      if ((childrenOf.get(id) || []).length === 0) return;
      if (collapsed.has(id)) expandWithinCap(id); else collapsed.add(id);
      renderTree(id);
    } else {
      vscode.postMessage({ type: 'openFile', path: n.id });
    }
  });

  function showInfo(n) {
    const kids = childrenOf.get(n.id) || [];
    const hasChildren = n.isDirectory && kids.length > 0;
    const isCollapsed = hasChildren && collapsed.has(n.id);
    const foldedName = n.foldedFilePath ? n.foldedFilePath.slice(n.foldedFilePath.lastIndexOf('/') + 1) : null;
    info.innerHTML =
      '<h3>' + escapeHtml(n.name) + '</h3>' +
      '<div class="row">' + escapeHtml(kindLabel(n)) + '</div>' +
      (n.isDirectory ? '<div class="row">Children: ' + kids.length + '</div>' : '') +
      '<div class="row path">' + escapeHtml(n.id) + '</div>' +
      (!n.isDirectory ? '<button id="openBtn">Open File</button>' : '') +
      (foldedName ? '<button id="openFoldedBtn">Open ' + escapeHtml(foldedName) + '</button>' : '') +
      (isCollapsed ? '<button id="expandLayerBtn2" class="secondary">Expand 1 layer</button>' : '') +
      (hasChildren ? '<button id="collapseBtn" class="secondary">' + (isCollapsed ? 'Expand' : 'Collapse') + ' subtree</button>' : '');
    info.classList.add('visible');
    if (!n.isDirectory) {
      const btn = document.getElementById('openBtn');
      if (btn) btn.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: n.id }));
    }
    if (foldedName) {
      const foldedBtn = document.getElementById('openFoldedBtn');
      if (foldedBtn) foldedBtn.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: n.foldedFilePath }));
    }
    if (isCollapsed) {
      const ebtn = document.getElementById('expandLayerBtn2');
      if (ebtn) ebtn.addEventListener('click', () => {
        expandOneLayer(n.id);
        renderTree(n.id);
      });
    }
    if (hasChildren) {
      const cbtn = document.getElementById('collapseBtn');
      if (cbtn) cbtn.addEventListener('click', () => {
        if (collapsed.has(n.id)) expandWithinCap(n.id); else collapsed.add(n.id);
        renderTree(n.id);
      });
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  requestAnimationFrame(fitToView);
})();
</script>
</body>
</html>`
}
