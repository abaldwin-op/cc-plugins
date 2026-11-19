// statusline-dashboard — a mod that draws the dashboard in the band above the prompt, one
// collapsible row per section (Model, Limits, Usage, Turn, Activity, Agents, Repo, Config, Host,
// Info.).
//
// WHY A MOD (2.x; 1.x was a Bun `statusLine` script): a plugin can't set `statusLine`, so 1.x had
// to stage scripts into the data dir and edit settings.json — which an uninstall could never undo,
// leaving a status line pointed at a deleted script. A mod needs no settings edit at all: install
// and it draws, uninstall and it's gone. It also gets live engine truth the status line had to
// reconstruct from the transcript and config files (the context breakdown, loaded memory files,
// agents, skills and MCP tools, the agent roster, each model request's effort), and it can be
// interactive: each row folds to one line and opens to its full detail on a click, or ctrl+x tab
// then Tab/Enter on its label.
//
// Data flows one way: event hooks collect into $.state; the ui.render hook only reads it, so a
// write redraws exactly the band. Nothing blocks the render on git, the filesystem or the network.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, Repo, View } from '../types'
import {
  collectAgents,
  type AgentEntry,
  collectApi,
  collectBreakdown,
  collectControls,
  collectCounts,
  collectHost,
  collectInfo,
  collectRepo,
  collectUsage,
  homeDir,
  legacyKeys,
  platform,
  readJson,
  removeLegacy,
  revealFolder,
} from './collect'
import { ROW_IDS, SECTION_WIDTH, clampScroll, legendLines, listRows, packSection, plan, stackRuns, stripLabels, truncate, windowDetail, type DetailWindow, type Line, type RowId, type Run } from './layout'
import { DRILLS, buildSections, drillEntries, drillText, isDrill, parseConfig, type DrillId } from './sections'

const usage = atom({ plugin: 'statusline-dashboard', key: 'usage' } as const, null)
const breakdown = atom({ plugin: 'statusline-dashboard', key: 'breakdown' } as const, null)
const model = atom({ plugin: 'statusline-dashboard', key: 'model' } as const, null)
const repo = atom({ plugin: 'statusline-dashboard', key: 'repo' } as const, null)
const host = atom({ plugin: 'statusline-dashboard', key: 'host' } as const, null)
const info = atom({ plugin: 'statusline-dashboard', key: 'info' } as const, null)
const counts = atom({ plugin: 'statusline-dashboard', key: 'counts' } as const, null)
const api = atom({ plugin: 'statusline-dashboard', key: 'api' } as const, null)
const activity = atom({ plugin: 'statusline-dashboard', key: 'activity' } as const, null)
const controls = atom({ plugin: 'statusline-dashboard', key: 'controls' } as const, null)
const notice = atom({ plugin: 'statusline-dashboard', key: 'notice' } as const, null)

/** How long a notice stays above the rows. */
const NOTICE_MS = 6000
const view = atom({ plugin: 'statusline-dashboard', key: 'view' } as const, { isVisible: true, expanded: [] } as View)
const config = atom({ plugin: 'statusline-dashboard', key: 'config' } as const, null as unknown)
const tick = atom({ plugin: 'statusline-dashboard', key: 'tick' } as const, 0)
const scroll = atom({ plugin: 'statusline-dashboard', key: 'scroll' } as const, {} as Record<string, number>)

// The detail windows the last frame drew, by row, for the rows whose detail did not all fit. The
// render hook works each out from the band's budget, which only it is told; the scroll hook and
// the page buttons need them to know how far a page is, where a row's detail ends, and where its
// window stands unscrolled. A cache of the last frame, not state: it starts over with the module,
// and the next frame sets it again.
const drawn: { rows: Partial<Record<RowId, DetailWindow>> } = { rows: {} }

/** $.store key for the person's view (shown or not, which rows are open), kept across sessions. */
export const STORE_VIEW = 'view'
const API_TTL_MS = 5 * 60e3

export const emptyActivity = (): Activity => ({
  toolCalls: 0,
  running: 0,
  tasks: {},
  linesAdded: 0,
  linesRemoved: 0,
  outputTokens: 0,
  apiMs: 0,
  cacheRead: 0,
  inputTotal: 0,
  agents: { running: 0, completed: 0, failed: 0, teammates: [] },
})

// ── collecting ───────────────────────────────────────────────────────────────────────────────────

async function loadConfig($: EngineInterface): Promise<void> {
  const path = (await $.env.get('CLAUDE_STATUSLINE_CONFIG')) || `${await homeDir($)}/.claude/statusline-dashboard.json`
  const raw = await readJson($, path)
  await update($, config, () => raw)
}

// The person's view, restored from $.store; $.state resets on /clear, so this runs on every
// start-like event. Never toggled → the config file's `expanded` rows.
async function loadView($: EngineInterface): Promise<void> {
  const saved = (await $.store.get(STORE_VIEW)) as Partial<View> | undefined
  const cfg = parseConfig(await read($, config))
  const v: View = {
    isVisible: saved?.isVisible !== false,
    expanded: Array.isArray(saved?.expanded) ? saved.expanded.filter((id) => (ROW_IDS as readonly string[]).includes(id)) : cfg.expanded,
    ...(isDrill(saved?.drill) ? { drill: saved.drill } : {}),
  }
  await update($, view, () => v)
}

async function saveView($: EngineInterface, fn: (v: View) => View): Promise<View> {
  const next = await update($, view, (v) => fn(v ?? { isVisible: true, expanded: [] }))
  await $.store.set(STORE_VIEW, next)
  return next
}

/** Puts a row's detail back where it stands unscrolled. */
async function unscroll($: EngineInterface, id: RowId): Promise<void> {
  await update($, scroll, (o) => {
    const { [id]: _gone, ...rest } = o ?? {}
    return rest
  })
}

/** Opens a closed row (as the newest open one) or closes an open one. */
async function toggleRow($: EngineInterface, id: RowId): Promise<void> {
  await unscroll($, id)
  await saveView($, (v) => ({ ...v, expanded: v.expanded.includes(id) ? v.expanded.filter((x) => x !== id) : [...v.expanded, id] }))
}

/**
 * Opens a Config item's list under the row (the row opens with it, as the newest open one), swaps
 * it for another item's, or closes it when it is the one already showing.
 */
async function toggleDrill($: EngineInterface, id: DrillId, open?: boolean): Promise<void> {
  await unscroll($, 'config')
  await saveView($, (v) => {
    const showing = v.drill === id && v.expanded.includes('config')
    if (open ?? !showing) return { ...v, isVisible: true, drill: id, expanded: [...v.expanded.filter((x) => x !== 'config'), 'config'] }
    const { drill: _closed, ...rest } = v
    return rest
  })
}

/**
 * Says something where the person is looking: a line above the band's first row, gone after a few
 * seconds. The answer to a click in the band belongs beside it; a toast lands in the far corner
 * of the screen, where the two don't read as cause and effect.
 */
async function say($: EngineInterface, text: string): Promise<void> {
  const at = await $.clock.now()
  await update($, notice, () => ({ text, at }))
  $.clock.after(NOTICE_MS, () => void update($, notice, (n) => (n?.at === at ? null : n)))
}

// Thinking can be switched for the session alone (meta+t, `chat:thinkingToggle`): that writes no
// setting and raises no event a mod hears, `config.set` included. The /config row does show it,
// so the row is asked this often; an in-process read, and nothing is written unless it changed.
const CONTROLS_MS = 2000

async function refreshControls($: EngineInterface): Promise<void> {
  const c = await collectControls($)
  if (!c) return
  // Asked every couple of seconds (see CONTROLS_MS): write, and so redraw, only on a change.
  const was = (await read($, controls))?.thinking
  if (was?.value !== c.thinking?.value || was?.locked !== c.thinking?.locked) await update($, controls, () => c)
  // The row is the engine's word on thinking, for this session: the lamp follows it over the
  // saved setting, which a session-only change (meta+t) never touches.
  const on = c.thinking?.value
  if (on === undefined || (await $.env.get('MAX_THINKING_TOKENS'))) return
  if ((await read($, model))?.thinking !== on) await update($, model, (m) => (m ? { ...m, thinking: on } : m))
}

/** Thinking was just set to `value` (the lamp, or the /config menu): the lamp shows it now. */
async function showThinking($: EngineInterface, value: boolean): Promise<void> {
  await update($, model, (m) => (m ? { ...m, thinking: value } : m))
  await update($, controls, (c) => (c?.thinking ? { ...c, thinking: { ...c.thinking, value } } : c))
}

/**
 * Opens one of Claude Code's own pickers, /model or /effort, as if the person typed the command.
 * /model has the models this account is offered, by version, and the consent steps some need;
 * /effort knows the levels the model takes. A mod can list neither. Where a plugin may not run
 * the command now, it is put in the prompt box for the person's Enter.
 */
async function openPicker($: EngineInterface, command: 'model' | 'effort'): Promise<void> {
  let said: string | undefined
  try {
    said = (await $.command.run({ command })).text
  } catch {
    await $.prompt.fill({ text: `/${command}` }).catch(() => undefined)
    await say($, `Press Enter to open /${command}`)
    return
  }
  await refreshBreakdown($)
  // Where /effort's answer does come back as the command's result, take it; the row the answer
  // leaves in the conversation is the signal that always arrives (the session.append hook).
  const level = command === 'effort' ? effortSaid(said) : undefined
  if (level) await update($, model, (m) => (m ? { ...m, effortNow: level } : m))
}

/** The level a session starts at: the env override when it names one, else the saved setting. */
export function startEffort(env: string | undefined, setting: unknown): string | undefined {
  const level = (v: unknown) => (typeof v === 'string' && /^(low|medium|high|xhigh|max)$/i.test(v) ? v.toLowerCase() : undefined)
  return level(env) ?? level(setting)
}

/**
 * The level /effort's answer names, when it names one: "Set effort level to medium (saved as your
 * default for new sessions): …", "… (this session only)", "Kept effort level as high".
 */
export function effortSaid(text: string | undefined): string | undefined {
  return text?.match(/\b(?:set|kept) effort level (?:to|as) ["'`]?(low|medium|high|xhigh|max)\b/i)?.[1]?.toLowerCase()
}

/** The text a conversation row holds: its text blocks, joined. */
function rowText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n')
}

async function toggleThinking($: EngineInterface): Promise<void> {
  const m = await read($, model)
  if (!m) return
  // The engine locks the row for a model that can't turn thinking off, and for a managed setting.
  await refreshControls($)
  if ((await read($, controls))?.thinking?.locked) {
    await say($, `Thinking is locked ${m.thinking ? 'on' : 'off'}: this model can't change it, or a managed setting owns it`)
    return
  }
  const value = !m.thinking
  const res = await $.config.set({ key: 'thinking', value }).catch((e) => ({ deny: String(e) }))
  if (res.deny !== undefined) {
    await say($, `Thinking not changed: ${res.deny}`)
    return
  }
  await showThinking($, value)
  await refreshControls($)
}

/**
 * Moves a row's detail window by `by` lines, within its ends. Back where it stands unscrolled, the
 * row's entry is dropped, so a history standing at its newest line keeps following it.
 */
async function scrollRow($: EngineInterface, id: RowId, by: number): Promise<void> {
  const w = drawn.rows[id]
  if (!w) return
  await update($, scroll, (o) => {
    const { [id]: at, ...rest } = o ?? {}
    const to = clampScroll((at ?? w.base) + by, w.total, w.rows)
    return to === w.base ? rest : { ...rest, [id]: to }
  })
}

async function revealCwd($: EngineInterface): Promise<void> {
  const dir = await $.session.cwd()
  if (!(await revealFolder($, dir))) await say($, `Couldn't open ${dir} in the file manager`)
}

/**
 * What a pressed run does: `drill:<item>` opens that Config item's list, `page:<row>:±1` turns
 * that row's detail a page, `open:model|effort` opens that picker, `toggle:thinking` flips the lamp,
 * `reveal:cwd` opens the working directory in the file manager.
 */
async function press($: EngineInterface, word: string): Promise<void> {
  const [verb, arg = '', value = ''] = word.split(':')
  if (verb === 'drill' && isDrill(arg)) await toggleDrill($, arg)
  else if (verb === 'open' && (arg === 'model' || arg === 'effort')) await openPicker($, arg)
  else if (verb === 'toggle' && arg === 'thinking') await toggleThinking($)
  else if (verb === 'reveal' && arg === 'cwd') await revealCwd($)
  else if (verb === 'page') await scrollRow($, arg as RowId, Number(value) * (drawn.rows[arg as RowId]?.rows ?? 1))
}

async function refreshUsage($: EngineInterface): Promise<void> {
  const u = await collectUsage($)
  if (u) await update($, usage, () => u)
}

async function refreshBreakdown($: EngineInterface): Promise<void> {
  const b = await collectBreakdown($)
  if (b) await update($, breakdown, () => b)
  const name = await $.session.model().catch(() => '')
  const settings = (await $.settings.read().catch(() => ({}))) as Record<string, unknown>
  // Thinking is on unless something turns it off: MAX_THINKING_TOKENS, when set, decides alone
  // (0 = off), as the engine's own check does. Otherwise the /config row says, once it has been
  // read: a change made in the session is in the row at once, and this runs after every turn, so
  // the setting (absent or true = enabled) must not put an older answer back over it.
  const budget = await $.env.get('MAX_THINKING_TOKENS')
  const row = (await read($, controls))?.thinking?.value
  const thinking = budget ? Number(budget) > 0 : (row ?? settings.alwaysThinkingEnabled !== false)
  const effortSaved = startEffort(await $.env.get('CLAUDE_CODE_EFFORT_LEVEL'), settings.effortLevel)
  await update($, model, (m) => ({
    name: name || m?.name || 'Unknown Model',
    // The level in force is the engine's own word (turn.step, /effort's answer). Until it has
    // spoken — a session that has made no request yet — the row falls back to the level a session
    // starts at, drawn dim: right for a fresh or resumed session, and only ever wrong for a
    // session whose /effort change this mod was not loaded to hear.
    effortNow: m?.effortNow,
    effortSaved,
    thinking,
    fast: settings.fastMode === true,
  }))
}

async function refreshRepo($: EngineInterface): Promise<void> {
  const cfg = parseConfig(await read($, config))
  const prev = (await read($, repo)) as Repo | null
  const r = await collectRepo($, await $.session.cwd(), prev, cfg.pr && !cfg.hide.has('repo.pr'), await $.clock.now())
  await update($, repo, () => r)
}

async function refreshCounts($: EngineInterface): Promise<void> {
  const home = await homeDir($)
  const b = await read($, breakdown)
  const r = (await read($, repo)) as Repo | null
  // The project root: the working tree's top when in a repo (a worktree counts its own .claude/).
  const cwd = await $.session.cwd()
  const root = r ? ((await $.process.run(['git', 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 }).catch(() => null))?.stdout.trim() || cwd) : cwd
  const c = await collectCounts($, home, await platform($), root, b, b?.mcpServers ?? [])
  await update($, counts, () => c)
}

async function refreshHost($: EngineInterface): Promise<void> {
  const h = await collectHost($, await homeDir($), await $.session.id())
  await update($, host, () => h)
}

async function refreshInfo($: EngineInterface): Promise<void> {
  const i = await collectInfo($, await homeDir($))
  await update($, info, () => i)
}

async function refreshAgents($: EngineInterface): Promise<void> {
  const live = await collectAgents($)
  if (live) await update($, activity, (a) => ({ ...(a ?? emptyActivity()), agents: mergeAgents((a ?? emptyActivity()).agents, live) }))
}

const isLive = (status: string) => status === 'running' || status === 'pending' || status === 'waiting'

/**
 * Folds the engine's current roster into the session's agent history (sub-agents and teammates).
 * The roster drops an agent soon after it finishes, so one missing from it keeps its last-seen
 * status, and one last seen still running is marked `ended` (it finished between two looks; how,
 * the roster no longer says). Sub-agent counts come from the history, so a finished agent stays
 * counted; teammates are the ones on the team now.
 */
export function mergeAgents(prev: Activity['agents'], live: { members: AgentEntry[] }): Activity['agents'] {
  const now = new Map(live.members.map((x) => [x.id, x]))
  const list = (prev.list ?? []).map((x) => {
    const seen = x.id ? now.get(x.id) : undefined
    if (seen) return seen
    return isLive(x.status) ? { ...x, status: 'ended' } : x
  })
  const known = new Set(list.map((x) => x.id))
  for (const x of live.members) if (!known.has(x.id)) list.push(x)
  const kept = list.slice(-20)
  const subs = kept.filter((x) => !x.mate)
  return {
    running: subs.filter((x) => isLive(x.status)).length,
    completed: subs.filter((x) => x.status === 'completed' || x.status === 'ended').length,
    failed: subs.filter((x) => x.status === 'failed' || x.status === 'killed').length,
    teammates: live.members.filter((x) => x.mate).map((x) => x.name ?? x.type),
    list: kept,
  }
}

// The usage API at most every five minutes, and only for a subscription session (one whose
// responses report rate-limit windows) with the config allowing it.
async function refreshApi($: EngineInterface, force = false): Promise<void> {
  const cfg = parseConfig(await read($, config))
  if (!cfg.usageApi || (cfg.hide.has('limits.scoped') && cfg.hide.has('limits.credits'))) return
  const u = await read($, usage)
  if (!u?.limits.some((l) => l.kind === 'five_hour' || l.kind === 'seven_day')) return
  const now = await $.clock.now()
  const prev = await read($, api)
  if (!force && prev && now - prev.at < API_TTL_MS) return
  const a = await collectApi($, now)
  await update($, api, () => a ?? (prev ? { ...prev, at: now } : null))
}

async function refreshAll($: EngineInterface): Promise<void> {
  await loadConfig($)
  await Promise.all([refreshUsage($), refreshBreakdown($), refreshInfo($), refreshRepo($), refreshHost($), refreshAgents($)])
  await Promise.all([refreshCounts($), refreshApi($), refreshControls($)])
}

// Every minute: the clock, reset countdowns and pace move with nothing else changing; the config
// file may have been edited; other sessions come and go.
async function everyMinute($: EngineInterface): Promise<void> {
  await update($, tick, (n) => (n ?? 0) + 1)
  await loadConfig($)
  await Promise.all([refreshHost($), refreshApi($), refreshRepo($)])
}

// 1.x left `statusLine` blocks in settings.json pointing at its scripts: say so once per session.
async function warnLegacy($: EngineInterface): Promise<void> {
  const settings = await readJson($, `${await homeDir($)}/.claude/settings.json`)
  if (legacyKeys(settings).length) $.ui.toast('statusline-dashboard now draws above the prompt — run /dash cleanup to remove the old status line from settings.json')
}

// ── activity ─────────────────────────────────────────────────────────────────────────────────────

const base = (p: unknown) => String(p ?? '').replace(/\\/g, '/').split('/').pop() ?? ''
const short = (s: unknown, n: number) => truncate(String(s ?? ''), n)

export function toolTarget(name: string, input: Record<string, unknown>): string | undefined {
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return typeof input.file_path === 'string' ? base(input.file_path) : undefined
    case 'Glob':
    case 'Grep':
      return typeof input.pattern === 'string' ? short(input.pattern, 20) : undefined
    case 'Bash':
      return typeof input.command === 'string' ? short(input.command, 25) : undefined
    case 'Agent':
    case 'Task':
      return typeof input.subagent_type === 'string' ? input.subagent_type : typeof input.description === 'string' ? short(input.description, 25) : undefined
    case 'Skill':
      return typeof input.skill === 'string' ? input.skill : undefined
    case 'WebFetch':
      return typeof input.url === 'string' ? (input.url.match(/^[a-z]+:\/\/([^/]+)/i)?.[1] ?? short(input.url, 25)) : undefined
    case 'WebSearch':
      return typeof input.query === 'string' ? short(input.query, 25) : undefined
    case 'TaskCreate':
      return typeof input.subject === 'string' ? short(input.subject, 25) : undefined
    case 'TaskUpdate':
      return input.taskId !== undefined ? `#${String(input.taskId)}` : undefined
    default:
      return undefined
  }
}

/** A tool's display name: an MCP tool's `mcp__server__tool` reads `server:tool`. */
export const toolName = (name: string) => name.match(/^mcp__(.+?)__(.+)$/)?.slice(1).join(':') ?? name

/** Lines an edit adds and removes: the old and new text with their common head and tail lines trimmed. */
export function editLines(oldText: string, newText: string): { added: number; removed: number } {
  const a = oldText ? oldText.split('\n') : []
  const b = newText ? newText.split('\n') : []
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  return { added: b.length - head - tail, removed: a.length - head - tail }
}

const normStatus = (s: unknown) => {
  const v = String(s ?? '')
  return v === 'not_started' ? 'pending' : v === 'running' ? 'in_progress' : v === 'complete' || v === 'done' ? 'completed' : v
}

/** Folds one main-loop tool call (its input, and its result text once answered) into the activity. */
export function recordTool(a: Activity, name: string, input: Record<string, unknown>, resultText?: string, isError = false): Activity {
  const next: Activity = { ...a, tasks: { ...a.tasks }, recentTools: [...(a.recentTools ?? [])] }
  if (resultText === undefined) {
    next.toolCalls += 1
    next.running += 1
    next.lastTool = { name: toolName(name), target: toolTarget(name, input) }
    // Agent calls stay out: the agent list beside it shows each one, with its task and status.
    if (name !== 'Agent' && name !== 'Task') next.recentTools = [...(next.recentTools ?? []), { name: toolName(name), target: toolTarget(name, input) }].slice(-8)
    if (name === 'TodoWrite' && Array.isArray(input.todos)) {
      const todos = input.todos as Array<{ status?: string; content?: string }>
      const current = todos.find((t) => normStatus(t.status) === 'in_progress') ?? todos.find((t) => normStatus(t.status) === 'pending')
      next.todos = { completed: todos.filter((t) => normStatus(t.status) === 'completed').length, total: todos.length, current: current?.content }
      next.todoItems = todos.map((t) => ({ subject: String(t.content ?? ''), status: normStatus(t.status) }))
    }
    if (name === 'Edit') {
      const d = editLines(String(input.old_string ?? ''), String(input.new_string ?? ''))
      next.linesAdded += d.added
      next.linesRemoved += d.removed
    } else if (name === 'MultiEdit' && Array.isArray(input.edits)) {
      for (const e of input.edits as Array<{ old_string?: string; new_string?: string }>) {
        const d = editLines(String(e.old_string ?? ''), String(e.new_string ?? ''))
        next.linesAdded += d.added
        next.linesRemoved += d.removed
      }
    } else if (name === 'Write' && typeof input.content === 'string') {
      next.linesAdded += input.content.split('\n').length
    }
    return next
  }
  next.running = Math.max(0, next.running - 1)
  // Mark the newest unanswered call of this tool answered.
  const tools = next.recentTools ?? []
  for (let i = tools.length - 1; i >= 0; i--) {
    const t = tools[i]
    if (t && t.name === toolName(name) && t.ok === undefined) {
      tools[i] = { ...t, ok: !isError }
      break
    }
  }
  // TaskCreate answers "Task #N created …"; TaskUpdate names the task it changes.
  if (name === 'TaskCreate' && typeof input.subject === 'string') {
    const id = resultText.match(/#(\d+)/)?.[1] ?? String(Object.keys(next.tasks).length + 1)
    next.tasks[id] = { subject: input.subject, status: normStatus(input.status ?? 'pending') }
  } else if (name === 'TaskUpdate' && input.taskId !== undefined) {
    const id = String(input.taskId)
    const t = next.tasks[id]
    if (t) next.tasks[id] = { subject: typeof input.subject === 'string' ? input.subject : t.subject, status: input.status ? normStatus(input.status) : t.status }
  }
  return next
}

// ── drawing ──────────────────────────────────────────────────────────────────────────────────────

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'dash',
      description: 'Show or hide the dashboard above the prompt, open or close its rows, list what a Config item counts, or clean up the 1.x status line',
      argumentHint: '[row | config <item> | open <row|all> | close <row|all> | show | hide | cleanup]',
      immediate: true,
    })
    await update($, activity, (a) => a ?? emptyActivity())
    await loadConfig($)
    await loadView($)
    await refreshUsage($)
    // The slow part (git, config scans, the usage API) runs off the start, so it never holds up
    // the first prompt; the band fills in as each piece lands.
    $.clock.after(0, () => void refreshAll($).then(() => warnLegacy($)))
    $.clock.every(60e3, () => void everyMinute($))
    $.clock.every(CONTROLS_MS, () => void refreshControls($))
    return next(e)
  })

  // /clear, /resume, /branch and compaction reset or reshape the session ($.state resets with
  // /clear too): bring the view back and measure again.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork', 'compact'] }, async ($, e, next) => {
    if (e.source === 'clear') await update($, activity, () => emptyActivity())
    await loadConfig($)
    await loadView($)
    $.clock.after(0, () => void refreshAll($))
    return next(e)
  }).catch(($, e, next) => next(e)) // observing only: on a failure, carry on as if unhooked

  // Pushed after each main-thread turn and when a rate-limit window moves a point.
  on('session.measure', async ($, e, next) => {
    await refreshUsage($)
    if (e.changed.includes('context')) await refreshBreakdown($)
    if (e.changed.includes('rateLimits')) await refreshApi($)
    return next(e)
  })

  // Each model request of the main loop: its effort is the live truth for the Model row, and its
  // duration is API time (what tok/s divides by — tool and idle time excluded).
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const started = await $.clock.now()
    if (typeof e.effort === 'string' || typeof e.effort === 'number') {
      const effort = String(e.effort)
      await update($, model, (m) => (m ? { ...m, effortNow: effort } : m))
    }
    try {
      return yield* next(e)
    } finally {
      const ms = (await $.clock.now()) - started
      await update($, activity, (a) => ({ ...(a ?? emptyActivity()), apiMs: (a?.apiMs ?? 0) + ms }))
    }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      const u = e.usage
      if (u) {
        await update($, activity, (a) => {
          const x = a ?? emptyActivity()
          return {
            ...x,
            outputTokens: x.outputTokens + u.output_tokens,
            cacheRead: x.cacheRead + u.cache_read_input_tokens,
            inputTotal: x.inputTotal + u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
            command: undefined,
            turns: [
              ...(x.turns ?? []),
              { ms: e.durationMs, output: u.output_tokens, input: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens, cacheRead: u.cache_read_input_tokens },
            ].slice(-5),
          }
        })
      }
      // git and the config scan after the turn, off its dispatch: edits and commits land here.
      $.clock.after(0, () => void refreshRepo($).then(() => refreshCounts($)))
    }
    await refreshAgents($)
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    if (!e.isMeta) {
      const command = e.command ? `/${e.command.name}` : undefined
      await update($, activity, (a) => ({ ...(a ?? emptyActivity()), command }))
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // observing only: on a failure, carry on as if unhooked

  // Observes main-loop tool calls only; never refuses one.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const name = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    await update($, activity, (a) => recordTool(a ?? emptyActivity(), name, input))
    if (name === 'Agent' || name === 'Task') $.clock.after(500, () => void refreshAgents($))
    const result = await next(e)
    await update($, activity, (a) => recordTool(a ?? emptyActivity(), name, input, String(result.text ?? ''), 'deny' in result || result.isError === true))
    // A foreground agent's call returns as the agent finishes: look before the roster drops it.
    if (name === 'Agent' || name === 'Task') await refreshAgents($)
    return result
  }).catch(($, e, next) => next(e)) // observing only: on a failure, carry on as if unhooked

  // /effort's answer ("Set effort level to medium …") is the one word on the level in force
  // between model requests, and it reaches a mod in one place for certain: the row it leaves in
  // the conversation, raised here once as it is stored, however the command was run (typed,
  // clicked in the band, its picker confirmed with Enter or `s`). The command's own result does
  // not carry it for the picker, and the saved setting is silent on a session-only pick.
  on('session.append', { door: ['command', 'notice'] }, async ($, e, next) => {
    const stored = await next(e)
    if (e.agentId === undefined && e.origin.kind !== 'model') {
      const level = effortSaid(rowText(e.message.content))
      if (level) await update($, model, (m) => (m ? { ...m, effortNow: level } : m))
    }
    return stored
  }).catch(($, e, next) => next(e)) // observing only: on a failure, carry on as if unhooked

  // The same answer where it does come back as the command's result (a typed `/effort high`).
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const result = await next(e)
    const level = effortSaid(result.text)
    if (level) await update($, model, (m) => (m ? { ...m, effortNow: level } : m))
    return result
  }).catch(($, e, next) => next(e)) // observing only: on a failure, carry on as if unhooked

  // Thinking changed in Claude Code's own /config menu (or by the lamp): the row is written as
  // `next` resolves, so the lamp is told here, at once (a session-only switch: CONTROLS_MS).
  // What follows `next` can't fail the hook: a failure then would have the row written twice.
  on('config.set', { key: 'thinking' }, async ($, e, next) => {
    const res = await next(e)
    if (res.deny === undefined && typeof res.value === 'boolean') await showThinking($, res.value).catch(() => undefined)
    return res
  }).catch(($, e, next) => next(e)) // observing only: on a failure, carry on as if unhooked

  on('command.run', { command: 'dash' }, async ($, e) => {
    const [verb = '', arg = ''] = e.args.trim().toLowerCase().split(/\s+/)
    const isRow = (s: string): s is RowId => (ROW_IDS as readonly string[]).includes(s.replace(/\.$/, ''))
    const rowOf = (s: string) => s.replace(/\.$/, '') as RowId
    if (verb === '') {
      const v = await saveView($, (x) => ({ ...x, isVisible: !x.isVisible }))
      return { text: v.isVisible ? 'Dashboard shown.' : 'Dashboard hidden — /dash shows it again.' }
    }
    if (verb === 'show' || verb === 'hide') {
      await saveView($, (x) => ({ ...x, isVisible: verb === 'show' }))
      return { text: verb === 'show' ? 'Dashboard shown.' : 'Dashboard hidden — /dash shows it again.' }
    }
    if (verb === 'cleanup') {
      const removed = await removeLegacy($, await homeDir($))
      return {
        text: removed.length
          ? `Removed ${removed.join(' and ')} from ~/.claude/settings.json (backup: settings.json.bak). Restart Claude Code to drop the old status line.`
          : 'No statusline-dashboard 1.x status line found in ~/.claude/settings.json.',
      }
    }
    if ((verb === 'open' || verb === 'close') && (arg === 'all' || isRow(arg))) {
      await saveView($, (x) => {
        if (arg === 'all') return { ...x, isVisible: true, expanded: verb === 'open' ? [...ROW_IDS] : [] }
        const rest = x.expanded.filter((r) => r !== rowOf(arg))
        return { ...x, isVisible: true, expanded: verb === 'open' ? [...rest, rowOf(arg)] : rest }
      })
      return { text: `${verb === 'open' ? 'Opened' : 'Closed'} ${arg}.` }
    }
    // `/dash config skills`: the whole list in the transcript (the band shows a window of it), and
    // the band's list opened on it. `/dash exts` still answers, for the row that item used to be.
    const item = verb === 'config' && arg ? arg : verb === 'exts' ? 'exts' : ''
    if (item) {
      if (!isDrill(item)) return { text: `No Config item "${item}". Items: ${Object.keys(DRILLS).join(', ')}.` }
      const cfg = parseConfig(await read($, config))
      const shows = (id: string) => !cfg.hide.has(id)
      const c = await read($, counts)
      if (drillEntries(c, item, shows).length) await toggleDrill($, item, true)
      return { text: drillText(c, item, shows) }
    }
    if (isRow(verb)) {
      await toggleRow($, rowOf(verb))
      await saveView($, (x) => ({ ...x, isVisible: true }))
      return { text: `Toggled ${verb}.` }
    }
    return { text: `Usage: /dash [${ROW_IDS.join(' | ')} | config <${Object.keys(DRILLS).join('|')}> | open <row|all> | close <row|all> | show | hide | cleanup]` }
  })

  // The band's tree always fits its room, so the engine has nothing of it to scroll; what the
  // wheel over the band (and the scroll keys while it has the focus) can move is an open row's
  // detail: the row opened last among those with more than fits. Answering without `next` keeps
  // the engine's window where it is; the write redraws the band with the detail moved. With
  // nothing to scroll the move is the engine's.
  on('ui.scroll', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, view)
    const row = [...v.expanded].reverse().find((id) => drawn.rows[id as RowId]) as RowId | undefined
    if (e.origin.kind !== 'person' || !v.isVisible || !row) return next(e)
    await scrollRow($, row, e.by)
    return {}
  }).catch(($, e, next) => next(e)) // on a failure the move is the engine's again

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, view)
    if (e.props.hasSurvey || !v.isVisible) return next(e)
    // The band draws ONE tree, and hooks beneath only run if we ask: answering without `next` hid
    // every other mod's note here, the built-in you-should-know tips included (which then count
    // each prompt sent past an unseen note as ignored and back off). Ask first; while something
    // beneath draws, yield the band to it as to a survey. Nothing there is the engine's own node.
    const below = await next(e)
    if (below.type !== 'engine') return below
    const cfg = parseConfig(await read($, config))
    await read($, tick) // subscribe: the minute tick redraws the clock and countdowns
    const now = await $.clock.now()
    const inputs = {
      usage: await read($, usage),
      breakdown: await read($, breakdown),
      model: await read($, model),
      repo: await read($, repo),
      host: await read($, host),
      info: await read($, info),
      counts: await read($, counts),
      api: await read($, api),
      activity: await read($, activity),
      controls: await read($, controls),
      now,
    }
    const glyphs = e.surface === 'terminal'
    // One cell of cushion: a glyph a font draws wider than measured must never hard-wrap a row.
    const width = Math.max(20, e.props.bodyColumns - 1)
    const toggleW = 2 // "▸ "
    const indent = toggleW + (cfg.labels ? SECTION_WIDTH + 1 : 0)
    // Height: in fullscreen the band gets what the bottom slot has left (capped by the engine at
    // half the terminal); on the main screen maxRows is the whole terminal, so take a third, as
    // the status line did, leaving the transcript room.
    const vp = e.viewport
    const room = vp?.isFullscreen === false ? Math.floor(vp.rows / 3) : e.props.maxRows
    // A notice takes one line of the budget while it shows, so the rows plan around it.
    const said = await read($, notice)
    const budget = Math.max(1, Math.min(room, e.props.maxRows, cfg.maxRows) - (said ? 1 : 0))

    const drill = isDrill(v.drill) && v.expanded.includes('config') ? v.drill : undefined
    const sections = buildSections(inputs, cfg, glyphs, width - indent, drill)
    const b = inputs.breakdown
    const modelRow = sections.find((s) => s.id === 'model')
    if (modelRow && b && !cfg.hide.has('model.context')) {
      const room = width - indent
      modelRow.detail = [stackRuns(b.categories, room), ...legendLines(b.categories, b.maxTokens, room, Infinity)]
    }
    // Each open row's detail, cut to a window sized to the budget so the plan never has to cut
    // it; what is left over scrolls (ui.scroll, the page buttons).
    drawn.rows = {}
    const at = await read($, scroll)
    for (const s of sections) {
      if (!s.detail?.length || !v.expanded.includes(s.id)) continue
      const w = windowDetail(s, at?.[s.id], listRows(budget, packSection(s, width, indent).length, s.detail.length), width - indent)
      s.detail = w.lines
      if (w.total > w.rows) drawn.rows[s.id] = w
    }
    const laid = plan(sections, v.expanded, budget, width, indent)
    if (!laid.rows.length) return next(e)
    // The padding only takes room the rows left over; it never costs a row or a fold.
    const height = laid.rows.reduce((n, r) => n + r.lines.length, 0) + (laid.overflow.length ? 1 : 0)
    const pad = Math.max(0, Math.min(cfg.padTop, budget - height))

    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const runText = (r: Run, k: number) =>
      r.href && Link ? (
        <Link key={String(k)} href={r.href} label={r.t} />
      ) : (
        <Text key={String(k)} color={r.c} backgroundColor={r.bg} weight={r.b ? 'semibold' : undefined} italic={r.i} dimColor={r.d} underline={r.u}>
          {r.t}
        </Text>
      )
    // A line's runs, each stretch that shares a `press` word drawn as one Button (a Config item,
    // a page arrow): a press word shows once in the band, so it keys the Button.
    const lineRuns = (rs: Run[]) => {
      const out = []
      for (let i = 0; i < rs.length; ) {
        const word = rs[i]?.press
        let j = i + 1
        while (word && rs[j]?.press === word) j++
        if (word) {
          out.push(
            <Button key={`item:${word}`} plain onPress={() => void press($, word)}>
              {rs.slice(i, j).map(runText)}
            </Button>,
          )
        } else out.push(runText(rs[i] as Run, i))
        i = j
      }
      return out
    }
    const runs = (rs: Run[]) =>
      rs.map((r, i) => (
        <Text key={String(i)} color={r.c} weight={r.b ? 'semibold' : undefined} italic={r.i} dimColor={r.d}>
          {r.t}
        </Text>
      ))
    // The head is a Button only when the row has more to show than its closed line; a row that is
    // already whole gets its label with no arrow and nothing to press.
    const line = (l: Line, head: Run[] | null, canToggle: boolean, id: RowId, k: number) => (
      <Box key={`${id}:${k}`} flexDirection="row">
        {!head ? (
          <Text>{' '.repeat(indent)}</Text>
        ) : canToggle ? (
          <Button key={`row:${id}`} plain onPress={() => void toggleRow($, id)}>
            {runs(head)}
          </Button>
        ) : (
          <Box key={`head:${id}`} flexDirection="row">
            {runs(head)}
          </Box>
        )}
        {lineRuns(l.runs)}
      </Box>
    )
    const rows = laid.rows.flatMap((r) => {
      // ▾ open · ▸ closed, more inside · ▹ open but folded to one line for room · none: nothing more
      const arrow = !r.canToggle ? '  ' : r.state === 'open' ? '▾ ' : r.state === 'folded' ? '▹ ' : '▸ '
      const head: Run[] = [{ t: arrow, c: 'suggestion' }, ...(cfg.labels ? [{ t: r.label.padEnd(SECTION_WIDTH) + ' ', b: true, i: true, d: true }] : [])]
      return r.lines.map((l, k) => line(l, l.isHead ? head : null, r.canToggle, r.id, k))
    })
    if (laid.overflow.length) {
      const labels = stripLabels(laid.overflow.map((o) => o.label), width)
      rows.push(
        <Box key="overflow" flexDirection="row" columnGap={1}>
          <Text dimColor>+</Text>
          {laid.overflow.slice(0, labels.length).map((o, i) => (
            <Button key={`row:${o.id}`} plain dimColor onPress={() => void toggleRow($, o.id)}>
              {labels[i] ?? o.label}
            </Button>
          ))}
        </Box>,
      )
    }
    return (
      <Box flexDirection="column" paddingTop={pad}>
        {said ? (
          <Text key="notice" color="warning">
            {truncate(said.text, width)}
          </Text>
        ) : null}
        {rows}
      </Box>
    )
  })
}
