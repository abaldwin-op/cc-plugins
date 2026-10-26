// Pure layout: no `$`, no engine. Rows are built as lists of styled RUNS (a string plus how to
// draw it), packed into lines that fit the band's width, then planned against the band's height
// budget. register.tsx turns the planned lines into Text elements; the tests check this file's
// arithmetic directly.

import type { Segment } from '../types'

/** One styled stretch of text. `c`/`bg` are a theme key (`success`, `warning`, …) or a `#rrggbb`. */
export type Run = {
  t: string
  c?: string
  bg?: string
  b?: boolean
  i?: boolean
  /** Drawn dim (the theme's dim colour): labels, punctuation, annotations. */
  d?: boolean
  /** A link target (the PR badge); drawn as a Link where the surface has one. */
  href?: string
}

/** A row item: its widest form and its narrowest (bars and parenthesized detail go in `wide` only). */
export type Item = { wide: Run[]; narrow: Run[] }

export type Section = {
  id: RowId
  label: string
  /** Rendered once before the first item; continuation lines indent past it. */
  lead?: Run[]
  items: Item[]
  /** Keep the wide forms when wrapping instead of first trying all-narrow on one line (Config). */
  preferDetail?: boolean
  /** Extra full-width lines shown only while the row is open (the Model row's context breakdown). */
  detail?: Run[][]
}

export const ROW_IDS = ['model', 'limits', 'usage', 'turn', 'activity', 'repo', 'config', 'exts', 'host', 'info'] as const
export type RowId = (typeof ROW_IDS)[number]

/** Labels pad to this, as the status line's did; the toggle glyph and a space sit before it. */
export const SECTION_WIDTH = 8
export const SEP: Run = { t: ' | ', d: true }

// ── colours ──────────────────────────────────────────────────────────────────────────────────────
// Semantic colours are THEME keys, so they follow the person's Claude Code theme (and read on the
// desktop surface too); decorative per-widget hues keep the status line's 256-colour picks,
// converted to hex because a tree takes no ANSI.

export const GOOD = 'success'
export const WARN = 'warning'
export const BAD = 'error'

/** xterm's 256-colour palette entry as #rrggbb (the 16 system colours map to xterm's defaults). */
export function c256(n: number): string {
  const sys = ['000000', '800000', '008000', '808000', '000080', '800080', '008080', 'c0c0c0', '808080', 'ff0000', '00ff00', 'ffff00', '0000ff', 'ff00ff', '00ffff', 'ffffff']
  if (n < 16) return `#${sys[n]}`
  if (n >= 232) {
    const v = (8 + (n - 232) * 10).toString(16).padStart(2, '0')
    return `#${v}${v}${v}`
  }
  const i = n - 16
  const step = (k: number) => (k === 0 ? 0 : 55 + k * 40).toString(16).padStart(2, '0')
  return `#${step(Math.floor(i / 36))}${step(Math.floor(i / 6) % 6)}${step(i % 6)}`
}

/** Fill colour for quota use: neutral when low → warning ≥70 → error ≥90. */
export function usageColor(p: number): string | undefined {
  return p >= 90 ? BAD : p >= 70 ? WARN : undefined
}

// Context fills differently from rate-limit usage: chat quality starts degrading around 50%, and
// with auto-compact OFF nearing the window limit is a hard wall — so warn EARLIER than usageColor.
export function contextColor(p: number): string | undefined {
  return p >= 80 ? BAD : p >= 50 ? WARN : undefined
}

// ── width ────────────────────────────────────────────────────────────────────────────────────────

// Nerd Font glyphs live in the Private Use Areas. Terminals draw them one OR two cells depending
// on the font, and the layout engine counts them as one: count them as TWO here so a row is
// packed for the worst case and a wide-rendering font can never push it past the edge (a
// hard-wrapped row desyncs the repaint).
const isWide = (cp: number) =>
  (cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xf0000 && cp <= 0xffffd) || (cp >= 0x100000 && cp <= 0x10fffd) || (cp >= 0x1f300 && cp <= 0x1faff)

export function cells(s: string): number {
  let w = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp === 0xfe0e || cp === 0xfe0f || cp === 0x200d) continue
    w += isWide(cp) ? 2 : 1
  }
  return w
}

export const runsWidth = (runs: readonly Run[]) => runs.reduce((n, r) => n + cells(r.t), 0)

/** Cut runs to `max` cells, ending in `…`. */
export function truncateRuns(runs: readonly Run[], max: number): Run[] {
  if (runsWidth(runs) <= max) return [...runs]
  if (max < 1) return []
  const out: Run[] = []
  let left = max - 1
  for (const r of runs) {
    if (left <= 0) break
    let t = ''
    for (const ch of r.t) {
      const w = cells(ch)
      if (w > left) {
        left = 0
        break
      }
      t += ch
      left -= w
    }
    if (t) out.push({ ...r, t })
  }
  out.push({ t: '…', d: true })
  return out
}

// ── packing ──────────────────────────────────────────────────────────────────────────────────────

/** A packed line: its runs, and whether it is the section's first (where the toggle sits). */
export type Line = { runs: Run[]; isHead: boolean }

/**
 * Packs a section's items into lines of at most `width` cells after `indent` cells of toggle and
 * label (drawn by the caller), the status line's packSection carried over:
 *   all-widest on one line → all-narrowest on one line (skipped for preferDetail) → greedy
 *   per-item wrap, cut with `…` once `maxRows` lines are used.
 * A finite `maxRows` is SQUEEZE mode: items go narrow-first and the all-narrow probe runs even
 * for preferDetail sections, because under a row budget a cut item is lost outright while a
 * dropped bar or scope paren is only detail. The first item on an empty line always tries its
 * narrow form, then truncates in place — a line never holds just its label and `…`.
 */
export function packSection(section: Section, width: number, indent: number, maxRows = Infinity): Line[] {
  const items = section.items
  if (!items.length || maxRows < 1) return []
  const lead = section.lead ?? []
  const leadW = runsWidth(lead)
  const room = Math.max(1, width - indent) // cells for content on every line
  const contentRoom = Math.max(1, room - leadW) // past the lead, where continuation lines start
  const squeeze = Number.isFinite(maxRows)

  const join = (forms: Run[][]) => forms.flatMap((f, i) => (i ? [SEP, ...f] : f))
  const fits = (forms: Run[][]) => runsWidth(join(forms)) <= contentRoom
  const wide = items.map((it) => it.wide)
  if (fits(wide)) return [{ runs: [...lead, ...join(wide)], isHead: true }]
  const narrowAll = items.map((it) => it.narrow)
  if ((!section.preferDetail || squeeze) && fits(narrowAll)) return [{ runs: [...lead, ...join(narrowAll)], isHead: true }]

  const lines: Run[][] = []
  let cur: Run[] = []
  let used = 0
  let placed = 0
  for (const it of items) {
    const first = squeeze ? it.narrow : it.wide
    const sepW = placed > 0 ? cells(SEP.t) : 0
    if (used + sepW + runsWidth(first) <= contentRoom) {
      if (placed) cur.push(SEP)
      cur.push(...first)
      used += sepW + runsWidth(first)
    } else if (used + sepW + runsWidth(it.narrow) <= contentRoom) {
      if (placed) cur.push(SEP)
      cur.push(...it.narrow)
      used += sepW + runsWidth(it.narrow)
    } else if (placed === 0) {
      const form = truncateRuns(it.narrow, contentRoom - used)
      cur.push(...form)
      used += runsWidth(form)
    } else {
      // Out of rows: cut instead of wrapping, and say so.
      if (lines.length + 2 > maxRows) {
        if (used + 2 <= contentRoom) cur.push({ t: ' …', d: true })
        break
      }
      if (used + 2 <= contentRoom) cur.push({ t: ' |', d: true })
      lines.push(cur)
      let form = runsWidth(first) <= contentRoom ? first : runsWidth(it.narrow) <= contentRoom ? it.narrow : truncateRuns(it.narrow, contentRoom)
      cur = [...form]
      used = runsWidth(form)
      form = []
    }
    placed++
  }
  lines.push(cur)
  return lines.map((runs, i) => ({ runs: i === 0 ? [...lead, ...runs] : [{ t: ' '.repeat(leadW) }, ...runs], isHead: i === 0 }))
}

// ── planning ─────────────────────────────────────────────────────────────────────────────────────

/** Which section vanishes first when even one line each won't fit: essentials last. */
export const DROP_ORDER: RowId[] = ['exts', 'config', 'host', 'activity', 'turn', 'repo', 'usage', 'info', 'limits', 'model']

export type PlannedRow = {
  id: RowId
  label: string
  /** Open as the person asked, or folded because the band had no room (shown dim). */
  state: 'open' | 'closed' | 'folded'
  /** Opening it shows more than its closed line: only then does it get a ▸/▾ toggle. */
  canToggle: boolean
  lines: Line[]
}

export type Plan = {
  rows: PlannedRow[]
  /** Sections with data that got no line of their own: drawn as one strip of toggles. */
  overflow: Array<{ id: RowId; label: string }>
}

/**
 * Lays the sections out against the band's height budget.
 *
 * Every section with data gets one line, its items packed narrow-first and cut with `…` (closed);
 * an open section gets as many lines as its items need. When even one line per section won't fit,
 * sections leave in DROP_ORDER into a single overflow strip of toggles, so nothing is unreachable
 * and nothing scrolls. Over budget with rows open, the OLDEST open row folds back to one line
 * first (the newest open wins — it is the one just asked for), then other rows move to the strip
 * to make room for it, and only then is it cut short.
 */
export function plan(sections: Section[], expanded: readonly string[], budget: number, width: number, indent: number): Plan {
  const live = sections.filter((s) => s.items.length > 0)
  const closed = (s: Section) => packSection(s, width, indent, 1)
  // An open row: its items wrapped, then its detail lines, all within `max` (detail goes first).
  const open = (s: Section, max = Infinity): Line[] => {
    const lines = packSection(s, width, indent, max)
    const room = Math.max(0, max - lines.length)
    return [...lines, ...(s.detail ?? []).slice(0, room).map((runs) => ({ runs, isHead: false }))]
  }
  budget = Math.max(1, Math.floor(budget))

  // Too many sections for one line each: keep the essentials, the rest go to the strip.
  let shown = live
  let overflow: Section[] = []
  if (live.length > budget) {
    const keep = budget - 1
    const byDrop = [...live].sort((a, b) => DROP_ORDER.indexOf(b.id) - DROP_ORDER.indexOf(a.id)) // essentials first
    const kept = new Set(byDrop.slice(0, keep).map((s) => s.id))
    // An open section always keeps its seat: it is what the person last asked to see.
    const want = expanded.filter((id) => live.some((s) => s.id === id))
    const last = want[want.length - 1]
    if (last && !kept.has(last as RowId) && keep > 0) {
      const victim = byDrop.slice(0, keep).reverse().find((s) => s.id !== last)
      if (victim) kept.delete(victim.id)
      kept.add(last as RowId)
    }
    shown = live.filter((s) => kept.has(s.id))
    overflow = live.filter((s) => !kept.has(s.id))
  }
  const openIds = expanded.filter((id) => shown.some((s) => s.id === id))
  const isOpen = new Set(openIds)
  const newest = openIds[openIds.length - 1]
  const folded = new Set<string>()
  const height = () =>
    shown.reduce((n, s) => n + (isOpen.has(s.id) && !folded.has(s.id) ? open(s).length : closed(s).length), 0) + (overflow.length ? 1 : 0)
  // Fold the oldest open sections until the rest fit, keeping the newest open.
  for (const id of openIds.slice(0, -1)) {
    if (height() <= budget) break
    folded.add(id)
  }
  // Still over: the newest open row is what the person just asked to see, so the least essential
  // of the other rows give up their seats to the strip before it is cut short.
  while (height() > budget && newest !== undefined) {
    const victim = [...shown].filter((s) => s.id !== newest).sort((a, b) => DROP_ORDER.indexOf(a.id) - DROP_ORDER.indexOf(b.id))[0]
    if (!victim) break
    shown = shown.filter((s) => s !== victim)
    overflow = [...overflow, victim].sort((a, b) => live.indexOf(a) - live.indexOf(b))
  }
  // A row whose full form is its one closed line has nothing to open or close.
  const canToggle = (s: Section) => open(s).length > 1 || runsWidth(open(s)[0]?.runs ?? []) !== runsWidth(closed(s)[0]?.runs ?? [])
  const rows: PlannedRow[] = shown.map((s) => {
    const base = { id: s.id, label: s.label, canToggle: canToggle(s) }
    if (!isOpen.has(s.id)) return { ...base, state: 'closed', lines: closed(s) }
    if (folded.has(s.id)) return { ...base, state: 'folded', lines: closed(s) }
    return { ...base, state: 'open', lines: open(s) }
  })
  // Last resort: cut the open row to the rows that are left.
  const total = rows.reduce((n, r) => n + r.lines.length, 0) + (overflow.length ? 1 : 0)
  const r = rows.find((x) => x.id === newest && x.state === 'open')
  const s = shown.find((x) => x.id === newest)
  if (total > budget && r && s) r.lines = open(s, Math.max(1, budget - (total - r.lines.length)))
  return { rows, overflow: overflow.map((s) => ({ id: s.id, label: s.label })) }
}

// ── formatting ───────────────────────────────────────────────────────────────────────────────────

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

export const formatCost = (usd: number) => `$${(Number(usd) || 0).toFixed(2)}`

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m'
  const totalMinutes = Math.floor(ms / 60000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours > 0 && minutes > 0) return `${hours}h${minutes}m`
  if (hours > 0) return `${hours}h`
  return `${minutes}m`
}

export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m'
  const totalMinutes = Math.floor(ms / 60000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d${hours}h`
  if (hours > 0) return `${hours}h${minutes}m`
  return `${minutes}m`
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Local wall-clock time, 24h `HH:mm` or 12h `h:mmam`. */
export function formatClock(ms: number, twelve: boolean): string {
  const d = new Date(ms)
  const h = d.getHours()
  const mm = String(d.getMinutes()).padStart(2, '0')
  return twelve ? `${h % 12 || 12}:${mm}${h < 12 ? 'am' : 'pm'}` : `${String(h).padStart(2, '0')}:${mm}`
}

/**
 * A reset time: `auto` is the time alone, with the weekday when it falls on another calendar day
 * (a 5h window rolling past midnight); `week` always has the weekday; `date` is for periods longer
 * than a week, where a bare weekday is ambiguous (`Sep 30` while it's ≥6 days out).
 */
export function formatReset(iso: string | undefined, fmt: 'auto' | 'week' | 'date', now: number, twelve: boolean): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const hm = formatClock(t, twelve)
  const wd = WEEKDAYS[d.getDay()]
  if (fmt === 'week') return `${wd} ${hm}`
  if (fmt === 'date') return t - now < 6 * 864e5 ? `${wd} ${hm}` : `${MONTHS[d.getMonth()]} ${d.getDate()}`
  const n = new Date(now)
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  return sameDay ? hm : `${wd} ${hm}`
}

/**
 * Signed pace balance vs the even-consumption budget line ((elapsed/window)·100, the window
 * starting `windowMs` before the reset): + = quota in hand, − = burning ahead of it. Null for a
 * degenerate just-reset window or no window length.
 */
export function pace(percentUsed: number, resetsAt: string | undefined, windowMs: number, now: number): number | null {
  if (!resetsAt || !windowMs) return null
  const reset = new Date(resetsAt).getTime()
  if (!Number.isFinite(reset)) return null
  const elapsed = now - (reset - windowMs)
  if (!(elapsed > 0)) return null
  const expected = Math.min(100, (elapsed / windowMs) * 100)
  return Math.round(expected - percentUsed)
}

/**
 * A 10-cell gauge: the used part solid, the rest in the light shade the context bar uses for free
 * space. Whole cells only — an eighth-block partial (▏▎▍…) leaves most of its cell blank, which
 * reads as a gap between the fill and the track — and at least one cell for any use above 0%. No
 * background colour: a painted track drew as a pale box on any terminal background but near-black.
 */
export function bar(pct: number, color: string | undefined, width = 10): Run[] {
  const p = Math.max(0, Math.min(100, pct))
  const full = p > 0 ? Math.max(1, Math.round((p / 100) * width)) : 0
  const runs: Run[] = []
  if (full) runs.push({ t: '█'.repeat(full), c: color ?? c256(250) })
  if (width - full > 0) runs.push({ t: '░'.repeat(width - full), d: true })
  return runs
}

export function truncate(value: string, max: number): string {
  const s = String(value || '').replace(/\s+/g, ' ').trim()
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`
}

/** `~/…` for paths under home, forward slashes. */
export function homeRelative(dir: string, home: string): string {
  if (!dir) return ''
  const d = dir.replace(/\\/g, '/').replace(/\/+$/, '')
  const h = home.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!h) return d
  if (d.toLowerCase() === h.toLowerCase()) return '~'
  if (d.toLowerCase().startsWith(h.toLowerCase() + '/')) return '~/' + d.slice(h.length + 1)
  return d
}

// Middle-ellipsize a path so the LEAF (where you actually are) survives: keep the head (~ or the
// drive) and as many trailing segments as fit. The packer cuts from the right, which would eat it.
export function shortenPath(p: string, max = 40): string {
  if (!p || p.length <= max) return p
  const segs = p.split('/')
  if (segs.length <= 2) {
    const keep = Math.max(1, max - 1)
    return p.slice(0, Math.ceil(keep / 2)) + '…' + p.slice(p.length - Math.floor(keep / 2))
  }
  const first = segs[0]
  let tail = segs.slice(1)
  while (tail.length > 1 && `${first}/…/${tail.join('/')}`.length > max) tail = tail.slice(1)
  return `${first}/…/${tail.join('/')}`
}

// ── the context breakdown (was the context-bar plugin) ───────────────────────────────────────────
// The status line only ever got the window's total; the per-category breakdown is a mods-API call,
// so the Model row's open view adds it: one stacked bar, one colour per category as /context
// draws them, then a legend.


/** The glyph each kind of segment is drawn with: used solid, the compaction buffer hatched, free light. */
export const glyphFor = (kind: Segment['kind']): string => (kind === 'free' ? '░' : kind === 'buffer' ? '▒' : '█')

/**
 * Splits `width` cells across the categories in proportion to their tokens (largest-remainder
 * rounding, so the cells always sum to exactly `width` and no non-empty category rounds to zero
 * while a cell can be found for it). Deferred rows are left out, as /context's grid leaves them.
 */
export function stack(categories: readonly Segment[], width: number): Array<Segment & { cells: number }> {
  const rows = categories.filter((c) => c.kind !== 'deferred' && c.tokens > 0)
  const total = rows.reduce((n, c) => n + c.tokens, 0)
  if (width <= 0 || total <= 0 || rows.length === 0) return []
  const exact = rows.map((c) => (c.tokens / total) * width)
  const cellsOf = exact.map((x) => Math.floor(x))
  let left = width - cellsOf.reduce((n, c) => n + c, 0)
  // Hand the leftover cells to the largest fractional parts first.
  const order = exact.map((x, i) => [x - (cellsOf[i] ?? 0), i] as const).sort((a, b) => b[0] - a[0])
  for (const [, i] of order) {
    if (left <= 0) break
    cellsOf[i] = (cellsOf[i] ?? 0) + 1
    left -= 1
  }
  // A non-empty row that still rounded to nothing borrows one cell from the widest row, so every
  // category present is at least visible.
  for (let i = 0; i < cellsOf.length; i++) {
    if ((cellsOf[i] ?? 0) > 0) continue
    const widest = cellsOf.indexOf(Math.max(...cellsOf))
    if ((cellsOf[widest] ?? 0) > 1) {
      cellsOf[widest] = (cellsOf[widest] ?? 0) - 1
      cellsOf[i] = 1
    }
  }
  return rows.map((c, i) => ({ ...c, cells: cellsOf[i] ?? 0 }))
}

/** The stacked bar as runs, exactly `width` cells. */
export function stackRuns(categories: readonly Segment[], width: number): Run[] {
  return stack(categories, width).map((seg) => ({ t: glyphFor(seg.kind).repeat(seg.cells), c: seg.color }))
}

/** Legend lines (`name NN%` in each category's colour), wrapped at `width`, at most `maxLines`. */
export function legendLines(categories: readonly Segment[], maxTokens: number, width: number, maxLines = 2): Run[][] {
  const entries = categories
    .filter((c) => c.kind !== 'deferred' && c.tokens > 0)
    .map((c) => ({ t: `${c.name} ${Math.max(1, Math.round((c.tokens / Math.max(1, maxTokens)) * 100))}%`, c: c.color }))
    .filter((e) => cells(e.t) <= width)
  const lines: Run[][] = []
  let cur: Run[] = []
  let used = 0
  for (const e of entries) {
    const gap = cur.length ? 2 : 0
    if (used + gap + cells(e.t) > width) {
      lines.push(cur)
      if (lines.length >= maxLines) return lines
      cur = []
      used = 0
    }
    if (cur.length) cur.push({ t: '  ' })
    cur.push(e)
    used += (cur.length > 1 ? 2 : 0) + cells(e.t)
  }
  if (cur.length) lines.push(cur)
  return lines.slice(0, maxLines)
}

/**
 * The overflow strip's labels, fitted to `width` after its `+ ` lead: whole labels when they fit,
 * else each cut to its first three letters (`Usa Tur Act`), else as many of those as fit — the
 * strip is one line, like every other, and must never hard-wrap.
 */
export function stripLabels(labels: readonly string[], width: number): string[] {
  const fits = (ls: readonly string[]) => 2 + ls.reduce((n, l, i) => n + cells(l) + (i ? 1 : 0), 0) <= width
  if (fits(labels)) return [...labels]
  const short = labels.map((l) => l.replace(/\.$/, '').slice(0, 3))
  const out: string[] = []
  for (const l of short) {
    if (!fits([...out, l])) break
    out.push(l)
  }
  return out
}
