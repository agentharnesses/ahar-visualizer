import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Passively tails the active Claude Code session's transcript JSONL file to
 * observe which files the agent reads/edits/writes, without any hooks setup.
 *
 * Caveat (see toprope-agentdev diary, 2026-08-18-1007): the transcript's
 * per-line JSON schema is Claude Code's internal conversation-persistence
 * format, not a published/versioned public contract. This is the piece most
 * likely to quietly break on a future `claude` CLI upgrade — if so, malformed
 * lines are just skipped (see processLine), degrading to "no glow" rather
 * than crashing the extension.
 */
export class TranscriptWatcher {
  private timer: NodeJS.Timeout | undefined
  private currentFile: string | null = null
  private offset = 0
  private carry = ''
  private step = 0
  private pinnedMissingLogged = false

  constructor(
    private readonly rootPath: string,
    private readonly onEvent: (step: number, filePaths: string[]) => void,
    private readonly onDebug: (message: string) => void = () => {},
    /** Fired whenever the watcher starts following a *different* session
     *  file than before — including the very first one. Lets the webview
     *  scope "visited" state to the current session specifically, rather
     *  than accumulating across every session this window ever runs. */
    private readonly onSessionStart: () => void = () => {},
    /** How often to re-scan the project's transcript directory for a more
     *  up-to-date session (ms). Configurable via aharVisualizer.rescanIntervalMs
     *  since a tighter interval trades CPU for lower latency picking up a
     *  brand-new session, and a looser one is cheaper on a large repo. */
    private readonly rescanIntervalMs: number = 400,
    /** When set, skip auto-follow entirely and tail exactly this file instead
     *  of whichever session is most recently active — used by panels opened
     *  against a specific "chat continuum" for side-by-side comparison
     *  testing. Retries every tick if the file doesn't exist yet, so a panel
     *  can be opened before its target `claude` CLI session has started
     *  writing its transcript. */
    private readonly sessionFileOverride: string | undefined = undefined
  ) {}

  start(): void {
    // Always follow whichever session file in the project directory is most
    // recently modified — the most recently *active* one — re-checking on
    // every tick so switching to an even-more-recently-touched session (a
    // brand new one, or the user tabbing back to an older window) just
    // happens on its own, no restart required.
    this.onDebug(`watcher started · root=${this.rootPath} · projectDir=${this.projectDir()}`)
    this.tick()
    this.timer = setInterval(() => this.tick(), this.rescanIntervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  private projectDir(): string {
    // Every non-alphanumeric character maps to '-', not just '/' — confirmed empirically (a
    // real `claude -p` run from a cwd containing underscores and a dot produced a project dir
    // with every one of those replaced too, not just the path separators). A slash-only
    // replacement silently breaks for any cwd containing another special character — which
    // e.g. macOS's own temp directory does by default (/var/folders/.../6v5gb2jx..._x3c0000gn).
    const slug = this.rootPath.replace(/[^a-zA-Z0-9]/g, '-')
    return path.join(os.homedir(), '.claude', 'projects', slug)
  }

  private findLatestJsonl(): string | null {
    let entries: string[]
    try {
      entries = fs.readdirSync(this.projectDir()).filter((f) => f.endsWith('.jsonl'))
    } catch (err) {
      this.onDebug(`readdir failed for ${this.projectDir()}: ${String(err)}`)
      return null
    }
    if (entries.length === 0) {
      this.onDebug(`no .jsonl files at all in ${this.projectDir()}`)
    }
    let latest: string | null = null
    let latestMtime = 0
    const statFailures: string[] = []
    for (const name of entries) {
      const full = path.join(this.projectDir(), name)
      try {
        const stat = fs.statSync(full)
        if (stat.mtimeMs > latestMtime) {
          latestMtime = stat.mtimeMs
          latest = full
        }
      } catch (err) {
        // A transient stat failure (e.g. a file disappearing mid-scan)
        // just drops that one file from consideration this tick.
        statFailures.push(`${name} (stat failed: ${String(err)})`)
      }
    }
    if (statFailures.length > 0) {
      this.onDebug(`${statFailures.length} file(s) failed to stat this tick: ${statFailures.join('; ')}`)
    }
    return latest
  }

  private tick(): void {
    let latest: string | null
    if (this.sessionFileOverride) {
      if (!fs.existsSync(this.sessionFileOverride)) {
        if (!this.pinnedMissingLogged) {
          this.onDebug(`pinned session file not found yet, retrying: ${this.sessionFileOverride}`)
          this.pinnedMissingLogged = true
        }
        return
      }
      this.pinnedMissingLogged = false
      latest = this.sessionFileOverride
    } else {
      latest = this.findLatestJsonl()
    }
    if (!latest) return

    if (latest !== this.currentFile) {
      // Switch to the newly-active session's transcript and read it from the
      // start, then fall through to process it immediately in this same
      // tick. A fast exchange (ask a quick question, get an answer) can
      // complete inside a single poll interval — if we instead jumped to
      // EOF here and waited for the *next* tick to start reading, that
      // whole exchange would already be "in the past" and get silently
      // skipped. Replaying from 0 is also the semantically correct choice
      // given freshness decays by step count: catching up to the real
      // current step reproduces the exact freshness state each node should
      // already be in, not just an approximation of it.
      this.onDebug(`switched to session file: ${latest}`)
      this.currentFile = latest
      this.offset = 0
      this.carry = ''
      // A new session file means a genuinely different conversation — reset
      // the step counter so decay is scoped to *this* session's own length,
      // not accumulated across whatever earlier sessions this window ran.
      this.step = 0
      this.onSessionStart()
    }

    let size: number
    try {
      size = fs.statSync(this.currentFile).size
    } catch (err) {
      this.onDebug(`stat failed for current file ${this.currentFile}: ${String(err)}`)
      return
    }
    if (size <= this.offset) return

    const length = size - this.offset
    const buf = Buffer.alloc(length)
    let fd: number
    try {
      fd = fs.openSync(this.currentFile, 'r')
    } catch (err) {
      this.onDebug(`open failed for ${this.currentFile}: ${String(err)}`)
      return
    }
    try {
      fs.readSync(fd, buf, 0, length, this.offset)
    } finally {
      fs.closeSync(fd)
    }
    this.offset = size

    const chunk = this.carry + buf.toString('utf8')
    const lines = chunk.split('\n')
    this.carry = lines.pop() ?? ''

    // Batch into one onEvent per tick rather than one per line — matters a
    // lot the first time we attach to an existing session with a long
    // history (see the switch-and-replay-from-0 comment above): without
    // batching, catching up on a multi-thousand-line transcript would fire a
    // postMessage per line. currentStep still ends up equal to the true
    // total line count either way, so decay math is unaffected.
    let touchedAny = false
    const filePaths: string[] = []
    for (const line of lines) {
      if (!line.trim()) continue
      touchedAny = true
      this.step++
      filePaths.push(...this.extractFilePaths(line))
    }
    if (touchedAny) {
      this.onDebug(
        `processed ${lines.filter((l) => l.trim()).length} line(s), step now ${this.step}, file touches: ${
          filePaths.length > 0 ? JSON.stringify(filePaths) : '(none this batch)'
        }`
      )
      this.onEvent(this.step, filePaths)
    }
  }

  private extractFilePaths(line: string): string[] {
    const filePaths: string[] = []
    try {
      const obj = JSON.parse(line) as {
        cwd?: string
        message?: { content?: Array<{ type?: string; name?: string; input?: { file_path?: string } }> }
      }
      const content = obj.message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block?.type === 'tool_use' &&
            (block.name === 'Read' || block.name === 'Edit' || block.name === 'Write') &&
            typeof block.input?.file_path === 'string'
          ) {
            // The model doesn't always pass an absolute file_path — confirmed empirically, a
            // real run recorded plain "./services/returns/foo.py" for a Read call. Every
            // transcript line carries its own `cwd`, though, so resolve against that rather than
            // assuming absolute; without this, resolveToNodeId's prefix-walk on the client never
            // matches any node id (which are always absolute), and that touch is silently lost.
            // path.resolve is a no-op when file_path is already absolute, regardless of cwd.
            filePaths.push(path.resolve(obj.cwd ?? '', block.input.file_path))
          }
        }
      }
    } catch (err) {
      this.onDebug(`line failed to parse as JSON (${String(err)}): ${line.slice(0, 120)}`)
    }
    return filePaths
  }
}
