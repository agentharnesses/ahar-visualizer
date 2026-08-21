import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/** Per-file tail state: how far into it we've already read, plus any trailing partial line
 *  carried over from the previous tick. One of these exists per tailed file — the main
 *  transcript and every subagent transcript discovered under it each get their own. */
interface TailState {
  offset: number
  carry: string
}

// Confirmed live (toprope-agentdev diary 2026-08-20, "digging through the transcript"): across a
// real run, Bash tool_use calls outnumbered Read calls in every variant, and the dominant Bash
// verbs were grep/find/head -- genuine file exploration that, before this, was entirely invisible
// to this overlay (and to traversal-compare's identically-scoped metrics.py) because Read/Edit/
// Write's structured file_path input has no Bash equivalent -- a Bash tool_use's `command` is one
// unstructured shell string. Worse, the gap was asymmetric: a with-harness-style run (which
// explores less broadly, guided more directly) had zero files that were grepped/headed but never
// separately Read; a no-metaskill run had several -- so the activity overlay was systematically
// understating exactly the conditions that explore the most via Bash.
//
// extractBashPaths is a best-effort heuristic, not a shell parser -- a Bash argument doesn't carry
// a structured path field the way Read/Edit/Write's does, so this can't be exact by construction.
// Scoped deliberately narrow to keep false positives low: a candidate token must look like a real
// filename (a known extension on its last path segment), must not be a glob pattern (contains "*"
// or "?"), must not be a flag (leading "-"), and must not be a redirect target (immediately after
// a bare >, >>, or <) -- a Bash-created output file isn't something the sandbox already had, so
// counting it as a "touch" would conflate exploration with something closer to an edit. A grep
// *search pattern* argument (e.g. "harnessleaf" in `grep -n harnessleaf file.py`) never matches on
// its own, since it has no recognized extension. Deliberately kept as a direct reimplementation of
// traversal-compare's metrics.py, not shared across languages, matching how this file already
// independently reimplements the metaskill's Python logic elsewhere in this project.
//
// find's -name/-iname is a second, real false-positive case, found live (diary 2026-08-20, "still
// looks sparse" follow-up): `find / -name "claude_runner.py"` uses the filename as an exact-match
// *search pattern*, not a path to read, but it's syntactically indistinguishable from a genuine
// path argument (a bare filename with a recognized extension) -- extracted and resolved against
// cwd it produced a plausible-looking but wrong, nonexistent path (<sandboxRoot>/claude_runner.py
// instead of the real, deeply-nested file), silently displacing a real touch slot instead of just
// being a harmless miss. Skipped the same way a redirect target is.
//
// A bare KEY=VALUE assignment is a third, found the same way (diary 2026-08-20, "the metaskill is
// the one exception" verification run): a live transcript had the model heredoc-writing a test
// .leaf-detectors file whose own *content* included lines like "skill=SKILL.md" and
// "mcp-server=SKILL.md" -- real .leaf-detectors syntax, not file paths, but VALUE has a recognized
// extension so the whole "KEY=VALUE" token still passed looksLikeFilePath. A genuine file path
// essentially never contains a literal "=", so excluding any token with one is a clean, safe guard.
const KNOWN_FILE_EXTENSIONS = new Set([
  'py', 'md', 'yaml', 'yml', 'json', 'txt', 'toml', 'cfg', 'ini', 'ts', 'tsx', 'js', 'jsx', 'sh', 'rst',
])
const REDIRECT_OPERATORS = new Set(['>', '>>', '<'])
const PATTERN_TAKING_FLAGS = new Set(['-name', '-iname'])

function looksLikeFilePath(token: string): boolean {
  if (token.startsWith('-') || token.includes('*') || token.includes('?') || token.includes('=')) return false
  const basename = token.includes('/') ? token.slice(token.lastIndexOf('/') + 1) : token
  if (!basename.includes('.')) return false
  const ext = basename.slice(basename.lastIndexOf('.') + 1).toLowerCase()
  return KNOWN_FILE_EXTENSIONS.has(ext)
}

/** Minimal POSIX-ish shell tokenizer: splits on whitespace, honors single/double quotes (quotes
 *  are stripped, not preserved as literal characters), and unescapes a backslash outside quotes
 *  or before ", \, $, ` inside double quotes -- close enough to Python's shlex.split(posix=True)
 *  for the narrow purpose here (isolating a quoted grep pattern from a bare file argument), not a
 *  full shell grammar. */
function shellTokenize(segment: string): string[] {
  const tokens: string[] = []
  let current = ''
  let hasToken = false
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]
    if (inSingle) {
      if (ch === "'") inSingle = false
      else current += ch
      continue
    }
    if (inDouble) {
      if (ch === '"') inDouble = false
      else if (ch === '\\' && i + 1 < segment.length && '"\\$`'.includes(segment[i + 1])) current += segment[++i]
      else current += ch
      continue
    }
    if (ch === "'") {
      inSingle = true
      hasToken = true
    } else if (ch === '"') {
      inDouble = true
      hasToken = true
    } else if (ch === '\\' && i + 1 < segment.length) {
      current += segment[++i]
      hasToken = true
    } else if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current)
        current = ''
        hasToken = false
      }
    } else {
      current += ch
      hasToken = true
    }
  }
  if (hasToken) tokens.push(current)
  return tokens
}

function extractBashPaths(command: string): string[] {
  const paths: string[] = []
  for (const segment of command.split(/\|\||&&|[|;]/)) {
    const tokens = shellTokenize(segment)
    let skipNext = false
    for (const tok of tokens) {
      if (skipNext) {
        skipNext = false
        continue
      }
      if (REDIRECT_OPERATORS.has(tok) || PATTERN_TAKING_FLAGS.has(tok)) {
        skipNext = true
        continue
      }
      if (looksLikeFilePath(tok)) paths.push(tok)
    }
  }
  return paths
}

/**
 * Passively tails the active Claude Code session's transcript JSONL file to
 * observe which files the agent reads/edits/writes, without any hooks setup.
 * Also tails every subagent (Task-tool) transcript dispatched during that
 * session — see findSubagentFiles — since a subagent's own Read/Edit/Write
 * calls land in a separate file, not inline in the main one; without this, a
 * run that delegates most of its exploration to a subagent looks nearly idle
 * even though it isn't (found live — see toprope-agentdev diary
 * 2026-08-19-1825, the "what's up with recall" investigation).
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
  private mainState: TailState = { offset: 0, carry: '' }
  private subagentStates = new Map<string, TailState>()
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
      this.mainState = { offset: 0, carry: '' }
      this.subagentStates.clear()
      // A new session file means a genuinely different conversation — reset
      // the step counter so decay is scoped to *this* session's own length,
      // not accumulated across whatever earlier sessions this window ran.
      this.step = 0
      this.onSessionStart()
    }

    // Batch into one onEvent per tick rather than one per line — matters a
    // lot the first time we attach to an existing session with a long
    // history (see the switch-and-replay-from-0 comment above): without
    // batching, catching up on a multi-thousand-line transcript would fire a
    // postMessage per line. currentStep still ends up equal to the true
    // total line count either way, so decay math is unaffected.
    const filePaths: string[] = []
    let linesProcessed = this.tailInto(this.currentFile, this.mainState, filePaths)

    for (const subagentFile of this.findSubagentFiles(this.currentFile)) {
      let state = this.subagentStates.get(subagentFile)
      if (!state) {
        state = { offset: 0, carry: '' }
        this.subagentStates.set(subagentFile, state)
        this.onDebug(`discovered subagent transcript: ${subagentFile}`)
      }
      linesProcessed += this.tailInto(subagentFile, state, filePaths)
    }

    if (linesProcessed > 0) {
      this.onDebug(
        `processed ${linesProcessed} line(s), step now ${this.step}, file touches: ${
          filePaths.length > 0 ? JSON.stringify(filePaths) : '(none this batch)'
        }`
      )
      this.onEvent(this.step, filePaths)
    }
  }

  /** Reads whatever's new since `state.offset` in `filePath`, splits it into complete lines
   *  (carrying any trailing partial line in `state.carry` across ticks so a line split mid-write
   *  is never dropped or double-processed), extracts every file-path touch from each into
   *  `filePaths`, and returns how many complete lines were processed. Shared by the main
   *  transcript and every subagent transcript under it — both are the exact same
   *  incrementally-growing-JSONL-file shape, just discovered differently (see
   *  findLatestJsonl/sessionFileOverride vs. findSubagentFiles). */
  private tailInto(filePath: string, state: TailState, filePaths: string[]): number {
    let size: number
    try {
      size = fs.statSync(filePath).size
    } catch (err) {
      this.onDebug(`stat failed for ${filePath}: ${String(err)}`)
      return 0
    }
    if (size <= state.offset) return 0

    const length = size - state.offset
    const buf = Buffer.alloc(length)
    let fd: number
    try {
      fd = fs.openSync(filePath, 'r')
    } catch (err) {
      this.onDebug(`open failed for ${filePath}: ${String(err)}`)
      return 0
    }
    try {
      fs.readSync(fd, buf, 0, length, state.offset)
    } finally {
      fs.closeSync(fd)
    }
    state.offset = size

    const chunk = state.carry + buf.toString('utf8')
    const lines = chunk.split('\n')
    state.carry = lines.pop() ?? ''

    let processed = 0
    for (const line of lines) {
      if (!line.trim()) continue
      processed++
      this.step++
      filePaths.push(...this.extractFilePaths(line))
    }
    return processed
  }

  /** A session's subagent (Task-tool) transcripts live in `<sessionId>/subagents/*.jsonl` — a
   *  directory named after the main transcript's own filename stem, sibling to that file, not
   *  inside it. Confirmed empirically (see diary 2026-08-19-1825): findLatestJsonl's flat,
   *  non-recursive scan of the project directory never finds these. New files can appear here
   *  mid-run as the agent dispatches more subagents, so this re-globs every tick rather than
   *  caching the list once — cheap given a session realistically has a handful of these, not
   *  thousands. */
  private findSubagentFiles(mainFile: string): string[] {
    const sessionId = path.basename(mainFile, '.jsonl')
    const subagentsDir = path.join(path.dirname(mainFile), sessionId, 'subagents')
    try {
      return fs
        .readdirSync(subagentsDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => path.join(subagentsDir, f))
    } catch {
      return [] // no subagent dispatched (yet, or ever) this session — not an error
    }
  }

  private extractFilePaths(line: string): string[] {
    const filePaths: string[] = []
    try {
      const obj = JSON.parse(line) as {
        cwd?: string
        message?: {
          content?: Array<{ type?: string; name?: string; input?: { file_path?: string; command?: string } }>
        }
      }
      const content = obj.message?.content
      const cwd = obj.cwd ?? ''
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== 'tool_use') continue
          if (
            (block.name === 'Read' || block.name === 'Edit' || block.name === 'Write') &&
            typeof block.input?.file_path === 'string'
          ) {
            // The model doesn't always pass an absolute file_path — confirmed empirically, a
            // real run recorded plain "./services/returns/foo.py" for a Read call. Every
            // transcript line carries its own `cwd`, though, so resolve against that rather than
            // assuming absolute; without this, resolveToNodeId's prefix-walk on the client never
            // matches any node id (which are always absolute), and that touch is silently lost.
            // path.resolve is a no-op when file_path is already absolute, regardless of cwd.
            filePaths.push(path.resolve(cwd, block.input.file_path))
          } else if (block.name === 'Bash' && typeof block.input?.command === 'string') {
            // See extractBashPaths' own comment: a Bash tool_use has no structured path field,
            // just an unstructured shell string, so this is a best-effort heuristic extraction of
            // real file arguments (grep/find/head/... targets) rather than an exact one.
            for (const p of extractBashPaths(block.input.command)) {
              filePaths.push(path.resolve(cwd, p))
            }
          }
        }
      }
    } catch (err) {
      this.onDebug(`line failed to parse as JSON (${String(err)}): ${line.slice(0, 120)}`)
    }
    return filePaths
  }
}
