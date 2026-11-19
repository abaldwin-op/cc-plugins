// The row body: pure (agent in, string out), so the tests check it directly.
//
// [robot|person] name · dim progress · dim model+effort · [status glyph] elapsed · NNK tok

import type { AgentInfo } from 'claude-code'

const esc = '\x1b'
const RESET = `${esc}[0m`
const BOLD = `${esc}[1m`
const GREEN = `${esc}[32m`
const YELLOW = `${esc}[33m`
const RED = `${esc}[31m`
const CYAN = `${esc}[36m`
const SOFT = `${esc}[38;5;245m`
const DIM = `${esc}[38;5;244m`

const cp = (n: number) => String.fromCodePoint(n)
const gAgent = cp(0xf06a9) // nf-md-robot — matches statusline-dashboard's agent glyph
const gMate = cp(0xf0004) // nf-md-account — a teammate (MD, since FA's user glyph is tofu in the Windows font)
const gDone = cp(0x2714) + cp(0xfe0e) // ✔︎ text presentation (never emoji)
const gErr = cp(0x2718) + cp(0xfe0e) // ✘︎
const gRun = cp(0x25cf) // ● running
const gPend = cp(0x25cb) // ○ pending / waiting
const gIdle = cp(0x25cc) // ◌ idle (a teammate waiting for its next message)

/** The fields of the engine's AgentInfo a row reads. */
export type RowAgent = Pick<AgentInfo, 'kind' | 'type' | 'status' | 'description' | 'label' | 'startTime' | 'tokenCount'> &
  Partial<Pick<AgentInfo, 'name' | 'model' | 'effort'>>

export function formatTokens(tokens: number): string {
  const n = Number(tokens) || 0
  if (n >= 1_000_000) {
    const v = n / 1_000_000
    return v >= 10 ? `${Math.round(v)}M` : `${v.toFixed(1)}M`
  }
  if (n >= 1_000) {
    const v = n / 1_000
    return v >= 10 ? `${Math.round(v)}K` : `${v.toFixed(1)}K`
  }
  return String(Math.round(n))
}

function truncate(value: string, maxLen: number): string {
  const s = String(value || '').replace(/\s+/g, ' ').trim()
  return s.length <= maxLen ? s : `${s.slice(0, Math.max(0, maxLen - 3))}...`
}

// Nerd Font PUA glyphs count 2: fonts draw them 1 or 2 wide, and a row that runs one cell past the
// edge gets cut mid-glyph.
const isWide = (c: number) => (c >= 0xe000 && c <= 0xf8ff) || (c >= 0xf0000 && c <= 0xffffd) || (c >= 0x100000 && c <= 0x10fffd)
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
export function vlen(s: string): number {
  let w = 0
  for (const ch of stripAnsi(s)) w += isWide(ch.codePointAt(0)!) ? 2 : 1
  return w
}

/** Cut to `max` cells, keeping SGR sequences so the colors stay balanced, and end in `…`. */
export function truncateVisible(s: string, max: number): string {
  if (max < 2 || vlen(s) <= max) return s
  const limit = max - 1
  let out = ''
  let visible = 0
  let i = 0
  while (i < s.length) {
    const sgr = s[i] === esc ? /^\x1b\[[0-9;]*m/.exec(s.slice(i)) : null
    if (sgr) {
      out += sgr[0]
      i += sgr[0].length
      continue
    }
    const c = s.codePointAt(i)!
    const w = isWide(c) ? 2 : 1
    if (visible + w > limit) break
    const len = c > 0xffff ? 2 : 1
    out += s.slice(i, i + len)
    visible += w
    i += len
  }
  return `${out}…${RESET}`
}

function statusStyle(s: RowAgent['status']): { color: string; glyph: string } {
  switch (s) {
    case 'completed':
      return { color: GREEN, glyph: gDone }
    case 'running':
      return { color: YELLOW, glyph: gRun }
    case 'waiting': // on a permission prompt or a question: needs the person, not just time
      return { color: YELLOW, glyph: gPend }
    case 'failed':
      return { color: RED, glyph: gErr }
    case 'killed':
      return { color: SOFT, glyph: gErr }
    case 'idle':
      return { color: DIM, glyph: gIdle }
    default:
      return { color: DIM, glyph: gPend }
  }
}

/** Elapsed since startTime (epoch ms): "45s", "12m", "1h05m". */
export function elapsed(startTime: number, now: number): string {
  const ms = now - Number(startTime)
  if (!Number.isFinite(ms) || ms < 0 || !Number(startTime)) return ''
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/** "claude-haiku-4-5-20251001" + low → "haiku-4-5 low". */
export function modelEffort(a: Pick<RowAgent, 'model' | 'effort'>): string {
  const model = String(a.model || '').replace(/^claude-/, '').replace(/-\d{8}$/, '')
  return [model, a.effort === undefined ? '' : String(a.effort)].filter(Boolean).join(' ')
}

// Names that aren't identities — let the type or the description carry the row.
const GENERIC = new Set(['internal_agent', 'local_agent', 'agent', ''])

export function renderRow(a: RowAgent, hide: ReadonlySet<string>, now: number, columns?: number): string {
  const on = (id: string) => !hide.has(id)
  const name = (!GENERIC.has(a.name ?? '') && a.name) || (!GENERIC.has(a.type) && a.type) || ''
  const st = statusStyle(a.status)
  // Teammates get a person, sub-agents a robot, so a mixed list reads "who's on the team" vs
  // "who's a helper". The icon stays brand cyan; the status glyph carries the state's color, so
  // the identity doesn't flicker as the status changes.
  const icon = a.kind === 'in_process_teammate' ? gMate : gAgent
  // `label` is the live progress summary (the description until there is one).
  const text = (on('subagent.label') && a.label?.trim()) || a.description
  const sep = ` ${DIM}·${RESET} `
  const parts = name
    ? [`${CYAN}${icon}${RESET} ${BOLD}${name}${RESET}`]
    : [`${CYAN}${icon}${RESET} ${SOFT}${truncate(text, 56)}${RESET}`]
  if (name && text) parts.push(`${SOFT}${truncate(text, 40)}${RESET}`)
  const me = on('subagent.model') ? modelEffort(a) : ''
  if (me) parts.push(`${DIM}${me}${RESET}`)
  const el = on('subagent.elapsed') ? elapsed(a.startTime, now) : ''
  parts.push(`${st.color}${st.glyph}${RESET}${el ? ` ${SOFT}${el}${RESET}` : ''}`)
  const tok = Number(a.tokenCount) || 0
  if (tok > 0 && on('subagent.tokens')) parts.push(`${SOFT}${formatTokens(tok)} tok${RESET}`)
  const row = parts.join(sep)
  // One cell of cushion, as everywhere in this repo: a glyph drawn wider than measured must not
  // push the row past the edge. Without a width the engine cuts at the row's edge itself.
  return columns ? truncateVisible(row, Math.max(2, columns - 1)) : row
}
