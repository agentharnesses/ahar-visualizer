import * as fs from 'node:fs'
import * as vscode from 'vscode'
import { buildHarnessIndex, HarnessIndex } from './harness'
import { TranscriptWatcher } from './transcriptWatcher'

// Fixed, well-known path (not a per-session temp dir) so the debug trail can
// be read directly from outside the Extension Development Host — e.g. `tail
// -f /tmp/ahar-vsvis-debug.log` — while iterating on the live-glow pipeline,
// without needing to relay screenshots of the in-panel log back and forth.
const DEBUG_LOG_PATH = '/tmp/ahar-vsvis-debug.log'

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
}

/** Files that are purely structural (HARNESS.md, routing indexes) don't get their own
 *  node — they only inform their parent directory's color, already computed as
 *  hasRoutingChild / the harness-root kind in harness.ts. */
function isFoldedIntoParent(kind: string): boolean {
  return kind === 'harness-md' || kind === 'routing'
}

function serialize(index: HarnessIndex, rootPath: string): VizNode[] {
  const nodes: VizNode[] = []

  function walk(fsPath: string, parentId: string | null): void {
    const entry = index.get(fsPath)
    if (!entry) return
    const n = entry.node
    if (isFoldedIntoParent(n.kind)) return
    nodes.push({
      id: n.fsPath,
      parentId,
      name: n.name,
      isDirectory: n.isDirectory,
      kind: n.kind,
      leafType: n.leafType,
      hasRoutingChild: n.hasRoutingChild
    })
    for (const child of entry.children) {
      walk(child.fsPath, n.fsPath)
    }
  }

  walk(rootPath, null)
  return nodes
}

function getNonce(): string {
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
      'aharVsvis.treeVisualization',
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
        }
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
      }
    )
    this.watcher.start()
  }

  refresh(): void {
    const index = buildHarnessIndex(this.rootPath)
    const nodes = serialize(index, this.rootPath)
    this.panel.webview.html = renderHtml(nodes)
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

function renderHtml(nodes: VizNode[]): string {
  const nonce = getNonce()
  const data = JSON.stringify(nodes)

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
  .node .glow { fill: var(--vscode-charts-orange); opacity: 0; pointer-events: none; }
  .node.muted .shape { opacity: 0.32; }
  .node.visited .shape {
    opacity: 1; stroke: var(--vscode-charts-orange); stroke-opacity: 0.75; stroke-width: 1.5;
  }
  .node.visited.muted .shape { opacity: 0.8; }
  .node.selected .shape { stroke: var(--vscode-focusBorder); stroke-width: 2; }
  .node.hovered .shape { stroke: var(--vscode-foreground); stroke-width: 1.5; }
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
    margin-top: 8px; background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 3px; padding: 4px 10px; cursor: pointer; font-size: 12px;
  }
  #info button:hover { background: var(--vscode-button-hoverBackground); }
  #legend {
    position: absolute; bottom: 172px; left: 12px; background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-widget-border, #454545); border-radius: 6px; padding: 8px 10px; font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }
  #legend .row { display: flex; align-items: center; gap: 6px; margin: 2px 0; }
  #legend .sq, #legend .ci { display: inline-block; width: 10px; height: 10px; }
  #legend .sq { border-radius: 2px; }
  #legend .ci { border-radius: 50%; }
  #legend .muted { opacity: 0.4; }
  #toolbar { position: absolute; top: 12px; left: 12px; display: flex; gap: 4px; }
  #toolbar button {
    background: var(--vscode-editorWidget-background); color: var(--vscode-foreground);
    border: 1px solid var(--vscode-widget-border, #454545); border-radius: 4px; width: 26px; height: 26px; cursor: pointer;
  }
  #toolbar button:hover { background: var(--vscode-list-hoverBackground); }
  #debugLog {
    position: absolute; left: 0; right: 0; bottom: 0; height: 160px; z-index: 6;
    background: var(--vscode-editor-background); border-top: 1px solid var(--vscode-widget-border, #454545);
    display: flex; flex-direction: column;
  }
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
  <defs>
    <filter id="glowBlur" x="-100%" y="-100%" width="300%" height="300%">
      <feGaussianBlur stdDeviation="4" result="blur" />
      <feMerge>
        <feMergeNode in="blur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  </defs>
  <g id="viewport">
    <g id="edgeGlowLayer"></g>
    <g id="edgeLayer"></g>
    <g id="nodeLayer"></g>
  </g>
</svg>
<div id="toolbar">
  <button id="zoomIn" title="Zoom in">+</button>
  <button id="zoomOut" title="Zoom out">−</button>
  <button id="zoomReset" title="Fit to view">⤢</button>
  <button id="refreshBtn" title="Refresh from disk">⟳</button>
</div>
<div id="legend">
  <div class="row"><span class="sq" style="background:var(--vscode-charts-red)"></span> Harness root (HARNESS.md)</div>
  <div class="row"><span class="sq" style="background:var(--vscode-charts-yellow)"></span> Directory with routing index</div>
  <div class="row"><span class="sq" style="background:var(--vscode-charts-blue)"></span> Leaf directory</div>
  <div class="row"><span class="ci" style="background:var(--vscode-charts-blue)"></span> Leaf descriptor file</div>
  <div class="row"><span class="sq muted" style="background:var(--vscode-descriptionForeground)"></span><span class="ci muted" style="background:var(--vscode-descriptionForeground)"></span> Not harness-standard-relevant</div>
  <div class="row" style="margin-top:4px">▢ directory &nbsp; ● file</div>
  <div class="row"><span class="sq" style="background:transparent;border:1.5px solid var(--vscode-charts-orange)"></span> Visited earlier, now cold</div>
  <div class="row"><span class="sq" style="background:var(--vscode-charts-orange)"></span> Currently hot (recently touched)</div>
</div>
<svg id="connectorSvg" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5;">
  <line id="connectorLine" x1="0" y1="0" x2="0" y2="0" stroke="var(--vscode-focusBorder)" stroke-width="1.5" stroke-dasharray="4 3" opacity="0" />
</svg>
<div id="tooltip"></div>
<div id="info"></div>
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

  const SIZE = 16, H_GAP = 12, V_GAP = 42;
  const DECAY_STEPS = 40; // freshness fades to 0 over this many observed transcript lines, not wall-clock time

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenOf = new Map(nodes.map((n) => [n.id, []]));
  let root = null;
  for (const n of nodes) {
    if (n.parentId === null) root = n;
    else if (childrenOf.has(n.parentId)) childrenOf.get(n.parentId).push(n.id);
  }

  const posX = new Map();
  const depth = new Map();
  let leafCounter = 0;

  function layout(id, d) {
    depth.set(id, d);
    const kids = childrenOf.get(id) || [];
    if (kids.length === 0) {
      const x = leafCounter * (SIZE + H_GAP);
      leafCounter++;
      posX.set(id, x);
      return x;
    }
    const xs = kids.map((k) => layout(k, d + 1));
    const x = (Math.min(...xs) + Math.max(...xs)) / 2;
    posX.set(id, x);
    return x;
  }
  if (root) layout(root.id, 0);

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

  function el(tag, attrs) {
    const e = document.createElementNS(svgNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  const edgeGlowById = new Map(); // child id -> glow path element for edge(child, parent)
  const edgeById = new Map(); // child id -> plain edge path element for edge(child, parent)
  const nodeGlowById = new Map(); // node id -> glow shape element
  const nodeGroupById = new Map(); // node id -> the node's <g> element

  // Edges
  for (const n of nodes) {
    if (n.parentId === null) continue;
    const px = posX.get(n.parentId) + SIZE / 2;
    const py = depth.get(n.parentId) * (SIZE + V_GAP) + SIZE;
    const cx = posX.get(n.id) + SIZE / 2;
    const cy = depth.get(n.id) * (SIZE + V_GAP);
    const midY = (py + cy) / 2;
    const d = 'M ' + px + ' ' + py + ' C ' + px + ' ' + midY + ', ' + cx + ' ' + midY + ', ' + cx + ' ' + cy;
    const glowPath = el('path', { class: 'edge-glow', 'data-child-id': n.id, d, filter: 'url(#glowBlur)' });
    edgeGlowLayer.appendChild(glowPath);
    edgeGlowById.set(n.id, glowPath);
    const edgePath = el('path', { class: 'edge', 'data-child-id': n.id, d });
    edgeLayer.appendChild(edgePath);
    edgeById.set(n.id, edgePath);
  }

  // Nodes
  for (const n of nodes) {
    const x = posX.get(n.id);
    const y = depth.get(n.id) * (SIZE + V_GAP);
    const relevant = isRelevant(n);
    const g = el('g', {
      class: 'node' + (relevant ? '' : ' muted'),
      'data-id': n.id,
      transform: 'translate(' + x + ',' + y + ')'
    });
    const color = colorFor(n);
    const glowShape = n.isDirectory
      ? el('rect', { class: 'glow', x: -4, y: -4, width: SIZE + 8, height: SIZE + 8, rx: 5, filter: 'url(#glowBlur)' })
      : el('circle', { class: 'glow', cx: SIZE / 2, cy: SIZE / 2, r: SIZE / 2 + 4, filter: 'url(#glowBlur)' });
    g.appendChild(glowShape);
    nodeGlowById.set(n.id, glowShape);
    nodeGroupById.set(n.id, g);
    if (n.isDirectory) {
      g.appendChild(el('rect', { class: 'shape', width: SIZE, height: SIZE, rx: 3, fill: color }));
    } else {
      g.appendChild(el('circle', { class: 'shape', cx: SIZE / 2, cy: SIZE / 2, r: SIZE / 2, fill: color }));
    }
    // Generous invisible hit area so small shapes are easy to hover/click.
    g.appendChild(el('rect', { x: -6, y: -6, width: SIZE + 12, height: SIZE + 12, fill: 'transparent' }));
    nodeLayer.appendChild(g);
  }

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

  function updateGlow() {
    for (const n of nodes) {
      const everVisited = lastTouchedStep.has(n.id);
      const glowEl = nodeGlowById.get(n.id);
      if (glowEl) glowEl.style.opacity = String(freshnessOf(n.id));
      const group = nodeGroupById.get(n.id);
      if (group) group.classList.toggle('visited', everVisited);
    }
    for (const n of nodes) {
      if (n.parentId === null) continue;
      // Edge glow's *value* is the parent's freshness, but it's gated on the
      // child having some freshness entry of its own (touched directly, or
      // marked as an immediate parent via the one-hop rule above). Without
      // that gate, EVERY child of a fresh node gets a glowing edge leading
      // to it — including siblings that were never touched at all, which
      // looks like a connection to nowhere. Gating means an edge only lights
      // up as part of an actual touched node's own path to its parent, and
      // "goes up the tree" only continues through ancestors that are
      // themselves part of that same contiguous chain, not by jumping past
      // an untouched node to reach a fresh one further up.
      const childIsOnATouchedPath = lastTouchedStep.has(n.id);
      const edgeGlow = edgeGlowById.get(n.id);
      if (edgeGlow) edgeGlow.style.opacity = String(childIsOnATouchedPath ? freshnessOf(n.parentId) : 0);
      // The plain edge gets the same "ever visited" permanence nodes get —
      // once a path has carried a touch, its edge stays a dim orange rather
      // than reverting to plain gray, distinguishing "explored, now cold"
      // from "never explored at all".
      const edge = edgeById.get(n.id);
      if (edge) edge.classList.toggle('visited', childIsOnATouchedPath);
    }
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
    // same unified /tmp/ahar-vsvis-debug.log as the host-side ones — 'host'
    // messages already originated there, so only 'client' ones get relayed
    // back (otherwise every host message would echo forever).
    if (source === 'client') vscode.postMessage({ type: 'clientDebug', message: message });
  }
  document.getElementById('debugLogClear').addEventListener('click', () => { debugLogBody.innerHTML = ''; });
  logDebug('client', 'panel script loaded (' + nodes.length + ' nodes), waiting for the transcript watcher...');

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

  const tooltip = document.getElementById('tooltip');
  const info = document.getElementById('info');
  const connectorLine = document.getElementById('connectorLine');
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

  // Pan/zoom state
  let scale = 1, tx = 40, ty = 40;
  let panning = false, dragStartX = 0, dragStartY = 0, didDrag = false;

  function updateTransform() {
    viewport.setAttribute('transform', 'translate(' + tx + ',' + ty + ') scale(' + scale + ')');
    updateConnector();
  }
  updateTransform();

  function fitToView() {
    const bounds = viewport.getBBox();
    const svgRect = svg.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return;
    const pad = 60;
    const scaleX = (svgRect.width - pad) / bounds.width;
    const scaleY = (svgRect.height - pad) / bounds.height;
    scale = Math.min(scaleX, scaleY, 3);
    tx = (svgRect.width - bounds.width * scale) / 2 - bounds.x * scale;
    ty = pad / 2 - bounds.y * scale;
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
    tooltip.innerHTML = '<div class="name">' + escapeHtml(n.name) + '</div><div class="kind">' + escapeHtml(kindLabel(n)) + '</div>';
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
    const n = byId.get(target.getAttribute('data-id'));
    if (n && !n.isDirectory) vscode.postMessage({ type: 'openFile', path: n.id });
  });

  function showInfo(n) {
    const childCount = (childrenOf.get(n.id) || []).length;
    info.innerHTML =
      '<h3>' + escapeHtml(n.name) + '</h3>' +
      '<div class="row">' + escapeHtml(kindLabel(n)) + '</div>' +
      (n.isDirectory ? '<div class="row">Children: ' + childCount + '</div>' : '') +
      '<div class="row path">' + escapeHtml(n.id) + '</div>' +
      (!n.isDirectory ? '<button id="openBtn">Open File</button>' : '');
    info.classList.add('visible');
    const btn = document.getElementById('openBtn');
    if (btn) btn.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: n.id }));
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
