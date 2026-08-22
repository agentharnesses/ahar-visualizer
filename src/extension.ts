import * as fs from 'node:fs'
import * as vscode from 'vscode'
import { DEFAULT_DEV_QUEUE_DIR, DevQueueWatcher } from './devQueue'
import { HarnessTreePanel } from './treePanel'
import { SidebarViewProvider } from './sidebarView'

/** Shared by the URI handler and the dev-mode queue — both accept an externally-supplied
 *  directory and should fail the same way on a bad one. */
function isValidRootDir(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const workspaceFolders = vscode.workspace.workspaceFolders
  if (!workspaceFolders || workspaceFolders.length === 0) return

  const rootPath = workspaceFolders[0].uri.fsPath

  context.subscriptions.push(
    vscode.commands.registerCommand('aharVisualizer.refresh', () => {
      HarnessTreePanel.refreshIfOpen()
    }),
    // Always opens a brand-new, independently-tracked panel (never reveals/
    // refreshes an existing one) so the button can be clicked repeatedly to
    // have several tree visualizations open side by side at once.
    vscode.commands.registerCommand('aharVisualizer.openTreeVisualization', () => {
      HarnessTreePanel.createCustom({ rootPath })
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
        if (!isValidRootDir(customRootPath)) {
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

  // Dev-mode-only alternative to the URI handler above: a vscode:// URL always routes to the
  // single registered Code app bundle regardless of which --user-data-dir instance is running
  // it, so it can't reliably reach a disposable Extension Development Host used to test this
  // extension itself (confirmed empirically — see ahar-visualizer-dev-workflow.md in the parent
  // meta-repo). Gating on extensionMode means this never runs for a real installed extension.
  if (context.extensionMode === vscode.ExtensionMode.Development) {
    const devQueue = new DevQueueWatcher(DEFAULT_DEV_QUEUE_DIR, (request) => {
      if (!isValidRootDir(request.rootPath)) {
        void vscode.window.showErrorMessage(
          `ahar-visualizer (dev queue): root path does not exist or is not a directory: ${request.rootPath}`
        )
        return
      }
      HarnessTreePanel.createCustom({
        rootPath: request.rootPath,
        sessionFile: request.sessionFile,
        label: request.label
      })
    })
    devQueue.start()
    context.subscriptions.push({ dispose: () => devQueue.stop() })
  }

  HarnessTreePanel.createOrShow(rootPath)
}

export function deactivate(): void {}
