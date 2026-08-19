import * as fs from 'node:fs'
import * as path from 'node:path'

export interface QueueRequest {
  rootPath: string
  sessionFile?: string
  label?: string
}

/** Well-known, fixed location (not per-session) so an external script always knows where to
 *  write a request without any discovery step — same rationale as treePanel.ts's DEBUG_LOG_PATH. */
export const DEFAULT_DEV_QUEUE_DIR = '/tmp/ahar-visualizer-dev-queue'

/** Polls a fixed directory for JSON "open this panel" request files — the dev-mode alternative
 *  to the openTree URI handler, for scripts that need to reach a *specific* Extension
 *  Development Host instance directly.
 *
 *  Why this exists: macOS routes a `vscode://` URL to the single registered Code app bundle
 *  regardless of which `--user-data-dir` instance is "meant" to receive it — confirmed
 *  empirically (see ahar-visualizer-dev-workflow.md in the parent meta-repo): a disposable
 *  dev-host launched via `--extensionDevelopmentPath` never received a test URI at all; it went
 *  to the main window instead. So URL-based targeting cannot reliably reach a dev-host. This
 *  sidesteps the OS entirely — no scheme, no app-bundle resolution, just a shared directory only
 *  this specific process is polling.
 *
 *  Only ever started when running as an Extension Development Host (gated in extension.ts's
 *  activate() by `context.extensionMode === vscode.ExtensionMode.Development`) — never active
 *  for a real installed extension, so this has zero effect on production behavior. */
export class DevQueueWatcher {
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly queueDir: string,
    /** Called once per valid request file found, in filename order. */
    private readonly onRequest: (request: QueueRequest) => void,
    private readonly onDebug: (message: string) => void = () => {},
    private readonly intervalMs: number = 500
  ) {}

  start(): void {
    try {
      fs.mkdirSync(this.queueDir, { recursive: true })
    } catch (err) {
      this.onDebug(`failed to create dev queue dir ${this.queueDir}: ${String(err)}`)
    }
    this.onDebug(`dev queue watcher started · dir=${this.queueDir}`)
    this.tick()
    this.timer = setInterval(() => this.tick(), this.intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  private tick(): void {
    // Touched on every tick, live or not, so a consumer (traversal-compare's viewer.py) can
    // tell a genuinely-running watcher apart from a stale directory left behind by a
    // previous, since-killed dev-host — by checking this file's mtime is recent, not just
    // that the directory exists.
    try {
      fs.writeFileSync(path.join(this.queueDir, '.heartbeat'), String(Date.now()))
    } catch (err) {
      this.onDebug(`failed to write heartbeat in ${this.queueDir}: ${String(err)}`)
    }

    let entries: string[]
    try {
      entries = fs
        .readdirSync(this.queueDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
    } catch (err) {
      this.onDebug(`failed to read dev queue dir ${this.queueDir}: ${String(err)}`)
      return
    }

    for (const name of entries) {
      const full = path.join(this.queueDir, name)
      let raw: string
      try {
        raw = fs.readFileSync(full, 'utf8')
      } catch (err) {
        this.onDebug(`failed to read queue file ${full}: ${String(err)}`)
        continue
      }
      // Delete before processing, not after — a request that turns out malformed must not be
      // reprocessed forever on every subsequent tick.
      try {
        fs.unlinkSync(full)
      } catch (err) {
        this.onDebug(`failed to remove queue file ${full}: ${String(err)}`)
      }

      let request: QueueRequest
      try {
        request = JSON.parse(raw) as QueueRequest
      } catch (err) {
        this.onDebug(`queue file ${full} was not valid JSON: ${String(err)}`)
        continue
      }
      if (typeof request.rootPath !== 'string' || request.rootPath.length === 0) {
        this.onDebug(`queue file ${full} missing required rootPath`)
        continue
      }
      this.onDebug(`dev queue request: rootPath=${request.rootPath} sessionFile=${request.sessionFile ?? '(none)'}`)
      this.onRequest(request)
    }
  }
}
