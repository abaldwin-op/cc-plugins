import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { renderRow, vlen } from '../hooks/row'

const NOW = 3600e3
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

const explore = {
  id: 'a',
  kind: 'local_agent',
  type: 'Explore',
  status: 'running',
  taskStatus: 'running',
  description: 'Survey the repo',
  label: 'Reading every file in the repository',
  startTime: NOW - 75e3,
  cwd: '/work',
  model: 'claude-haiku-4-5-20251001',
  effort: 'low',
  tokenCount: 12345,
  tokenSamples: [12345],
  hasRow: true,
} as const

const reviewer = {
  ...explore,
  id: 'b',
  kind: 'in_process_teammate',
  type: 'teammate',
  name: 'reviewer',
  teammateId: 'reviewer@team',
  status: 'idle',
  label: '',
  description: 'Review the diff',
  model: undefined,
  effort: undefined,
  tokenCount: 0,
} as const

/** The engine beneath: a clock, a home and its files; it records the row props it is handed. */
function engine(on: On, files: Record<string, string>, seen: { props?: any }) {
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/me' })
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('ui.render', ($, e) => {
    seen.props = e.props
    return { type: 'engine', ref: 0 } as never
  })
  on('fs.read', ($, e) => (files[e.path] === undefined ? { deny: 'ENOENT' } : { value: files[e.path]! }))
}

test('a sub-agent row: type, progress, model and effort, status, elapsed, tokens', () => {
  expect(plain(renderRow(explore, new Set(), NOW))).toBe(
    '\u{f06a9} Explore · Reading every file in the repository · haiku-4-5 low · ● 1m · 12K tok',
  )
})

test('a teammate row: person icon, name, description, idle glyph', () => {
  expect(plain(renderRow(reviewer, new Set(), NOW))).toBe('\u{f0004} reviewer · Review the diff · ◌ 1m')
})

test('hide ids drop their parts', () => {
  const row = plain(renderRow(explore, new Set(['subagent.label', 'subagent.model', 'subagent.elapsed', 'subagent.tokens']), NOW))
  expect(row).toBe('\u{f06a9} Explore · Survey the repo · ●')
})

test('a row never reaches the last column, whatever the width', () => {
  for (let cols = 3; cols <= 120; cols++) {
    expect(vlen(renderRow(explore, new Set(), NOW, cols)) <= cols - 1).toBe(true)
  }
})

test('the terminal row carries the body; other surfaces keep the engine\'s', async ($, on) => {
  const seen: { props?: any } = {}
  engine(on, { '/home/me/.claude/statusline-dashboard.json': '{"hide":["SUBAGENT.TOKENS"]}' }, seen)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const props = { ...explore, rowIds: ['a'], columns: 120, isHidden: false }

  const term = await $.ui.mount({ plugin: 'agent-panel', component: 'AgentRow', requestId: 'a', surface: 'terminal', props } as never)
  expect(plain(seen.props.body)).toBe('\u{f06a9} Explore · Reading every file in the repository · haiku-4-5 low · ● 1m')
  await term.unmount()

  seen.props = undefined
  const desk = await $.ui.mount({ plugin: 'agent-panel', component: 'AgentRow', requestId: 'a', surface: 'desktop', props } as never)
  expect(seen.props.body).toBeUndefined()
  await desk.unmount()
})
