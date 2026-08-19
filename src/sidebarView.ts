import * as vscode from 'vscode'

/** Renders the tiny Activity Bar sidebar panel: just enough to give the
 *  extension a permanent, discoverable entry point in VS Code's side icon
 *  rail, since the tree visualization itself lives in a full editor-area
 *  webview panel that can be closed and otherwise only reopened via the
 *  command palette. */
export class SidebarViewProvider implements vscode.WebviewViewProvider {
  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = { enableScripts: true }
    webviewView.webview.html = html()
    webviewView.webview.onDidReceiveMessage((message: { type?: string }) => {
      if (message.type === 'openTreeVisualization') {
        void vscode.commands.executeCommand('aharVisualizer.openTreeVisualization')
      } else if (message.type === 'openSettings') {
        void vscode.commands.executeCommand('aharVisualizer.openSettings')
      }
    })
  }
}

function html(): string {
  return `<!DOCTYPE html>
<html>
<head>
<style>
  body {
    padding: 10px;
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
  }
  button {
    width: 100%;
    padding: 6px 10px;
    margin-bottom: 6px;
    cursor: pointer;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 3px;
    font-size: 13px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-widget-border, #454545);
    margin-bottom: 0;
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
</style>
</head>
<body>
  <button id="openBtn">Open Tree Visualization</button>
  <button id="settingsBtn" class="secondary">Open Settings</button>
  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('openBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'openTreeVisualization' });
    });
    document.getElementById('settingsBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'openSettings' });
    });
  </script>
</body>
</html>`
}
