// The values this mod keeps in $.state (claude plugin validate checks every key the module names
// against this contract) and the shapes they hold. Everything a row draws from lives here, written
// by the event hooks in hooks/register.tsx; the band's render hook only reads.

/** One rate-limit window as `$.session.usage()` reports it. */
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

/** The status line's live figures: `$.session.usage()` without the breakdown. */
export type Usage = {
  startedAt: number
  /** Input tokens the last response was answered over (uncached + cache-written + cache-read). */
  ctxTokens?: number
  ctxWindow: number
  ctxPercent?: number
  limits: Limit[]
  costUsd?: number
}

/** One /context category, minus what the bar doesn't need. */
export type Segment = {
  name: string
  tokens: number
  /** A theme colour key (`promptBorder`, `inactive`, …): what /context draws the row in. */
  color: string
  kind: 'used' | 'free' | 'buffer' | 'deferred'
}

/** Where a loaded item came from: managed, user, project, local, plugin. */
export type Scopes = { m?: number; u?: number; p?: number; l?: number; x?: number }

/** The context breakdown (`$.session.usage({ breakdown: 'summary' })`), boiled down. */
export type Breakdown = {
  categories: Segment[]
  totalTokens: number
  /** The window the breakdown measures against (the compaction window, which may be under the model's). */
  maxTokens: number
  percentage: number
  /** Token makeup of the live window's last API response; null before one came back. */
  lastCall: { input: number; output: number; cacheWrite: number; cacheRead: number } | null
  /** Instruction files in context by scope (CLAUDE.md, AGENTS.md, rules), from the engine's own list. */
  instructions: Scopes
  /** The auto-memory index's directory, when one loaded. */
  memoryDir?: string
  agents: Scopes
  skills: Scopes
  /** Connected MCP servers by name; `claude.ai …` connectors among them. */
  mcpServers: string[]
}

/** What the model row shows beyond the model name. */
export type Model = {
  name: string
  /** The last model request's effort level (turn.step reports it); absent on models without one. */
  effort?: string
  thinking: boolean
  fast: boolean
}

export type Repo = {
  /** The folder name of the main working tree (a worktree shows its parent repository). */
  name: string
  branch: string
  ahead: number
  behind: number
  staged: number
  modified: number
  untracked: number
  conflicts: number
  worktree?: string
  remote?: { host: string; owner: string; name: string }
  tag?: { tag: string; count: number }
  pr?: { number: number; url: string; state: 'approved' | 'changes' | 'pending' | 'draft' | 'open' }
  /** `$.clock.now()` of the last `gh` lookup, so it runs at most every few minutes. */
  prCheckedAt?: number
  prBranch?: string
  /** For the open view: the first changed paths with their two-letter status, and the last commit. */
  files?: Array<{ xy: string; path: string }>
  changedTotal?: number
  lastCommit?: { sha: string; subject: string; at: number }
}

export type Host = {
  os: { kind: 'windows' | 'macos' | 'linux'; label: string }
  user: string
  host: string
  /** Names of the other live Claude Code sessions on this machine. */
  fleet: string[]
}

export type Info = {
  cwd: string
  home: string
  version: string
  sessionId: string
  outputStyle?: string
  agent?: string
}

/** Config and plugin-component counts, each broken down by scope (see the README's table). */
export type Counts = {
  trusted: boolean
  instructions: Scopes
  memory: Scopes
  agents: Scopes
  commands: Scopes
  skills: Scopes
  workflows: Scopes
  routines: Scopes
  rules: Scopes
  mcp: Scopes
  connectors: Scopes
  chrome: boolean
  hooks: Scopes
  plugins: Scopes
  themes: Scopes
  dirs: Scopes
  lsp: Scopes
  monitors: Scopes
  bin: Scopes
  channels: Scopes
}

/** The OAuth usage API's extra gauges: model-scoped weekly caps and usage credits. */
export type ApiUsage = {
  at: number
  scoped: Array<{ label: string; percent: number; resetsAt?: string }>
  credits?: { percent: number; used: number; limit: number }
}

export type Task = { subject: string; status: string }

/** What the session has been doing, accumulated from tool calls and turns. */
export type Activity = {
  toolCalls: number
  lastTool?: { name: string; target?: string }
  /** Tool calls started and not yet answered (main loop). */
  running: number
  todos?: { completed: number; total: number; current?: string }
  /** TaskCreate/TaskUpdate tasks by their id, in creation order. */
  tasks: Record<string, Task>
  linesAdded: number
  linesRemoved: number
  command?: string
  /** Output tokens and model-request time summed over the main loop's turns, for tok/s and API time. */
  outputTokens: number
  apiMs: number
  /** Session-long prompt-cache counts, for the hit ratio. */
  cacheRead: number
  inputTotal: number
  agents: {
    running: number
    completed: number
    failed: number
    teammates: string[]
    /**
     * The session's sub-agents and teammates in start order, kept by the mod: the engine's roster drops an agent
     * soon after it finishes, so this is the history (each with its last-seen status).
     */
    list?: Array<{ id?: string; type: string; description: string; status: string; mate?: boolean; name?: string }>
  }
  /** For the open view: the last few tool calls (newest last); `ok` once answered. */
  recentTools?: Array<{ name: string; target?: string; ok?: boolean }>
  /** For the open view: the TodoWrite list as last written. */
  todoItems?: Task[]
  /** For the open view: the last few main-loop turns (newest last). */
  turns?: Array<{ ms: number; output: number; input: number; cacheRead: number }>
}

/** The person's view of the band: shown or not, and which rows are open (oldest first). */
export type View = { isVisible: boolean; expanded: string[] }

declare module 'claude-code' {
  interface PluginState {
    'statusline-dashboard': {
      usage: Usage | null
      breakdown: Breakdown | null
      model: Model | null
      repo: Repo | null
      host: Host | null
      info: Info | null
      counts: Counts | null
      api: ApiUsage | null
      activity: Activity | null
      view: View
      /** The user config file's parsed JSON (hooks/sections.ts parseConfig reads it); null when absent. */
      config: unknown
      /** Bumped every minute so the clock, countdowns and pace redraw with nothing else changing. */
      tick: number
    }
  }
}
