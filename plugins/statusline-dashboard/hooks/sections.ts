// Pure row builders: the collected state in, one Section per row out. No `$` here: register.tsx
// reads the state and hands it over, so the tests can build rows from fixtures.
//
// Widget ids (`model.effort`, `repo.pr`, …) are the user config's `hide` ids; the README table
// and the configure skill's id list must stay in sync with the `on(...)` calls below.

import type { Activity, ApiUsage, Breakdown, Counts, Host, Info, Model, Repo, Scopes, Usage } from '../types'
import {
  BAD,
  GOOD,
  WARN,
  ROW_IDS,
  bar,
  c256,
  contextColor,
  formatClock,
  formatCost,
  formatCountdown,
  formatDuration,
  formatReset,
  formatTokens,
  homeRelative,
  pace,
  shortenPath,
  truncate,
  truncateRuns,
  usageColor,
  type Item,
  type RowId,
  type Run,
  type Section,
} from './layout'

// ── user config ──────────────────────────────────────────────────────────────────────────────────
// ~/.claude/statusline-dashboard.json (CLAUDE_STATUSLINE_CONFIG overrides the path). It lives under
// ~/.claude, not in the plugin, so updates never clobber it and an uninstall leaves it for a
// reinstall. Every key is optional; anything missing, mistyped or unknown falls back to the
// default, so a broken file degrades to the stock dashboard instead of a blank one.

export type Config = {
  rows: RowId[]
  hide: Set<string>
  labels: boolean
  bars: boolean
  pace: boolean
  clock12: boolean
  usageApi: boolean
  /** `gh pr view` for the Repo row's PR badge. */
  pr: boolean
  maxRows: number
  /** Rows open when the person has never toggled one. */
  expanded: RowId[]
}

export function parseConfig(raw: unknown): Config {
  const u = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const ids = (v: unknown) => (Array.isArray(v) ? v.map((s) => String(s).toLowerCase().replace(/\.$/, '')) : null)
  const hide = new Set(ids(u.hide) ?? [])
  const isRow = (r: string): r is RowId => (ROW_IDS as readonly string[]).includes(r)
  const picked = ids(u.rows)?.filter((r, i, a) => isRow(r) && a.indexOf(r) === i) as RowId[] | undefined
  const max = Number(u.maxRows)
  return {
    rows: (picked?.length ? picked : [...ROW_IDS]).filter((r) => !hide.has(r)),
    hide,
    labels: u.labels !== false,
    bars: u.bars !== false,
    pace: u.pace !== false,
    clock12: String(u.clock ?? '').toLowerCase() === '12h',
    usageApi: u.usageApi !== false,
    pr: u.pr !== false,
    maxRows: Number.isFinite(max) && max > 0 ? Math.floor(max) : Infinity,
    expanded: (ids(u.expanded) ?? []).filter(isRow),
  }
}

// ── glyphs ───────────────────────────────────────────────────────────────────────────────────────
// Nerd Font codepoints (NF names in the comments). On the user's Windows font some Font Awesome
// glyphs render as tofu, so Material Design (nf-md-*, 0xf0xxx) is the safer pick. The desktop
// surface has no Nerd Font: there `glyphs` is false and every icon is dropped.

const cp = (n: number) => String.fromCodePoint(n)
export const G = {
  model: cp(0xf06a9), // nf-md-robot
  effort: cp(0xf0e7), // nf-fa-bolt
  ctx: cp(0xe28c), // nf-fae-brain
  cost: cp(0xf0d6), // nf-fa-money
  clock: cp(0xf0150), // nf-md-clock
  gauge: cp(0xf029a), // nf-md-gauge — Limits lead (a quota meter; the clock stays unique to the Host row)
  duration: cp(0xf252), // nf-fa-hourglass_half
  dir: cp(0xf07c), // nf-fa-folder_open
  tree: cp(0xe5fb), // nf-custom-folder_git_branch
  branch: cp(0xf126), // nf-fa-code_branch
  pr: cp(0xf407), // nf-oct-git_pull_request
  lines: cp(0xeb7e), // nf-cod-edit
  key: cp(0xf084), // nf-fa-key
  tools: cp(0xf013), // nf-fa-gear
  todo: cp(0xf14a), // nf-fa-check_square
  speed: cp(0xf0e7), // nf-fa-bolt
  api: cp(0xf2f2), // nf-fa-stopwatch
  style: cp(0xf1fc), // nf-fa-paint_brush
  think: cp(0xf06e8), // nf-md-lightbulb_on — extended thinking (distinct from the ctx brain)
  version: cp(0xf121), // nf-fa-code
  win: cp(0xf05b3), // nf-md-microsoft_windows
  apple: cp(0xf0035), // nf-md-apple
  linux: cp(0xf17c), // nf-fa-linux — only ever renders on Linux, so the Windows FA-tofu gotcha doesn't apply
  person: cp(0xf0004), // nf-md-account (the FA user glyph is tofu in the Windows font)
  user: cp(0xf007), // nf-fa-user
  fleet: cp(0xf037a), // nf-md-monitor_multiple — OTHER live Claude Code sessions on this machine
  command: cp(0xf120), // nf-fa-terminal
  team: cp(0xf0849), // nf-md-account_group
  tag: cp(0xf02b), // nf-fa-tag
  check: cp(0xf00c), // nf-fa-check
  x: cp(0xf00d), // nf-fa-times
  ahead: cp(0xf062), // nf-fa-arrow_up
  behind: cp(0xf063), // nf-fa-arrow_down
  in: cp(0xf090), // nf-fa-sign_in (input tokens)
  out: cp(0xf08b), // nf-fa-sign_out (output tokens)
  write: cp(0xf0ee), // nf-fa-cloud_upload (cache write)
  read: cp(0xf0ed), // nf-fa-cloud_download (cache read)
  promptCache: cp(0xf00e8), // nf-md-cached
  cfgDoc: cp(0xf0219), // nf-md-file_document — instruction files
  cfgAgents: cp(0xf167a), // nf-md-robot_outline
  cfgCmds: cp(0xf018d), // nf-md-console
  cfgSkills: cp(0xf0068), // nf-md-auto_fix
  cfgRules: cp(0xf0565), // nf-md-shield_check
  cfgMcp: cp(0xf048b), // nf-md-server
  cfgHooks: cp(0xf06e2), // nf-md-hook
  cfgPlugins: cp(0xf1288), // nf-md-toy_brick (LEGO)
  cfgConn: cp(0xf015f), // nf-md-cloud — claude.ai connectors
  cfgDirs: cp(0xf0257), // nf-md-folder_plus
  cfgLsp: cp(0xf0761), // nf-md-code_braces
  cfgMonitor: cp(0xf0437), // nf-md-radar
  cfgTheme: cp(0xf03d8), // nf-md-palette
  cfgBin: cp(0xf0614), // nf-md-application
  cfgChannel: cp(0xf028c), // nf-md-forum
  cfgChrome: cp(0xf268), // nf-fa-chrome (FA exception; if blank use nf-md-google_chrome 0xf02af)
  cfgWorkflows: cp(0xf04aa), // nf-md-sitemap
  cfgRoutines: cp(0xf00f0), // nf-md-calendar_clock
  cfgMemory: cp(0xf09d1), // nf-md-brain — auto-memory files
  github: cp(0xf02a4), // nf-md-github
  gitlab: cp(0xf0ba0), // nf-md-gitlab
  bitbucket: cp(0xf00a8), // nf-md-bitbucket
  repoHost: cp(0xf0ccf), // nf-md-source_repository
}
export const OK = '✔︎' // ✔︎ + text-presentation selector (never emoji)
export const NO = '✘︎' // ✘︎

// Decorative hues (the status line's 256-colour picks; semantic colours are theme keys).
const PINK = c256(211)
const PENCIL = c256(220)
const ORANGE = c256(216)
const SILVER = c256(250)
const CYAN = c256(44)
const BBLUE = c256(75)
const MAGENTA = c256(170)

// ── inputs ───────────────────────────────────────────────────────────────────────────────────────

export type Inputs = {
  usage: Usage | null
  breakdown: Breakdown | null
  model: Model | null
  repo: Repo | null
  host: Host | null
  info: Info | null
  counts: Counts | null
  api: ApiUsage | null
  activity: Activity | null
  now: number
}

/** One icon + space, or nothing where the surface has no Nerd Font. */
type Icon = (glyph: string, color?: string) => Run[]

const plain = (runs: Run[]): Item => ({ wide: runs, narrow: runs })
const pair = (wide: Run[], narrow: Run[]): Item => ({ wide, narrow })
const v = (t: string, c?: string): Run => ({ t, c })
const d = (t: string): Run => ({ t, d: true })

/**
 * Builds every row. `room` is the cells an open row's detail lines get (past the toggle and
 * label); each detail line is cut to it.
 */
export function buildSections(x: Inputs, cfg: Config, glyphs: boolean, room = 80): Section[] {
  const on = (id: string) => !cfg.hide.has(id)
  const icon: Icon = (glyph, color) => (glyphs ? [{ t: glyph, c: color }, { t: ' ' }] : [])
  const build: Record<RowId, () => Section> = {
    model: () => modelRow(x, cfg, on, icon),
    limits: () => limitsRow(x, cfg, on, icon),
    usage: () => usageRow(x, on, icon),
    turn: () => turnRow(x, on, icon),
    activity: () => activityRow(x, on, icon),
    agents: () => agentsRow(x, on, icon),
    repo: () => repoRow(x, on, icon),
    config: () => configRow(x, on, icon),
    exts: () => extsRow(x, on, icon),
    host: () => hostRow(x, cfg, on, icon),
    info: () => infoRow(x, on, icon),
  }
  const details: Partial<Record<RowId, () => Run[][]>> = {
    turn: () => turnDetail(x, on),
    activity: () => activityDetail(x, on),
    agents: () => agentsDetail(x, on, glyphs),
    repo: () => repoDetail(x, on),
  }
  return cfg.rows.map((id) => {
    const s = build[id]()
    const extra = s.items.length ? details[id]?.() ?? [] : []
    return extra.length ? { ...s, detail: extra.map((l) => truncateRuns(l, room)) } : s
  })
}

// ── open-row detail: the history a closed row has no room for ──────────────────────────────────

const ago = (ms: number) => (ms < 60e3 ? 'now' : `${formatDuration(ms)} ago`)

// The last few turns, newest last: how long, what went out, how much came from the cache.
function turnDetail(x: Inputs, on: (id: string) => boolean): Run[][] {
  const turns = x.activity?.turns ?? []
  if (!turns.length || !on('turn.history')) return []
  return turns.map((t, i) => {
    const hit = t.input > 0 ? Math.round((t.cacheRead / t.input) * 100) : 0
    return [
      d(i === turns.length - 1 ? 'last ' : `-${turns.length - 1 - i}   `),
      v(`${Math.max(1, Math.round(t.ms / 1000))}s`),
      d('  out '),
      v(formatTokens(t.output)),
      d('  in '),
      v(formatTokens(t.input)),
      d('  '),
      v(`${hit}%`, hit >= 80 ? GOOD : hit < 50 ? WARN : undefined),
      d(' cached'),
    ]
  })
}

const TODO_MARK: Record<string, [string, string | undefined]> = {
  completed: [OK, GOOD],
  in_progress: ['▸', WARN],
  pending: ['○', undefined],
}

// The todo list, the last few tool calls (✔ answered, ✘ failed, … running), and the sub-agents.
function activityDetail(x: Inputs, on: (id: string) => boolean): Run[][] {
  const a = x.activity
  if (!a) return []
  const lines: Run[][] = []
  const tasks = Object.values(a.tasks)
  const todos = tasks.length ? tasks : a.todoItems ?? []
  if (todos.length && on('activity.todo')) {
    // Around the current item: the last done, the current, and what comes next.
    const cur = Math.max(0, todos.findIndex((t) => t.status !== 'completed'))
    const from = Math.max(0, Math.min(cur - 1, todos.length - 4))
    for (const t of todos.slice(from, from + 4)) {
      const [mark, col] = TODO_MARK[t.status] ?? ['○', undefined]
      lines.push([v(`${mark} `, col), t.status === 'completed' ? d(t.subject) : v(t.subject)])
    }
  }
  if (a.recentTools?.length && on('activity.tool')) {
    // Repeats of the same call collapse into one with a count: `Read(a.ts) ✔︎ ×3`.
    const runs: Array<{ label: string; ok?: boolean; n: number }> = []
    for (const t of a.recentTools) {
      const label = t.target ? `${t.name}(${truncate(t.target, 48)})` : t.name
      const last = runs[runs.length - 1]
      if (last && last.label === label && last.ok === t.ok) last.n++
      else runs.push({ label, ok: t.ok, n: 1 })
    }
    // One call per line, newest last like the turn history: side by side, the targets got cut.
    for (const c of runs.slice(-5)) {
      lines.push([
        v(c.label),
        c.ok === undefined ? v(' …', WARN) : c.ok ? v(` ${OK}`, GOOD) : v(` ${NO}`, BAD),
        ...(c.n > 1 ? [d(` ×${c.n}`)] : []),
      ])
    }
  }
  return lines
}

// The last commit and the first changed paths, coloured like the branch counts.
function repoDetail(x: Inputs, on: (id: string) => boolean): Run[][] {
  const r = x.repo
  if (!r || !on('repo.files')) return []
  const lines: Run[][] = []
  if (r.lastCommit) lines.push([v(r.lastCommit.sha, MAGENTA), v(` ${r.lastCommit.subject}`), d(`  ${ago(x.now - r.lastCommit.at)}`)])
  for (const f of r.files ?? []) {
    const [mark, col] = f.xy === '??' ? ['?', BBLUE] : f.xy.includes('U') ? ['!', BAD] : f.xy[0] !== '.' ? ['+', GOOD] : ['~', WARN]
    lines.push([v(`${mark} `, col), v(f.path)])
  }
  const more = (r.changedTotal ?? 0) - (r.files?.length ?? 0)
  if (more > 0) lines.push([d(`… ${more} more`)])
  return lines
}

// ── Model ────────────────────────────────────────────────────────────────────────────────────────

// Effort, styled to echo Claude Code's /effort menu. The menu animates the top tiers; a band
// redraws on events, so they get a static gradient instead: high = violet, xhigh = a
// violet→lavender→violet sheen, max = a coral→pink→violet→indigo sweep, ultra = a filled chip.
const EFFORT_AMBER = [240, 176, 80]
const EFFORT_GREEN = [122, 201, 132]
const EFFORT_VIOLET = [167, 139, 250]
const EFFORT_SHEEN = [EFFORT_VIOLET, [224, 208, 255], EFFORT_VIOLET]
const EFFORT_GRADIENT = [[240, 138, 110], [236, 107, 160], [214, 108, 190], [168, 130, 226], [124, 142, 232]]
const hex = (rgb: number[]) => `#${rgb.map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`

export function gradient(text: string, stops: number[][]): Run[] {
  const chars = [...text]
  const seg = Math.max(1, stops.length - 1)
  return chars.map((ch, i) => {
    const t = chars.length <= 1 ? 0 : i / (chars.length - 1)
    const p = t * seg
    const k = Math.min(seg - 1, Math.floor(p))
    const f = p - k
    const a = stops[k] ?? stops[0] ?? [255, 255, 255]
    const b = stops[k + 1] ?? a
    return { t: ch, c: hex(a.map((av, j) => av + ((b[j] ?? av) - av) * f)) }
  })
}

export function effortRuns(level: string, icon: Icon): Run[] {
  const bolt = icon(G.effort, SILVER) // the bolt stays a neutral anchor so the TEXT carries the level
  switch (level.toLowerCase()) {
    case 'low':
      return [...bolt, v(level, hex(EFFORT_AMBER))]
    case 'medium':
      return [...bolt, v(level, hex(EFFORT_GREEN))]
    case 'high':
      return [...bolt, v(level, hex(EFFORT_VIOLET))]
    case 'xhigh':
      return [...bolt, ...gradient(level, EFFORT_SHEEN)]
    case 'max':
      return [...bolt, ...gradient(level, EFFORT_GRADIENT)]
    case 'ultra':
    case 'ultracode':
      return [{ t: ` ${level} `, c: '#e0d0ff', bg: '#4a3a8c', b: true }]
    default:
      return [...bolt, v(level)]
  }
}

function modelRow(x: Inputs, cfg: Config, on: (id: string) => boolean, icon: Icon): Section {
  const items: Item[] = []
  const m = x.model
  if (m) items.push(plain([...icon(G.model, CYAN), { t: m.name, b: true }, ...(m.fast ? [v(' '), ...icon(G.speed, WARN)] : [])]))
  const think = m?.thinking && on('model.thinking') ? icon(G.think, c256(183)) : []
  if (m?.effort && on('model.effort')) items.push(plain([...effortRuns(m.effort, icon), ...(think.length ? [v(' '), ...think] : [])]))
  else if (think.length) items.push(plain(think))
  const u = x.usage
  if (u && on('model.context')) {
    const pct = Math.round(u.ctxPercent ?? (u.ctxTokens && u.ctxWindow ? (u.ctxTokens / u.ctxWindow) * 100 : 0))
    const col = contextColor(pct)
    const nums: Run[] = [v(`${pct}%`, col), d(` ${formatTokens(u.ctxTokens ?? 0)}/${formatTokens(u.ctxWindow)}`)]
    const compact = [...icon(G.ctx, PINK), ...nums]
    items.push(pair(cfg.bars ? [...icon(G.ctx, PINK), ...bar(pct, col), v(' '), ...nums] : compact, compact))
  }
  return { id: 'model', label: 'Model', items }
}

// ── Limits ───────────────────────────────────────────────────────────────────────────────────────

function gauge(label: string, pct: number, resetsAt: string | undefined, fmt: 'auto' | 'week' | 'date', windowMs: number, x: Inputs, cfg: Config, extra: Run[] = []): Item {
  const p = Math.round(pct)
  const col = usageColor(p)
  const rt = formatReset(resetsAt, fmt, x.now, cfg.clock12)
  const bal = cfg.pace ? pace(p, resetsAt, windowMs, x.now) : null
  // Kept to a few chars on purpose — the user wants it terse.
  const paceRuns: Run[] = bal === null ? [] : [v(' '), bal > 2 ? v(`+${bal}%`, GOOD) : bal < -2 ? v(`${bal}%`, WARN) : d(`${bal >= 0 ? '+' : ''}${bal}%`)]
  const compact: Run[] = [d(label), v(' '), v(`${p}%`, col), ...extra, ...(rt ? [d(` (${rt})`)] : []), ...paceRuns]
  if (!cfg.bars) return plain(compact)
  return pair([d(label), v(' '), ...bar(p, col), v(' '), v(`${p}%`, col), ...extra, ...(rt ? [d(` ${rt}`)] : []), ...paceRuns], compact)
}

function limitsRow(x: Inputs, cfg: Config, on: (id: string) => boolean, icon: Icon): Section {
  const items: Item[] = []
  const pcts: number[] = []
  const add = (it: Item, p: number) => (items.push(it), pcts.push(p))
  for (const l of x.usage?.limits ?? []) {
    // five_hour and seven_day are the subscription windows; spend_limit is a Claude apps gateway's
    // cap, which keeps counting past 100% once over (shown verbatim; the bar clamps itself).
    if (l.kind === 'five_hour' && on('limits.5h')) add(gauge('5h', l.percentUsed, l.resetsAt, 'auto', 5 * 3600e3, x, cfg), l.percentUsed)
    else if (l.kind === 'seven_day' && on('limits.7d')) add(gauge('7d', l.percentUsed, l.resetsAt, 'week', 7 * 864e5, x, cfg), l.percentUsed)
    else if (l.kind === 'spend_limit' && on('limits.spend')) add(gauge('Sp', l.percentUsed, l.resetsAt, 'date', 0, x, cfg), l.percentUsed)
  }
  // Model-scoped weekly caps, each normalized by the API to its OWN 0-100% (7dF 15% = 15% of the
  // Fable allowance, not of 7d).
  if (on('limits.scoped')) for (const s of x.api?.scoped ?? []) add(gauge(s.label, s.percent, s.resetsAt, 'week', 7 * 864e5, x, cfg), s.percent)
  // Usage credits: only once something has actually been spent — a standing $0 gauge is noise,
  // but the moment credits kick in is exactly the event worth surfacing. No pace (no budget line).
  const cr = x.api?.credits
  if (cr && on('limits.credits')) {
    const money: Run[] = [v(' '), v(formatCost(cr.used)), ...(cr.limit > 0 ? [d(`/$${Math.round(cr.limit)}`)] : [])]
    add(gauge('Cr', cr.percent, undefined, 'auto', 0, x, { ...cfg, pace: false }, money), cr.percent)
  }
  const maxP = pcts.length ? Math.max(...pcts) : 0
  return { id: 'limits', label: 'Limits', lead: items.length ? icon(G.gauge, maxP >= 70 ? usageColor(maxP) : undefined) : [], items }
}

// ── Usage ────────────────────────────────────────────────────────────────────────────────────────

function usageRow(x: Inputs, on: (id: string) => boolean, icon: Icon): Section {
  const items: Item[] = []
  const u = x.usage
  const a = x.activity
  if (!u) return { id: 'usage', label: 'Usage', items }
  const cost = u.costUsd ?? 0
  const elapsed = Math.max(0, x.now - u.startedAt)
  if (u.costUsd !== undefined && on('usage.cost')) items.push(plain([...icon(G.cost, GOOD), v(formatCost(cost))]))
  if (cost > 0 && elapsed >= 60e3 && on('usage.burn')) {
    const hourly = (cost / elapsed) * 3600e3
    items.push(plain([...icon(G.cost, ORANGE), v(`~${formatCost(hourly)}/h`, hourly > 10 ? BAD : hourly > 5 ? WARN : GOOD)]))
  }
  // Model-request time is measured around each of the main loop's model requests (turn.step), so
  // tok/s divides output by time the model was actually streaming, not tool or idle time.
  if (a && a.apiMs > 0 && a.outputTokens > 0 && on('usage.speed')) {
    const tps = a.outputTokens / (a.apiMs / 1000)
    if (Number.isFinite(tps) && tps > 0) items.push(plain([...icon(G.speed, PENCIL), v(String(Math.round(tps))), d(' tok/s')]))
  }
  if (a && a.apiMs > 0 && elapsed > 0 && on('usage.api')) {
    const share = Math.min(100, Math.round((a.apiMs / elapsed) * 100))
    items.push(plain([...icon(G.api, CYAN), v(`API ${formatDuration(a.apiMs)}`, share > 70 ? WARN : undefined)]))
  }
  if (on('usage.duration')) items.push(plain([...icon(G.duration, SILVER), v(formatDuration(elapsed))]))
  return { id: 'usage', label: 'Usage', items }
}

// ── Turn ─────────────────────────────────────────────────────────────────────────────────────────

function turnRow(x: Inputs, on: (id: string) => boolean, icon: Icon): Section {
  const items: Item[] = []
  const c = x.breakdown?.lastCall
  if (c && on('turn.tokens')) {
    const parts: Run[][] = []
    if (c.input > 0) parts.push([...icon(G.in, CYAN), v(formatTokens(c.input))])
    if (c.output > 0) parts.push([...icon(G.out, PENCIL), v(formatTokens(c.output))])
    if (c.cacheWrite > 0) parts.push([...icon(G.write, WARN), v(formatTokens(c.cacheWrite))])
    if (c.cacheRead > 0) parts.push([...icon(G.read, GOOD), v(formatTokens(c.cacheRead))])
    if (parts.length) items.push(plain(parts.flatMap((p, i) => (i ? [d(' | '), ...p] : p))))
  }
  // Prompt-cache hit ratio over the session: cache reads ÷ all input. A long session stuck low is
  // paying full price for its own history.
  const a = x.activity
  if (a && a.inputTotal > 0 && on('turn.cache')) {
    const hp = Math.round((a.cacheRead / a.inputTotal) * 100)
    items.push(plain([...icon(G.promptCache, c256(45)), v(`${hp}%`, hp >= 80 ? GOOD : hp < 50 ? WARN : undefined), d(' cached')]))
  }
  return { id: 'turn', label: 'Turn', items }
}

// ── Activity ─────────────────────────────────────────────────────────────────────────────────────

export function todoProgress(a: Activity): Activity['todos'] {
  const tasks = Object.values(a.tasks)
  if (tasks.length) {
    const current = tasks.find((t) => t.status === 'in_progress') ?? tasks.find((t) => t.status === 'pending')
    return { completed: tasks.filter((t) => t.status === 'completed').length, total: tasks.length, current: current?.subject }
  }
  return a.todos
}

function activityRow(x: Inputs, on: (id: string) => boolean, icon: Icon): Section {
  const items: Item[] = []
  const a = x.activity
  if (!a) return { id: 'activity', label: 'Activity', items }
  if (a.command && on('activity.command')) items.push(plain([...icon(G.command, WARN), v(a.command)]))
  const todo = todoProgress(a)
  if (todo && todo.total > 0 && on('activity.todo')) {
    const pct = Math.round((todo.completed / todo.total) * 100)
    const col = pct === 100 ? GOOD : pct >= 50 ? WARN : BAD
    const count = v(`[${todo.completed}/${todo.total}]`, col)
    items.push(todo.current ? pair([...icon(G.todo, col), v(truncate(todo.current, 26)), v(' '), count], [...icon(G.todo, col), count]) : plain([...icon(G.todo, col), count]))
  }
  if (a.toolCalls > 0 && on('activity.tool')) {
    const lt = a.lastTool
    const label = lt ? (lt.target ? `${lt.name}(${lt.target})` : lt.name) : 'tool'
    const col = a.running > 0 ? WARN : undefined // yellow while a tool is mid-run
    items.push(pair([...icon(G.tools, col), v(label), d(` (${a.toolCalls} call${a.toolCalls === 1 ? '' : 's'})`)], [...icon(G.tools, col), v(truncate(label, 24))]))
  }
  if ((a.linesAdded > 0 || a.linesRemoved > 0) && on('activity.lines')) {
    const diff: Run[] = []
    if (a.linesAdded > 0) diff.push(v(`+${a.linesAdded}`, GOOD))
    if (a.linesRemoved > 0) diff.push(...(diff.length ? [v(' ')] : []), v(`-${a.linesRemoved}`, BAD))
    items.push(plain([...icon(G.lines, PENCIL), ...diff]))
  }
  return { id: 'activity', label: 'Activity', items }
}

// ── Agents ───────────────────────────────────────────────────────────────────────────────────────
// Sub-agents and agent-team teammates, apart from Activity's tool calls: both run often enough to
// want their own history. Closed: how many sub-agents run, a green tally of finished ones (failed in
// red), and who is on the team. Open: the history, newest last (agentsDetail).

const isLive = (st: string) => st === 'running' || st === 'pending' || st === 'waiting'

function agentsRow(x: Inputs, on: (id: string) => boolean, icon: Icon): Section {
  const items: Item[] = []
  const ag = x.activity?.agents
  if (!ag) return { id: 'agents', label: 'Agents', items }
  if ((ag.running > 0 || ag.completed > 0 || ag.failed > 0) && on('agents.subagents')) {
    const bits: Run[][] = []
    if (ag.running > 0) bits.push([v(`${ag.running} running`)])
    if (ag.completed > 0) bits.push([v(`${OK} ${ag.completed}`, GOOD)])
    if (ag.failed > 0) bits.push([v(`${NO} ${ag.failed}`, BAD)])
    items.push(plain([...icon(G.model, ag.running > 0 ? CYAN : undefined), ...bits.flatMap((b, i) => (i ? [d(' · '), ...b] : b))]))
  }
  if (ag.teammates.length && on('agents.team')) {
    const head = [...icon(G.person, c256(43)), v(String(ag.teammates.length))]
    const list = ag.teammates.slice(0, 3).join(', ') + (ag.teammates.length > 3 ? ', …' : '')
    items.push(pair([...head, d(` (${truncate(list, 40)})`)], head))
  }
  return { id: 'agents', label: 'Agents', items }
}

// The last six sub-agents and teammates, plus any older one still running: a robot or a person,
// what it is, what it was asked, and where it stands.
function agentsDetail(x: Inputs, on: (id: string) => boolean, glyphs: boolean): Run[][] {
  const all = x.activity?.agents.list ?? []
  if (!all.length || !on('agents.history')) return []
  return all
    .filter((a, i) => i >= all.length - 6 || isLive(a.status))
    .map((a) => {
      const done = a.status === 'completed' || a.status === 'ended'
      const failed = a.status === 'failed' || a.status === 'killed'
      const idle = a.status === 'idle'
      const [mark, col] = done ? [OK, GOOD] : failed ? [NO, BAD] : idle ? ['◌', undefined] : ['●', WARN]
      const who = glyphs ? [{ t: a.mate ? G.person : G.model, c: a.mate ? c256(43) : CYAN }, { t: ' ' }] : []
      return [v(`${mark} `, col), ...who, v(a.mate ? a.name ?? a.type : a.type), d(`  ${a.description}`)]
    })
}

// ── Repo ─────────────────────────────────────────────────────────────────────────────────────────

function repoRow(x: Inputs, on: (id: string) => boolean, icon: Icon): Section {
  const items: Item[] = []
  const r = x.repo
  if (!r) return { id: 'repo', label: 'Repo', items }
  items.push(plain([...icon(G.tree, BBLUE), v(r.name)]))
  if (r.remote && on('repo.remote')) {
    const h = r.remote.host.toLowerCase()
    const [g, col] = h.includes('github') ? [G.github, SILVER] : h.includes('gitlab') ? [G.gitlab, ORANGE] : h.includes('bitbucket') ? [G.bitbucket, BBLUE] : [G.repoHost, undefined]
    // owner alone when the remote's name matches the folder; owner/name when it differs (fork/rename)
    const same = r.remote.name.toLowerCase() === r.name.toLowerCase()
    items.push(plain([...icon(g, col), v(r.remote.owner), ...(same ? [] : [d('/'), v(r.remote.name)])]))
  }
  if (r.worktree && on('repo.worktree')) items.push(plain([...icon(G.tree, MAGENTA), v(r.worktree)]))
  if (on('repo.branch')) {
    const st: Run[] = [v(r.branch)]
    if (r.ahead > 0) st.push(v(` ${glyphOr(icon, G.ahead, '↑')}${r.ahead}`, GOOD))
    if (r.behind > 0) st.push(v(` ${glyphOr(icon, G.behind, '↓')}${r.behind}`, WARN))
    if (r.staged > 0) st.push(v(` +${r.staged}`, GOOD))
    if (r.modified > 0) st.push(v(` ~${r.modified}`, WARN))
    if (r.untracked > 0) st.push(v(` ?${r.untracked}`, BBLUE))
    if (r.conflicts > 0) st.push(v(` !${r.conflicts}`, BAD))
    items.push(plain([...icon(G.branch, CYAN), ...st]))
  }
  if (r.pr && on('repo.pr')) {
    const s = r.pr.state
    const [col, mark]: [string | undefined, Run[]] =
      s === 'approved' ? [GOOD, [v(` ${OK}`, GOOD)]] : s === 'changes' ? [BAD, [v(` ${NO}`, BAD)]] : s === 'draft' ? [undefined, [d(' draft')]] : s === 'pending' ? [WARN, [v(' ●', WARN)]] : [undefined, []]
    items.push(plain([...icon(G.pr, MAGENTA), { t: `#${r.pr.number}`, c: col, href: r.pr.url }, ...mark]))
  }
  if (r.tag && on('repo.tag')) items.push(plain([...icon(G.tag, MAGENTA), v(r.tag.tag), ...(r.tag.count > 0 ? [v(`+${r.tag.count}`, WARN)] : [])]))
  return { id: 'repo', label: 'Repo', items }
}

const glyphOr = (icon: Icon, glyph: string, fallback: string) => (icon(glyph).length ? glyph : fallback)

// ── Config / Exts. ───────────────────────────────────────────────────────────────────────────────
// `icon total (m/u/p/l/x)`: a count, then a dim parenthetical saying WHERE those items come from.
// Five fixed slots, broad → narrow: managed / user / project / local / plugin. A digit (0 too)
// means the item type CAN come from that scope; `-` means it never can. The parens appear only
// once the total is > 0, and are the first thing dropped when the row runs out of width.

const SCOPES = ['m', 'u', 'p', 'l', 'x'] as const
const total = (c: Scopes) => (c.m ?? 0) + (c.u ?? 0) + (c.p ?? 0) + (c.l ?? 0) + (c.x ?? 0)

function scoped(head: Run[], c: Scopes, caps: string, showScopes: boolean): Item {
  const n = total(c)
  const base = [...head, v(String(n), n > 0 ? GOOD : undefined)]
  if (!caps || n === 0 || !showScopes) return plain(base)
  return pair([...base, d(` (${SCOPES.map((k) => (caps.includes(k) ? String(c[k] ?? 0) : '-')).join('/')})`)], base)
}

function configRow(x: Inputs, on: (id: string) => boolean, icon: Icon): Section {
  const items: Item[] = []
  const c = x.counts
  if (!c) return { id: 'config', label: 'Config', items, preferDetail: true }
  const scopes = on('config.scopes')
  const show = (id: string, glyph: string, color: string, s: Scopes, caps = '') => {
    if (on(`config.${id}`)) items.push(scoped(icon(glyph, color), s, caps, scopes))
  }
  show('instructions', G.cfgDoc, c256(36), c.instructions, 'mupl')
  show('memory', G.cfgMemory, c256(177), c.memory)
  show('agents', G.cfgAgents, c256(211), c.agents, 'mupx')
  show('commands', G.cfgCmds, c256(32), c.commands, 'upx')
  show('skills', G.cfgSkills, c256(141), c.skills, 'mupx')
  show('workflows', G.cfgWorkflows, c256(78), c.workflows, 'upx')
  show('routines', G.cfgRoutines, c256(173), c.routines, 'up')
  show('rules', G.cfgRules, c256(33), c.rules, 'up')
  show('mcp', G.cfgMcp, c256(216), c.mcp, 'muplx')
  show('connectors', G.cfgConn, c256(117), c.connectors)
  if (on('config.chrome')) items.push(plain([...icon(G.cfgChrome, c256(75)), v(c.chrome ? OK : NO)]))
  show('hooks', G.cfgHooks, c256(220), c.hooks, 'muplx')
  show('plugins', G.cfgPlugins, c256(196), c.plugins, 'mupl')
  show('themes', G.cfgTheme, c256(213), c.themes, 'ux')
  show('dirs', G.cfgDirs, c256(250), c.dirs)
  return { id: 'config', label: 'Config', items, preferDetail: true }
}

function extsRow(x: Inputs, on: (id: string) => boolean, icon: Icon): Section {
  const items: Item[] = []
  const c = x.counts
  if (!c) return { id: 'exts', label: 'Exts.', items }
  const show = (id: string, glyph: string, color: string, s: Scopes, caps = '') => {
    if (on(`exts.${id}`)) items.push(scoped(icon(glyph, color), s, caps, on('config.scopes')))
  }
  show('lsp', G.cfgLsp, c256(81), c.lsp)
  show('monitors', G.cfgMonitor, c256(209), c.monitors)
  show('bin', G.cfgBin, c256(108), c.bin)
  show('channels', G.cfgChannel, c256(116), c.channels, 'ux')
  return { id: 'exts', label: 'Exts.', items }
}

// ── Host ─────────────────────────────────────────────────────────────────────────────────────────

function hostRow(x: Inputs, cfg: Config, on: (id: string) => boolean, icon: Icon): Section {
  const items: Item[] = []
  if (on('host.clock')) items.push(plain([...icon(G.clock), v(formatClock(x.now, cfg.clock12))]))
  const h = x.host
  if (h) {
    if (on('host.os')) {
      const [g, col] = h.os.kind === 'windows' ? [G.win, c256(39)] : h.os.kind === 'macos' ? [G.apple, undefined] : [G.linux, c256(208)]
      items.push(plain([...icon(g, col), v(h.os.label)]))
    }
    if ((h.user || h.host) && on('host.user')) {
      const id: Run[] = h.user && h.host ? [v(h.user), d('@'), v(h.host)] : [v(h.user || h.host)]
      items.push(plain([...icon(G.person, c256(114)), ...id]))
    }
    // Other live Claude Code sessions on this machine — the population behind the `← N agent`
    // count in Claude Code's own footer. Hidden at 0: an always-on "none" is noise.
    if (h.fleet.length && on('host.fleet')) {
      const head = [...icon(G.fleet, c256(110)), v(String(h.fleet.length))]
      const list = h.fleet.slice(0, 2).join(', ') + (h.fleet.length > 2 ? ', …' : '')
      items.push(pair([...head, d(` (${list})`)], head))
    }
  }
  return { id: 'host', label: 'Host', items }
}

// ── Info. ────────────────────────────────────────────────────────────────────────────────────────

function infoRow(x: Inputs, on: (id: string) => boolean, icon: Icon): Section {
  const items: Item[] = []
  const i = x.info
  if (!i) return { id: 'info', label: 'Info.', items }
  const cwd = shortenPath(homeRelative(i.cwd, i.home))
  if (cwd && on('info.cwd')) items.push(plain([...icon(G.dir, BBLUE), v(cwd)]))
  if (i.outputStyle && i.outputStyle.toLowerCase() !== 'default' && on('info.style')) items.push(plain([...icon(G.style, PENCIL), v(i.outputStyle)]))
  if (i.version && on('info.version')) items.push(plain([...icon(G.version), v(`v${i.version}`)]))
  if (i.agent && on('info.agent')) items.push(plain([...icon(G.user, SILVER), v(i.agent)]))
  // The id's first segment is enough to recognise it; `claude --resume` takes the whole id.
  if (i.sessionId && on('info.session')) items.push(plain([...icon(G.key, SILVER), v(i.sessionId.split('-')[0] ?? i.sessionId)]))
  return { id: 'info', label: 'Info.', items }
}
