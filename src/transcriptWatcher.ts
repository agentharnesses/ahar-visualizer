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
  private watcherStartMs = 0

  constructor(
    private readonly rootPath: string,
    private readonly onEvent: (step: number, filePaths: string[]) => void,
    private readonly onDebug: (message: string) => void = () => {},
    /** Fired whenever the watcher starts following a *different* session
     *  file than before — including the very first one. Lets the webview
     *  scope "visited" state to the current session specifically, rather
     *  than accumulating across every session this window ever runs. */
    private readonly onSessionStart: () => void = () => {}
  ) {}

  start(): void {
    // Only ever follow sessions created after this watcher started — a repo
    // can easily have more than one `claude` session writing into the same
    // project directory at once (e.g. the session actively developing this
    // extension, plus whatever session you start in the Extension
    // Development Host's own integrated terminal to test it). Picking
    // "whichever file has the latest mtime" is unusable in that situation:
    // a long-running, continuously-active session's mtime wins essentially
    // always, permanently starving out a newer session someone opened to
    // actually test with. Scoping to "created since I started watching"
    // makes the watcher track the session that belongs to *this* window.
    this.watcherStartMs = Date.now()
    this.onDebug(
      `watcher started · root=${this.rootPath} · projectDir=${this.projectDir()} · cutoff=${new Date(this.watcherStartMs).toISOString()}`
    )
    this.tick()
    this.timer = setInterval(() => this.tick(), 400)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  private projectDir(): string {
    const slug = this.rootPath.replace(/\//g, '-')
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
    const rejected: string[] = []
    for (const name of entries) {
      const full = path.join(this.projectDir(), name)
      try {
        const stat = fs.statSync(full)
        const birth = stat.birthtimeMs || stat.ctimeMs
        if (birth < this.watcherStartMs) {
          rejected.push(`${name} (birth=${new Date(birth).toISOString()}, predates cutoff)`)
          continue
        }
        if (stat.mtimeMs > latestMtime) {
          latestMtime = stat.mtimeMs
          latest = full
        }
      } catch (err) {
        rejected.push(`${name} (stat failed: ${String(err)})`)
      }
    }
    if (!latest && entries.length > 0) {
      this.onDebug(`found ${entries.length} .jsonl file(s), none pass the cutoff: ${rejected.join('; ')}`)
    }
    return latest
  }

  private tick(): void {
    const latest = this.findLatestJsonl()
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
            filePaths.push(block.input.file_path)
          }
        }
      }
    } catch (err) {
      this.onDebug(`line failed to parse as JSON (${String(err)}): ${line.slice(0, 120)}`)
    }
    return filePaths
  }
}
