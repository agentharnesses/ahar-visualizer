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

function serialize(index: HarnessIndex, rootPath: string): VizNode[] {
  const nodes: VizNode[] = []

  function walk(fsPath: string, parentId: string | null): void {
    const entry = index.get(fsPath)
    if (!entry) return
    const n = entry.node
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
  .node rect { stroke-width: 1.5; fill: var(--vscode-editorWidget-background); }
  .node text { font-size: 12px; fill: var(--vscode-foreground); pointer-events: none; user-select: none; }
  .node.selected rect { stroke-width: 3; }
  .edge { fill: none; stroke: var(--vscode-widget-border, #454545); stroke-width: 1.5; }
  #info {
    position: absolute; top: 12px; right: 12px; width: 260px; max-height: calc(100% - 24px);
    overflow: auto; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, #454545);
    border-radius: 6px; padding: 10px 12px; font-size: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.3); display: none;
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
  #legend div { display: flex; align-items: center; gap: 6px; margin: 2px 0; }
  #legend .swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
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
  <div><span class="swatch" style="background:var(--vscode-charts-red)"></span> Harness root (HARNESS.md)</div>
  <div><span class="swatch" style="background:var(--vscode-charts-yellow)"></span> Routing index (SKILLS.md, etc.)</div>
  <div><span class="swatch" style="background:var(--vscode-charts-blue)"></span> Leaf</div>
  <div><span class="swatch" style="background:var(--vscode-descriptionForeground)"></span> Plain file / folder</div>
</div>
<div id="info"></div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const nodes = ${data};

  const NODE_W = 150, NODE_H = 32, H_GAP = 20, V_GAP = 60;

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
  let maxDepth = 0;

  function layout(id, d) {
    depth.set(id, d);
    maxDepth = Math.max(maxDepth, d);
    const kids = childrenOf.get(id) || [];
    if (kids.length === 0) {
      const x = leafCounter * (NODE_W + H_GAP);
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

  function colorFor(n) {
    if (n.isDirectory) {
      if (n.kind === 'harness-root') return 'var(--vscode-charts-red)';
      if (n.hasRoutingChild) return 'var(--vscode-charts-yellow)';
      if (n.kind === 'leaf') return 'var(--vscode-charts-blue)';
      return 'var(--vscode-descriptionForeground)';
    }
    if (n.kind === 'harness-md') return 'var(--vscode-charts-red)';
    if (n.kind === 'routing') return 'var(--vscode-charts-yellow)';
    if (n.kind === 'leaf-descriptor') return 'var(--vscode-charts-blue)';
    return 'var(--vscode-descriptionForeground)';
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
    const px = posX.get(n.parentId) + NODE_W / 2;
    const py = depth.get(n.parentId) * (NODE_H + V_GAP) + NODE_H;
    const cx = posX.get(n.id) + NODE_W / 2;
    const cy = depth.get(n.id) * (NODE_H + V_GAP);
    const midY = (py + cy) / 2;
    const d = 'M ' + px + ' ' + py + ' C ' + px + ' ' + midY + ', ' + cx + ' ' + midY + ', ' + cx + ' ' + cy;
    viewport.appendChild(el('path', { class: 'edge', d }));
  }

  // Nodes
  for (const n of nodes) {
    const x = posX.get(n.id);
    const y = depth.get(n.id) * (NODE_H + V_GAP);
    const g = el('g', { class: 'node', 'data-id': n.id, transform: 'translate(' + x + ',' + y + ')' });
    const color = colorFor(n);
    g.appendChild(el('rect', { width: NODE_W, height: NODE_H, rx: 5, stroke: color }));
    g.appendChild(el('rect', { x: 0, y: 0, width: 4, height: NODE_H, fill: color, rx: 2 }));
    const text = el('text', { x: 10, y: NODE_H / 2 + 4 });
    let label = n.name;
    if (label.length > 20) label = label.slice(0, 18) + '…';
    text.textContent = label;
    g.appendChild(text);
    const title = document.createElementNS(svgNS, 'title');
    title.textContent = n.name;
    g.appendChild(title);
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
    scale = Math.min(scaleX, scaleY, 1.5);
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
      const newScale = Math.min(Math.max(scale * (1 - e.deltaY * 0.01), 0.1), 3);
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

  document.getElementById('zoomIn').addEventListener('click', () => { scale = Math.min(scale * 1.2, 3); updateTransform(); });
  document.getElementById('zoomOut').addEventListener('click', () => { scale = Math.max(scale / 1.2, 0.1); updateTransform(); });
  document.getElementById('zoomReset').addEventListener('click', fitToView);

  const info = document.getElementById('info');
  let selected = null;

  svg.addEventListener('click', (e) => {
    if (didDrag) return;
    const target = e.target.closest('[data-id]');
    if (selected) selected.classList.remove('selected');
    if (!target) {
      info.classList.remove('visible');
      selected = null;
      return;
    }
    target.classList.add('selected');
    selected = target;
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
      '<div class="row">Kind: ' + escapeHtml(n.kind) + (n.leafType ? ' (' + escapeHtml(n.leafType) + ')' : '') + '</div>' +
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
