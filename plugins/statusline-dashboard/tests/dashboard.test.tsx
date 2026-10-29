import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { legacyKeys, parseApiUsage, parseChanged, parseGitStatus, parseLastCommit, parseRemote, parseTag } from '../hooks/collect'
import { DROP_ORDER, ROW_IDS, bar, cells, legendLines, pace, packSection, plan, runsWidth, stack, stackRuns, stripLabels, type Section } from '../hooks/layout'
import { editLines, emptyActivity, mergeAgents, recordTool, toolTarget } from '../hooks/register'
import { buildSections, parseConfig } from '../hooks/sections'

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────

// What Claude Code passes a ui.render hook for the band, apart from the app.
const BAND = {
  plugin: 'statusline-dashboard',
  component: 'AbovePrompt',
  viewport: { columns: 120, rows: 40, isFullscreen: true },
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 115,
    scroll: { offset: 0, bodyRows: 11 },
    view: {},
  },
} as const

const categories = [
  { name: 'System prompt', tokens: 6000, color: 'promptBorder', isDeferred: false, kind: 'used' },
  { name: 'System tools', tokens: 14000, color: 'permission', isDeferred: false, kind: 'used' },
  { name: 'Messages', tokens: 60000, color: 'success', isDeferred: false, kind: 'used' },
  { name: 'Deferred tools', tokens: 9000, color: 'inactive', isDeferred: true, kind: 'deferred' },
  { name: 'Autocompact buffer', tokens: 20000, color: 'warning', isDeferred: false, kind: 'buffer' },
  { name: 'Free space', tokens: 100000, color: 'inactive', isDeferred: false, kind: 'free' },
] as Array<{ name: string; tokens: number; color: string; isDeferred: boolean; kind: 'used' | 'free' | 'buffer' | 'deferred' }>
const segs = categories.map(({ name, tokens, color, kind }) => ({ name, tokens, color, kind }))

const usage = (withBreakdown: boolean) => ({
  startedAt: 0,
  context: {
    tokens: 80000,
    window: 200000,
    percent: 40,
    ...(withBreakdown
      ? {
          breakdown: {
            categories,
            totalTokens: 80000,
            maxTokens: 200000,
            rawMaxTokens: 200000,
            autocompactSource: 'model-default' as never,
            percentage: 40,
            gridRows: [],
            model: 'Opus',
            memoryFiles: [
              { path: '/work/CLAUDE.md', type: 'Project', tokens: 500 },
              { path: '/home/me/.claude/CLAUDE.md', type: 'User', tokens: 200 },
            ],
            mcpTools: [{ name: 'mcp__linear__x', serverName: 'linear', tokens: 10, isLoaded: true }],
            agents: [{ agentType: 'reviewer', source: 'projectSettings', tokens: 30 }],
            isAutoCompactEnabled: true,
            apiUsage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 70000, cache_creation_input_tokens: 800 },
          },
        }
      : {}),
  },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 42, resetsAt: new Date(3 * 3600e3).toISOString() },
    { kind: 'seven_day', percentUsed: 13, resetsAt: new Date(5 * 864e5).toISOString() },
  ],
  cost: { usd: 1.5 },
})

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const fail = () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

/** The engine beneath the mod: a session in /work, a git repo, an empty home. */
// `beneath` stands for whatever draws under the plugin in the band (another mod's note, a survey);
// left out, or answering nothing, it is the engine's own node, which draws nothing there.
type Beneath = ($: any, e: any) => unknown
function engine(on: On, files: Record<string, string> = {}, store: Record<string, unknown> = {}, beneath?: Beneath) {
  const clock = mock.clock(on, { now: 3600e3 })
  on('ui.render', ($, e) => (beneath?.($, e) ?? { type: 'engine', ref: 0 }) as never)
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  mock.env(on, { HOME: '/home/me', USER: 'me', HOSTNAME: 'box.local' })
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'dash' } }) as never)
  on('session.usage', ($, e) => ({ value: usage(!!e.breakdown) }))
  on('session.model', () => ({ value: 'Opus 4.7' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.id', () => ({ value: 'abcd1234-0000' }))
  on('session.version', () => ({ value: { version: '2.1.310' } }))
  on('session.authorize', () => ({ value: null }))
  on('settings.read', () => ({ value: {} }))
  on('agent.list', () => ({ value: [] }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', ($, e) => {
    const text = files[e.path]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('process.run', ($, e) => {
    const cmd = e.argv.join(' ')
    if (cmd.startsWith('uname')) return ok('Linux\n')
    if (cmd.includes('status --porcelain')) return ok('# branch.oid abc\n# branch.head main\n# branch.ab +2 -0\n1 M. N... 100644 100644 100644 a b f\n? new.txt\n')
    if (cmd.includes('rev-parse')) return ok('/work\n/work/.git\n')
    if (cmd.includes('remote get-url')) return ok('git@github.com:me/work.git\n')
    if (cmd.includes('describe')) return ok('v1.2.0-3-gabc1234\n')
    return fail()
  })
  return clock
}

/** What the person typing `/dash <args>` raises. */
const dash = (args: string) => ({ command: 'dash', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } }) as never

// ── pure layout ──────────────────────────────────────────────────────────────────────────────────

test('the context stack fills the width exactly, skips deferred rows, and keeps every row visible', () => {
  for (const width of [10, 37, 60, 200]) {
    const bar = stack(segs, width)
    expect(bar.reduce((n, s) => n + s.cells, 0)).toBe(width)
    expect(bar.some((s) => s.name === 'Deferred tools')).toBe(false)
    expect(bar.every((s) => s.cells >= 1)).toBe(true)
  }
  expect(stack(segs, 0)).toEqual([])
  expect(runsWidth(stackRuns(segs, 60))).toBe(60)
  const legend = legendLines(segs, 200000, 40)
  expect(legend.length).toBeLessThanOrEqual(2)
  for (const l of legend) expect(runsWidth(l)).toBeLessThanOrEqual(40)
})

test('a packed row never exceeds the width, whatever the width', () => {
  const cfg = parseConfig({})
  const x = { usage: null, breakdown: null, model: { name: 'Opus 4.7', effort: 'xhigh', thinking: true, fast: true }, repo: null, host: { os: { kind: 'linux' as const, label: 'Debian 12' }, user: 'me', host: 'box', fleet: ['a', 'b', 'c'] }, info: { cwd: '/home/me/src/some/very/deeply/nested/project/dir', home: '/home/me', version: '2.1.310', sessionId: 'abcd-1' }, counts: null, api: null, activity: emptyActivity(), now: 0 }
  for (const glyphs of [true, false]) {
    for (const width of [20, 33, 47, 80, 140]) {
      for (const s of buildSections(x, cfg, glyphs)) {
        for (const max of [1, 2, Infinity]) {
          const lines = packSection(s, width, 11, max)
          expect(lines.length).toBeLessThanOrEqual(max)
          for (const l of lines) expect(runsWidth(l.runs)).toBeLessThanOrEqual(width - 11)
        }
      }
    }
  }
})

test('the plan keeps to the budget: folds the oldest open row, then sends rows to the strip', () => {
  const item = (t: string) => ({ wide: [{ t }], narrow: [{ t }] })
  const sections: Section[] = ROW_IDS.map((id) => ({ id, label: id, items: [item(`${id}-a`), item(`${id}-b`), item(`${id}-c`)] }))
  // Narrow enough that an open row wraps to three lines.
  const width = 11 + 9
  const p = plan(sections, ['model', 'repo'], 12, width, 11)
  const used = p.rows.reduce((n, r) => n + r.lines.length, 0) + (p.overflow.length ? 1 : 0)
  expect(used).toBeLessThanOrEqual(12)
  expect(p.rows.find((r) => r.id === 'repo')?.state).toBe('open') // the newest open row wins
  expect(p.rows.find((r) => r.id === 'model')?.state).toBe('folded')

  const tight = plan(sections, [], 4, 80, 11)
  expect(tight.rows.length).toBe(3)
  expect(tight.overflow.length).toBe(ROW_IDS.length - 3)
  // The essentials keep their seats: the last three of DROP_ORDER.
  expect(tight.rows.map((r) => r.id).sort()).toEqual(DROP_ORDER.slice(-3).sort())
  // An open row keeps its seat even when it would have been dropped.
  const keepOpen = plan(sections, ['exts'], 4, 80, 11)
  expect(keepOpen.rows.some((r) => r.id === 'exts')).toBe(true)
  // An open row that needs more room than is left takes seats from the less essential rows first.
  const roomy = plan(sections, ['limits'], 6, width, 11)
  expect(roomy.rows.find((r) => r.id === 'limits')?.lines.length).toBe(3)
  expect(roomy.rows.reduce((n, r) => n + r.lines.length, 0) + 1).toBeLessThanOrEqual(6)
})

test('a row gets a toggle only when opening it shows more', () => {
  const short: Section = { id: 'usage', label: 'Usage', items: [{ wide: [{ t: '$1' }], narrow: [{ t: '$1' }] }] }
  const barred: Section = { id: 'limits', label: 'Limits', items: [{ wide: [{ t: '5h ██░░ 4%' }], narrow: [{ t: '5h 4%' }] }, { wide: [{ t: '7d ██░░ 9%' }], narrow: [{ t: '7d 9%' }] }] }
  const deep: Section = { ...short, id: 'turn', detail: [[{ t: 'last 3s' }]] }
  // Eight cells: the two gauges don't fit one line even compact, so the open row wraps.
  const p = plan([short, barred, deep], [], 12, 11 + 8, 11)
  expect(p.rows.map((r) => [r.id, r.canToggle])).toEqual([['usage', false], ['limits', true], ['turn', true]])
})

test('the overflow strip always fits on one line', () => {
  const labels = ['Usage', 'Turn', 'Activity', 'Repo', 'Config', 'Exts.', 'Host', 'Info.']
  expect(stripLabels(labels, 80)).toEqual(labels)
  expect(stripLabels(labels, 40)).toEqual(['Usa', 'Tur', 'Act', 'Rep', 'Con', 'Ext', 'Hos', 'Inf'])
  for (const w of [5, 12, 20, 33]) {
    const out = stripLabels(labels, w)
    expect(2 + out.join(' ').length).toBeLessThanOrEqual(w)
  }
})

test('gauges are whole cells with no gap before the track', () => {
  const text = (p: number) => bar(p, undefined).map((r) => r.t).join('')
  expect(text(0)).toBe('░░░░░░░░░░')
  expect(text(2)).toBe('█░░░░░░░░░')
  expect(text(32)).toBe('███░░░░░░░')
  expect(text(100)).toBe('██████████')
})

test('pace balance: quota in hand is positive, burning ahead negative', () => {
  const window = 5 * 3600e3
  const reset = new Date(window).toISOString() // the window started at 0
  expect(pace(20, reset, window, window / 2)).toBe(30) // half the time gone, a fifth used
  expect(pace(80, reset, window, window / 2)).toBe(-30)
  expect(pace(10, reset, 0, 1000)).toBeNull()
  expect(cells('\u{f06a9}')).toBe(2) // Nerd Font glyphs count as two cells
})

// ── parsers and bookkeeping ──────────────────────────────────────────────────────────────────────

test('git, remote, tag and usage-API parsing', () => {
  const st = parseGitStatus('# branch.oid 0123456789\n# branch.head (detached)\n# branch.ab +1 -3\n1 MM x\n2 R. y\nu UU z\n? a\n? b\n')
  expect(st).toEqual({ branch: '0123456', ahead: 1, behind: 3, staged: 2, modified: 1, untracked: 2, conflicts: 1 })
  expect(parseRemote('git@github.com:me/repo.git')).toEqual({ host: 'github.com', owner: 'me', name: 'repo' })
  expect(parseRemote('https://gitlab.com/group/sub/repo')).toEqual({ host: 'gitlab.com', owner: 'group/sub', name: 'repo' })
  expect(parseRemote('ssh://git@host:2222/o/r.git')).toEqual({ host: 'host', owner: 'o', name: 'r' })
  expect(parseTag('v1.2-rc1-4-gdeadbee')).toEqual({ tag: 'v1.2-rc1', count: 4 })
  const changed = parseChanged('# branch.head main\n1 .M N... 100644 100644 100644 a b src/my file.ts\n2 R. N... 100644 100644 100644 a b R100 new.ts\told.ts\n? x.txt\n', 2)
  expect(changed).toEqual({ files: [{ xy: '.M', path: 'src/my file.ts' }, { xy: 'R.', path: 'new.ts' }], changedTotal: 3 })
  expect(parseLastCommit('abc1234\t1700000000\tFix: a\tb')).toEqual({ sha: 'abc1234', at: 1700000000000, subject: 'Fix: a\tb' })
  const api = parseApiUsage({ limits: [{ kind: 'weekly_scoped', percent: 15, scope: { model: { display_name: 'Fable' } } }, { kind: 'session', percent: 1 }], spend: { enabled: true, used: { amount_minor: 1250, exponent: 2 }, limit: { amount_minor: 5000, exponent: 2 } } }, 7)
  expect(api.scoped).toEqual([{ label: '7dF', percent: 15, resetsAt: undefined }])
  expect(api.credits).toEqual({ used: 12.5, limit: 50, percent: 25 })
})

test('tool calls fold into the activity: todos, tasks, edit lines', () => {
  expect(editLines('a\nb\nc', 'a\nB\nB2\nc')).toEqual({ added: 2, removed: 1 })
  let a = recordTool(emptyActivity(), 'TodoWrite', { todos: [{ status: 'completed', content: 'one' }, { status: 'in_progress', content: 'two' }] })
  expect(a.todos).toEqual({ completed: 1, total: 2, current: 'two' })
  expect(a.running).toBe(1)
  a = recordTool(a, 'TodoWrite', {}, '')
  expect(a.running).toBe(0)
  a = recordTool(a, 'TaskCreate', { subject: 'ship it' })
  a = recordTool(a, 'TaskCreate', { subject: 'ship it' }, 'Task #7 created successfully')
  a = recordTool(a, 'TaskUpdate', { taskId: '7', status: 'completed' }, 'ok')
  expect(a.tasks['7']).toEqual({ subject: 'ship it', status: 'completed' })
  a = recordTool(a, 'Edit', { file_path: '/x/y.ts', old_string: 'a', new_string: 'a\nb' })
  expect([a.linesAdded, a.linesRemoved, a.lastTool?.target]).toEqual([1, 0, 'y.ts'])
  // Agent calls stay out of the tool list (the agent list shows them); MCP names read server:tool.
  a = recordTool(a, 'Agent', { subagent_type: 'Explore', description: 'look around' })
  a = recordTool(a, 'mcp__linear__create_issue', {})
  expect(a.lastTool).toEqual({ name: 'linear:create_issue', target: undefined })
  expect(a.recentTools?.map((t) => t.name)).not.toContain('Agent')
})

test('the open Activity row stacks its tool calls, one per line, repeats folded', () => {
  let a = emptyActivity()
  for (const f of ['a.md', 'b.md', 'b.md', 'c.md']) {
    a = recordTool(a, 'Read', { file_path: `/x/${f}` })
    a = recordTool(a, 'Read', { file_path: `/x/${f}` }, 'ok')
  }
  const x = { activity: a, now: 0 } as never
  const row = buildSections(x, parseConfig({ rows: ['activity'] }), false).find((s) => s.id === 'activity')
  const text = row?.detail?.map((l) => l.map((r) => r.t).join(''))
  expect(text).toEqual(['Read(a.md) ✔︎', 'Read(b.md) ✔︎ ×2', 'Read(c.md) ✔︎'])
})

test('the agent history outlives the engine\'s roster, teammates included', () => {
  const a1 = { id: 'a1', type: 'general-purpose', description: 'Count to 100', status: 'running' }
  const ann = { id: 't1', type: 'teammate', description: 'Review', status: 'running', mate: true, name: 'ann' }
  let ag = mergeAgents(emptyActivity().agents, { members: [a1, ann] })
  expect([ag.running, ag.teammates, ag.list?.length]).toEqual([1, ['ann'], 2])
  ag = mergeAgents(ag, { members: [{ ...a1, status: 'completed' }, { ...ann, status: 'idle' }] })
  // The roster has dropped the agent: still listed, still counted; teammates are who is on the team now.
  ag = mergeAgents(ag, { members: [{ ...ann, status: 'idle' }] })
  expect(ag.list?.map((x) => `${x.id}:${x.status}`)).toEqual(['a1:completed', 't1:idle'])
  expect([ag.running, ag.completed, ag.teammates]).toEqual([0, 1, ['ann']])
  // One that vanished while running is marked ended, and a new one joins after it.
  ag = mergeAgents(ag, { members: [{ id: 'a2', type: 'Explore', description: 'look', status: 'running' }] })
  ag = mergeAgents(ag, { members: [] })
  expect(ag.list?.map((x) => `${x.id}:${x.status}`)).toEqual(['a1:completed', 't1:idle', 'a2:ended'])
  expect([ag.running, ag.completed, ag.teammates]).toEqual([0, 2, []])
})

test('only blocks that run this plugin\'s 1.x scripts count as legacy', () => {
  expect(legacyKeys({ statusLine: { command: 'bun "/home/me/.claude/plugins/data/statusline-dashboard-cc-plugins/statusline.js"' }, subagentStatusLine: { command: 'bun "/src/cc-plugins/plugins/statusline-dashboard/subagent-statusline.js"' } })).toEqual(['statusLine', 'subagentStatusLine'])
  expect(legacyKeys({ statusLine: { command: 'bun ~/my/statusline.js' } })).toEqual([])
  expect(legacyKeys(null)).toEqual([])
})

// ── the mod in a session ─────────────────────────────────────────────────────────────────────────

test('the band draws every row with data, on both surfaces', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /^Model/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Opus 4.7' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '40%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^main/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'v1.2.0' })).toBeDefined()
    // Closed rows: the context breakdown's legend is not drawn yet.
    expect(await ui.find({ type: 'Text', text: 'Messages 30%' })).toBeUndefined()
    await ui.unmount()
  }
})

test('pressing a row label opens it, remembers it, and the Model row shows the context breakdown', async ($, on) => {
  const store: Record<string, unknown> = {}
  const clock = engine(on, {}, store)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'row:model' })
  expect(await ui.find({ type: 'Text', text: 'Messages 30%' })).toBeDefined()
  expect(store.view).toEqual({ isVisible: true, expanded: ['model'] })
  await ui.press({ key: 'row:model' })
  expect(await ui.find({ type: 'Text', text: 'Messages 30%' })).toBeUndefined()
  await ui.unmount()
})

test('/dash hides the band and shows it again; a survey or another mod\'s note wins over it', async ($, on) => {
  // Beneath: another mod's note while one is up (the built-in tips), or a survey.
  let note = false
  const clock = engine(on, {}, {}, ($, e) => {
    if (!note && !e.props.hasSurvey) return undefined
    const { Text } = $.ui.resolve(e)
    return <Text>drawn beneath</Text>
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.settle()

  const hide = await $.command.run(dash(''))
  expect(hide.text).toMatch(/hidden/)
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Opus 4.7' })).toBeUndefined()
  await ui.unmount()

  await $.command.run(dash('show'))
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Opus 4.7' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'drawn beneath' })).toBeUndefined()
  await ui.unmount()

  ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, hasSurvey: true } })
  expect(await ui.find({ type: 'Text', text: 'drawn beneath' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Opus 4.7' })).toBeUndefined()
  await ui.unmount()

  note = true
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'drawn beneath' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Opus 4.7' })).toBeUndefined()
  await ui.unmount()
})

test('truncation never splits an emoji or a Nerd Font glyph into a lone surrogate', () => {
  const cut = toolTarget('Bash', { command: 'echo 🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉' }) ?? ''
  expect(cut.endsWith('…')).toBe(true)
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut)).toBe(false)
})

test('the user config picks the rows and their order', async ($, on) => {
  const clock = engine(on, { '/home/me/.claude/statusline-dashboard.json': JSON.stringify({ rows: ['host', 'model'], hide: ['host.os'] }) })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Host/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Repo/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Linux' })).toBeUndefined()
  await ui.unmount()
})

test('a blank line above the first row, paid from the budget', async ($, on) => {
  expect(parseConfig({}).padTop).toBe(1)
  expect(parseConfig({ padTop: 0 }).padTop).toBe(0)
  expect(parseConfig({ padTop: -2 }).padTop).toBe(1)
  expect(parseConfig({ padTop: 9 }).padTop).toBe(3)

  const clock = engine(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.settle()
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.drawn()).toMatchObject({ type: 'Box', props: { paddingTop: 1 } })
  await ui.unmount()
  // No room to spare: the rows keep every line, the padding goes.
  ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, maxRows: 3 } })
  expect(await ui.drawn()).toMatchObject({ type: 'Box', props: { paddingTop: 0 } })
  expect(await ui.find({ type: 'Text', text: /^Model/ })).toBeDefined()
  await ui.unmount()
})

test('/dash cleanup removes only the 1.x blocks, keeping a backup', async ($, on) => {
  const settings = { theme: 'dark', statusLine: { type: 'command', command: 'bun "/home/me/.claude/plugins/data/statusline-dashboard-cc-plugins/statusline.js"' } }
  const files: Record<string, string> = { '/home/me/.claude/settings.json': JSON.stringify(settings) }
  const clock = engine(on, files)
  on('fs.write', ($, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.settle()

  const res = await $.command.run(dash('cleanup'))
  expect(res.text).toMatch(/Removed statusLine/)
  expect(JSON.parse(files['/home/me/.claude/settings.json'] ?? '{}')).toEqual({ theme: 'dark' })
  expect(JSON.parse(files['/home/me/.claude/settings.json.bak'] ?? '{}')).toEqual(settings)
})
