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

  constructor(
    private readonly rootPath: string,
    private readonly onEvent: (step: number, filePaths: string[]) => void
  ) {}

  start(): void {
    this.tick()
    this.timer = setInterval(() => this.tick(), 1000)
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
    } catch {
      return null
    }
    let latest: string | null = null
    let latestMtime = 0
    for (const name of entries) {
      const full = path.join(this.projectDir(), name)
      try {
        const stat = fs.statSync(full)
        if (stat.mtimeMs > latestMtime) {
          latestMtime = stat.mtimeMs
          latest = full
        }
      } catch {
        // file disappeared mid-scan; ignore
      }
    }
    return latest
  }

  private tick(): void {
    const latest = this.findLatestJsonl()
    if (!latest) return

    if (latest !== this.currentFile) {
      // Switch to the newly-active session's transcript. Start from its
      // current end rather than replaying history, so the visualization
      // reflects what's happening now, not a full backlog.
      this.currentFile = latest
      try {
        this.offset = fs.statSync(latest).size
      } catch {
        this.offset = 0
      }
      this.carry = ''
      return
    }

    let size: number
    try {
      size = fs.statSync(this.currentFile).size
    } catch {
      return
    }
    if (size <= this.offset) return

    const length = size - this.offset
    const buf = Buffer.alloc(length)
    let fd: number
    try {
      fd = fs.openSync(this.currentFile, 'r')
    } catch {
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

    for (const line of lines) {
      if (!line.trim()) continue
      this.processLine(line)
    }
  }

  private processLine(line: string): void {
    this.step++
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
    } catch {
      // Not JSON, or shape drifted from what we expect — skip this line.
    }
    this.onEvent(this.step, filePaths)
  }
}
