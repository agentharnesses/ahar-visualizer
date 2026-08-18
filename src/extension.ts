import * as vscode from 'vscode'
import { HarnessTreeProvider } from './harnessTreeProvider'
import { HarnessNode } from './harness'
import { HarnessTreePanel } from './treePanel'

export function activate(context: vscode.ExtensionContext): void {
  const workspaceFolders = vscode.workspace.workspaceFolders
  if (!workspaceFolders || workspaceFolders.length === 0) return

  const rootPath = workspaceFolders[0].uri.fsPath
  let flattened = false

  const provider = new HarnessTreeProvider(rootPath, () => flattened)
  const treeView = vscode.window.createTreeView('aharVsvis.harnessTree', {
    treeDataProvider: provider,
    showCollapseAll: true
  })
  context.subscriptions.push(treeView)

  context.subscriptions.push(
    vscode.commands.registerCommand('aharVsvis.refresh', () => {
      provider.refresh()
      HarnessTreePanel.refreshIfOpen()
    }),
    vscode.commands.registerCommand('aharVsvis.toggleFlatten', () => {
      flattened = !flattened
      void vscode.commands.executeCommand('setContext', 'aharVsvis.flattened', flattened)
      provider.refresh()
    }),
    vscode.commands.registerCommand('aharVsvis.openNode', async (node: HarnessNode) => {
      if (node.isDirectory) return
      const uri = vscode.Uri.file(node.fsPath)
      await vscode.window.showTextDocument(uri, { preview: true })
      await vscode.commands.executeCommand('revealInExplorer', uri)
    }),
    vscode.commands.registerCommand('aharVsvis.openTreeVisualization', () => {
      HarnessTreePanel.createOrShow(rootPath)
    })
  )
}

export function deactivate(): void {}
