// statusline-dashboard — a mod that draws the dashboard in the band above the prompt, one
// collapsible row per section (Model, Limits, Usage, Turn, Activity, Repo, Config, Exts., Host,
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
} from './collect'
import { ROW_IDS, SECTION_WIDTH, legendLines, plan, stackRuns, stripLabels, type Line, type RowId, type Run } from './layout'
import { buildSections, parseConfig } from './sections'

const usage = atom({ plugin: 'statusline-dashboard', key: 'usage' } as const, null)
const breakdown = atom({ plugin: 'statusline-dashboard', key: 'breakdown' } as const, null)
const model = atom({ plugin: 'statusline-dashboard', key: 'model' } as const, null)
const repo = atom({ plugin: 'statusline-dashboard', key: 'repo' } as const, null)
const host = atom({ plugin: 'statusline-dashboard', key: 'host' } as const, null)
const info = atom({ plugin: 'statusline-dashboard', key: 'info' } as const, null)
const counts = atom({ plugin: 'statusline-dashboard', key: 'counts' } as const, null)
const api = atom({ plugin: 'statusline-dashboard', key: 'api' } as const, null)
const activity = atom({ plugin: 'statusline-dashboard', key: 'activity' } as const, null)
const view = atom({ plugin: 'statusline-dashboard', key: 'view' } as const, { isVisible: true, expanded: [] } as View)
const config = atom({ plugin: 'statusline-dashboard', key: 'config' } as const, null as unknown)
const tick = atom({ plugin: 'statusline-dashboard', key: 'tick' } as const, 0)

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
  }
  await update($, view, () => v)
}

async function saveView($: EngineInterface, fn: (v: View) => View): Promise<View> {
  const next = await update($, view, (v) => fn(v ?? { isVisible: true, expanded: [] }))
  await $.store.set(STORE_VIEW, next)
  return next
}

/** Opens a closed row (as the newest open one) or closes an open one. */
async function toggleRow($: EngineInterface, id: RowId): Promise<void> {
  await saveView($, (v) => ({ ...v, expanded: v.expanded.includes(id) ? v.expanded.filter((x) => x !== id) : [...v.expanded, id] }))
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
  await update($, model, (m) => ({
    name: name || m?.name || 'Unknown Model',
    effort: m?.effort,
    thinking: settings.alwaysThinkingEnabled === true,
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
  await Promise.all([refreshCounts($), refreshApi($)])
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
const short = (s: unknown, n: number) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`
}

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
      description: 'Show or hide the dashboard above the prompt, open or close its rows, or clean up the 1.x status line',
      argumentHint: '[row | open <row|all> | close <row|all> | show | hide | cleanup]',
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
    if (typeof e.effort === 'string') {
      const effort = e.effort
      await update($, model, (m) => (m ? { ...m, effort } : m))
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
    if (isRow(verb)) {
      await toggleRow($, rowOf(verb))
      await saveView($, (x) => ({ ...x, isVisible: true }))
      return { text: `Toggled ${verb}.` }
    }
    return { text: `Usage: /dash [${ROW_IDS.join(' | ')} | open <row|all> | close <row|all> | show | hide | cleanup]` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, view)
    if (e.props.hasSurvey || !v.isVisible) return next(e)
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
    const budget = Math.max(1, Math.min(room, e.props.maxRows, cfg.maxRows))

    const sections = buildSections(inputs, cfg, glyphs, width - indent)
    const b = inputs.breakdown
    const modelRow = sections.find((s) => s.id === 'model')
    if (modelRow && b && !cfg.hide.has('model.context')) {
      const room = width - indent
      modelRow.detail = [stackRuns(b.categories, room), ...legendLines(b.categories, b.maxTokens, room)]
    }
    const laid = plan(sections, v.expanded, budget, width, indent)
    if (!laid.rows.length) return next(e)

    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const runText = (r: Run, k: number) =>
      r.href && Link ? (
        <Link key={String(k)} href={r.href} label={r.t} />
      ) : (
        <Text key={String(k)} color={r.c} backgroundColor={r.bg} bold={r.b} italic={r.i} dimColor={r.d}>
          {r.t}
        </Text>
      )
    const runs = (rs: Run[]) =>
      rs.map((r, i) => (
        <Text key={String(i)} color={r.c} bold={r.b} italic={r.i} dimColor={r.d}>
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
        {l.runs.map(runText)}
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
    return <Box flexDirection="column">{rows}</Box>
  })
}
