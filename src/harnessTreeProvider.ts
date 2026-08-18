import * as vscode from 'vscode'
import { buildHarnessIndex, HarnessIndex, HarnessKind, HarnessNode } from './harness'

const ICON_BY_KIND: Partial<Record<HarnessKind, vscode.ThemeIcon>> = {
  'harness-root': new vscode.ThemeIcon('rocket', new vscode.ThemeColor('charts.red')),
  'harness-md': new vscode.ThemeIcon('rocket', new vscode.ThemeColor('charts.red')),
  leaf: new vscode.ThemeIcon('symbol-method', new vscode.ThemeColor('charts.blue')),
  'leaf-descriptor': new vscode.ThemeIcon('list-tree', new vscode.ThemeColor('charts.blue')),
  routing: new vscode.ThemeIcon('list-tree', new vscode.ThemeColor('charts.yellow')),
  group: new vscode.ThemeIcon('folder')
}

export class HarnessTreeProvider implements vscode.TreeDataProvider<HarnessNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    HarnessNode | undefined | void
  >()
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event

  private index: HarnessIndex

  constructor(
    private readonly rootPath: string,
    private readonly isFlattened: () => boolean
  ) {
    this.index = buildHarnessIndex(rootPath)
  }

  refresh(): void {
    this.index = buildHarnessIndex(this.rootPath)
    this.onDidChangeTreeDataEmitter.fire()
  }

  getTreeItem(node: HarnessNode): vscode.TreeItem {
    const children = this.getChildren(node)
    const collapsibleState =
      node.isDirectory && children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None

    const item = new vscode.TreeItem(node.name, collapsibleState)
    item.resourceUri = vscode.Uri.file(node.fsPath)
    item.iconPath =
      ICON_BY_KIND[node.kind] ?? (node.isDirectory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File)
    item.description = node.kind === 'leaf' ? node.leafType : undefined
    item.contextValue = node.kind
    item.tooltip = new vscode.MarkdownString(
      `**${node.kind}**${node.leafType ? ` (${node.leafType})` : ''}\n\n\`${node.fsPath}\``
    )

    if (!node.isDirectory) {
      item.command = {
        command: 'aharVsvis.openNode',
        title: 'Open',
        arguments: [node]
      }
    }
    return item
  }

  getChildren(node?: HarnessNode): HarnessNode[] {
    const dirPath = node ? node.fsPath : this.rootPath
    const entry = this.index.get(dirPath)
    if (!entry) return []
    if (this.isFlattened()) {
      return entry.children.filter((child) => this.index.get(child.fsPath)?.relevant)
    }
    return entry.children
  }
}
