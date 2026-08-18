import * as vscode from 'vscode'
import { HarnessTreePanel } from './treePanel'

export function activate(context: vscode.ExtensionContext): void {
  const workspaceFolders = vscode.workspace.workspaceFolders
  if (!workspaceFolders || workspaceFolders.length === 0) return

  const rootPath = workspaceFolders[0].uri.fsPath

  context.subscriptions.push(
    vscode.commands.registerCommand('aharVsvis.refresh', () => {
      HarnessTreePanel.refreshIfOpen()
    }),
    vscode.commands.registerCommand('aharVsvis.openTreeVisualization', () => {
      HarnessTreePanel.createOrShow(rootPath)
    })
  )

  HarnessTreePanel.createOrShow(rootPath)
}

export function deactivate(): void {}
