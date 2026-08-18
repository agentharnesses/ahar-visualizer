import * as vscode from 'vscode'
import { buildHarnessIndex, HarnessIndex } from './harness'

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

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables)
    this.panel.webview.onDidReceiveMessage(
      async (message: { type: string; path?: string }) => {
        if (message.type === 'openFile' && message.path) {
          const uri = vscode.Uri.file(message.path)
          await vscode.window.showTextDocument(uri, { preview: true })
          await vscode.commands.executeCommand('revealInExplorer', uri)
        }
      },
      null,
      this.disposables
    )

    this.refresh()
  }

  refresh(): void {
    const index = buildHarnessIndex(this.rootPath)
    const nodes = serialize(index, this.rootPath)
    this.panel.webview.html = renderHtml(nodes)
  }

  private dispose(): void {
    HarnessTreePanel.current = undefined
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
  .node .shape { stroke: var(--vscode-editor-background); stroke-width: 1; }
  .node.muted .shape { opacity: 0.4; }
  .node.selected .shape { stroke: var(--vscode-focusBorder); stroke-width: 2; }
  .node.hovered .shape { stroke: var(--vscode-foreground); stroke-width: 1.5; }
  .edge { fill: none; stroke: var(--vscode-widget-border, #454545); stroke-width: 1; opacity: 0.6; }
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
    position: absolute; bottom: 12px; left: 12px; background: var(--vscode-editorWidget-background);
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
</style>
</head>
<body>
<svg id="canvas">
  <g id="viewport"></g>
</svg>
<div id="toolbar">
  <button id="zoomIn" title="Zoom in">+</button>
  <button id="zoomOut" title="Zoom out">−</button>
  <button id="zoomReset" title="Fit to view">⤢</button>
</div>
<div id="legend">
  <div class="row"><span class="sq" style="background:var(--vscode-charts-red)"></span> Harness root (HARNESS.md)</div>
  <div class="row"><span class="sq" style="background:var(--vscode-charts-yellow)"></span> Directory with routing index</div>
  <div class="row"><span class="sq" style="background:var(--vscode-charts-blue)"></span> Leaf directory</div>
  <div class="row"><span class="ci" style="background:var(--vscode-charts-blue)"></span> Leaf descriptor file</div>
  <div class="row"><span class="sq muted" style="background:var(--vscode-descriptionForeground)"></span><span class="ci muted" style="background:var(--vscode-descriptionForeground)"></span> Not harness-standard-relevant</div>
  <div class="row" style="margin-top:4px">▢ directory &nbsp; ● file</div>
</div>
<div id="tooltip"></div>
<div id="info"></div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const nodes = ${data};

  const SIZE = 16, H_GAP = 12, V_GAP = 42;

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

  function el(tag, attrs) {
    const e = document.createElementNS(svgNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  // Edges
  for (const n of nodes) {
    if (n.parentId === null) continue;
    const px = posX.get(n.parentId) + SIZE / 2;
    const py = depth.get(n.parentId) * (SIZE + V_GAP) + SIZE;
    const cx = posX.get(n.id) + SIZE / 2;
    const cy = depth.get(n.id) * (SIZE + V_GAP);
    const midY = (py + cy) / 2;
    const d = 'M ' + px + ' ' + py + ' C ' + px + ' ' + midY + ', ' + cx + ' ' + midY + ', ' + cx + ' ' + cy;
    viewport.appendChild(el('path', { class: 'edge', d }));
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
    if (n.isDirectory) {
      g.appendChild(el('rect', { class: 'shape', width: SIZE, height: SIZE, rx: 3, fill: color }));
    } else {
      g.appendChild(el('circle', { class: 'shape', cx: SIZE / 2, cy: SIZE / 2, r: SIZE / 2, fill: color }));
    }
    // Generous invisible hit area so small shapes are easy to hover/click.
    g.appendChild(el('rect', { x: -6, y: -6, width: SIZE + 12, height: SIZE + 12, fill: 'transparent' }));
    viewport.appendChild(g);
  }

  // Pan/zoom state
  let scale = 1, tx = 40, ty = 40;
  let panning = false, dragStartX = 0, dragStartY = 0, didDrag = false;

  function updateTransform() {
    viewport.setAttribute('transform', 'translate(' + tx + ',' + ty + ') scale(' + scale + ')');
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

  const tooltip = document.getElementById('tooltip');
  const info = document.getElementById('info');
  let selectedEl = null;
  let hoveredEl = null;

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
      return;
    }
    target.classList.add('selected');
    selectedEl = target;
    const n = byId.get(target.getAttribute('data-id'));
    showInfo(n);
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
