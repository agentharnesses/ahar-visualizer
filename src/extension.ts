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
    vscode.window.registerWebviewViewProvider('aharVisualizer.sidebar', new SidebarViewProvider())
  )

  HarnessTreePanel.createOrShow(rootPath)
}

export function deactivate(): void {}
