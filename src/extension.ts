import * as fs from 'node:fs'
import * as vscode from 'vscode'
import { HarnessTreePanel } from './treePanel'
import { SidebarViewProvider } from './sidebarView'

export function activate(context: vscode.ExtensionContext): void {
  const workspaceFolders = vscode.workspace.workspaceFolders
  if (!workspaceFolders || workspaceFolders.length === 0) return

  const rootPath = workspaceFolders[0].uri.fsPath

  context.subscriptions.push(
    vscode.commands.registerCommand('aharVisualizer.refresh', () => {
      HarnessTreePanel.refreshIfOpen()
    }),
    vscode.commands.registerCommand('aharVisualizer.openTreeVisualization', () => {
      HarnessTreePanel.createOrShow(rootPath)
    }),
    vscode.commands.registerCommand('aharVisualizer.openSettings', () => {
      void vscode.commands.executeCommand('workbench.action.openSettings', 'aharVisualizer')
    }),
    // Advanced, Command-Palette-only entry point (not on any menu) for
    // side-by-side comparison testing: opens an additional, independently
    // tracked panel against a chosen directory and optionally a specific
    // pinned transcript file, instead of the default workspace root +
    // auto-follow-latest-session panel. See references/multi-panel-testing.md.
    vscode.commands.registerCommand('aharVisualizer.openCustomVisualization', async () => {
      const dirs = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Select directory to visualize'
      })
      if (!dirs || dirs.length === 0) return
      const rootPath = dirs[0].fsPath

      const label = await vscode.window.showInputBox({
        prompt: 'Optional label (tab title + debug-log suffix, e.g. "with-harness")'
      })

      const pinChoice = await vscode.window.showQuickPick(
        ['Auto-follow latest session (default)', 'Pin to a specific transcript file…'],
        { placeHolder: 'Which session should this panel follow?' }
      )
      let sessionFile: string | undefined
      if (pinChoice?.startsWith('Pin')) {
        const files = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters: { Transcript: ['jsonl'] },
          openLabel: 'Select .jsonl transcript to pin'
        })
        if (files && files.length > 0) sessionFile = files[0].fsPath
      }

      HarnessTreePanel.createCustom({ rootPath, sessionFile, label: label || undefined })
    }),
    vscode.window.registerWebviewViewProvider('aharVisualizer.sidebar', new SidebarViewProvider()),
    // The scriptable hook for automated comparison testing: an external test
    // script can pop a pre-wired panel with zero VS Code UI interaction, e.g.
    // `open "vscode://agentharnesses.ahar-visualizer/openTree?root=<dir>&session=<jsonl>&label=<text>"`.
    // `root` must already exist; `session` is deliberately allowed to not
    // exist yet — TranscriptWatcher retries until a pinned file appears, so
    // a test script can open the panel before launching its `claude` CLI
    // session. See references/multi-panel-testing.md.
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri) {
        if (uri.path !== '/openTree') return
        const params = new URLSearchParams(uri.query)
        const customRootPath = params.get('root')
        if (!customRootPath) {
          void vscode.window.showErrorMessage('ahar-visualizer: openTree URI missing required "root" parameter')
          return
        }
        if (!fs.existsSync(customRootPath) || !fs.statSync(customRootPath).isDirectory()) {
          void vscode.window.showErrorMessage(
            `ahar-visualizer: root path does not exist or is not a directory: ${customRootPath}`
          )
          return
        }
        HarnessTreePanel.createCustom({
          rootPath: customRootPath,
          sessionFile: params.get('session') ?? undefined,
          label: params.get('label') ?? undefined
        })
      }
    })
  )

  HarnessTreePanel.createOrShow(rootPath)
}

export function deactivate(): void {}
