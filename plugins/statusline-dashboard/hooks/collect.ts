// Collectors: everything that reads the engine, the filesystem, git or the network. Each returns
// plain data for $.state; none draws. Top-level function declarations taking `$`, because the
// validator follows `$` only into those.
//
// Where the engine knows the answer live (the context breakdown's memory files, agents, skills and
// MCP tools; settings by source; the agent roster) it is asked rather than the files re-parsed —
// that is what the status line had to guess from disk. Disk is read only for what the engine does
// not expose (directory-based config the context doesn't list, plugin component counts, trust).
// Every collector swallows its own failures and returns what it has: a missing file or a dead
// subprocess costs one widget, never the band.

import type { EngineInterface } from 'claude-code'

import type { ApiUsage, Breakdown, Counts, Host, Info, Repo, Scopes, Segment, Usage } from '../types'

type $ = EngineInterface

// ── small I/O helpers ────────────────────────────────────────────────────────────────────────────

const join = (...parts: string[]) => parts.filter(Boolean).join('/').replace(/\\/g, '/').replace(/\/{2,}/g, '/')
const dirname = (p: string) => p.replace(/\\/g, '/').replace(/\/[^/]*$/, '') || '/'
const basename = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? p
const norm = (s: string) => String(s || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

export async function homeDir($: $): Promise<string> {
  return ((await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || '').replace(/\\/g, '/')
}

export async function readText($: $, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch {
    return null // missing, unreadable, or over the 4 MiB read limit
  }
}

export async function readJson($: $, path: string): Promise<Record<string, any> | null> {
  const text = await readText($, path)
  if (text === null) return null
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

async function list($: $, dir: string) {
  try {
    return await $.fs.list(dir)
  } catch {
    return []
  }
}

async function countFiles($: $, dir: string, pattern?: RegExp): Promise<number> {
  return (await list($, dir)).filter((e) => !pattern || pattern.test(e.name)).length
}

// *.md counted down nested subdirs: agents and rules load that way, subdirs being organizational.
async function countMdRecursive($: $, dir: string, depth = 0): Promise<number> {
  if (depth > 6) return 0
  let n = 0
  for (const e of await list($, dir)) {
    if (e.kind === 'dir') n += await countMdRecursive($, join(dir, e.name), depth + 1)
    else if (/\.md$/i.test(e.name)) n++
  }
  return n
}

async function run($: $, argv: string[], cwd?: string, timeoutMs = 5000): Promise<string | null> {
  try {
    const r = await $.process.run(argv, { cwd, timeoutMs })
    return r.exitCode === 0 ? r.stdout : null
  } catch {
    return null // not installed, or timed out
  }
}

export async function platform($: $): Promise<'windows' | 'macos' | 'linux'> {
  if ((await $.env.get('OS')) === 'Windows_NT') return 'windows'
  const uname = (await run($, ['uname', '-s'])) ?? ''
  return /darwin/i.test(uname) ? 'macos' : 'linux'
}

// ── usage and the context breakdown ──────────────────────────────────────────────────────────────

export async function collectUsage($: $): Promise<Usage | null> {
  try {
    const u = await $.session.usage()
    return {
      startedAt: u.startedAt,
      ctxTokens: u.context.tokens,
      ctxWindow: u.context.window,
      ctxPercent: u.context.percent,
      limits: u.rateLimits.map((l) => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
      costUsd: u.cost?.usd,
    }
  } catch {
    return null // no session bound yet
  }
}

// The engine's word for where an agent/skill was defined → the scope slot it counts in.
const SOURCE_SCOPE: Record<string, keyof Scopes> = {
  policySettings: 'm',
  userSettings: 'u',
  projectSettings: 'p',
  localSettings: 'l',
  plugin: 'x',
}
// /context's memory-file labels → scope slots. AutoMem is the auto-memory index, counted apart.
const MEMORY_SCOPE: Record<string, keyof Scopes> = { Managed: 'm', User: 'u', Project: 'p', Local: 'l' }

function tally<T>(rows: readonly T[], scopeOf: (r: T) => keyof Scopes | undefined): Scopes {
  const s: Scopes = {}
  for (const r of rows) {
    const k = scopeOf(r)
    if (k) s[k] = (s[k] ?? 0) + 1
  }
  return s
}

// 'summary' estimates locally and sends no token-count requests.
export async function collectBreakdown($: $): Promise<Breakdown | null> {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const b = usage.context.breakdown
    if (!b) return null
    const api = b.apiUsage
    const autoMem = b.memoryFiles.find((f) => f.type === 'AutoMem')
    return {
      categories: b.categories.map((c): Segment => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind as Segment['kind'] })),
      totalTokens: b.totalTokens,
      maxTokens: b.rawMaxTokens,
      percentage: b.percentage,
      lastCall: api ? { input: api.input_tokens, output: api.output_tokens, cacheWrite: api.cache_creation_input_tokens, cacheRead: api.cache_read_input_tokens } : null,
      // Rules files load as instruction files too, but have their own widget: keep them out here.
      instructions: tally(
        b.memoryFiles.filter((f) => !/\/\.claude\/rules\//.test(f.path.replace(/\\/g, '/'))),
        (f) => MEMORY_SCOPE[f.type],
      ),
      memoryDir: autoMem ? dirname(autoMem.path) : undefined,
      agents: tally(b.agents, (a) => SOURCE_SCOPE[a.source]),
      skills: tally(b.skills?.skillFrontmatter ?? [], (s) => SOURCE_SCOPE[String(s.source)]),
      mcpServers: [...new Set(b.mcpTools.map((t) => t.serverName))],
    }
  } catch {
    return null
  }
}

// ── git ──────────────────────────────────────────────────────────────────────────────────────────

export function parseGitStatus(out: string) {
  let branch = ''
  let oid = ''
  let ahead = 0
  let behind = 0
  let staged = 0
  let modified = 0
  let untracked = 0
  let conflicts = 0
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) branch = line.slice(14).trim()
    else if (line.startsWith('# branch.oid ')) oid = line.slice(13).trim()
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+)\s+-(\d+)/)
      if (m) {
        ahead = Number(m[1]) || 0
        behind = Number(m[2]) || 0
      }
    } else if (line[0] === '1' || line[0] === '2') {
      const xy = line.split(' ')[1] ?? '..'
      if (xy[0] !== '.') staged++
      if (xy[1] !== '.') modified++
    } else if (line[0] === 'u') conflicts++
    else if (line[0] === '?') untracked++
  }
  if (!branch || branch === '(detached)') branch = oid && oid !== '(initial)' ? oid.slice(0, 7) : 'detached'
  return { branch, ahead, behind, staged, modified, untracked, conflicts }
}

/** The changed paths in porcelain v2 output, first few kept: `M.` staged, `.M` modified, `??` untracked, `UU` conflict. */
export function parseChanged(out: string, keep = 5): { files: Array<{ xy: string; path: string }>; changedTotal: number } {
  const files: Array<{ xy: string; path: string }> = []
  for (const line of out.split('\n')) {
    const f = line.split(' ')
    if (line[0] === '1' && f.length >= 9) files.push({ xy: f[1] ?? '..', path: f.slice(8).join(' ') })
    else if (line[0] === '2' && f.length >= 10) files.push({ xy: f[1] ?? '..', path: f.slice(9).join(' ').split('\t')[0] ?? '' })
    else if (line[0] === 'u' && f.length >= 11) files.push({ xy: f[1] ?? 'UU', path: f.slice(10).join(' ') })
    else if (line.startsWith('? ')) files.push({ xy: '??', path: line.slice(2) })
  }
  return { files: files.slice(0, keep), changedTotal: files.length }
}

export function parseLastCommit(out: string | null) {
  const [sha, ct, ...subject] = String(out ?? '').trim().split('\t')
  return sha && ct ? { sha, at: Number(ct) * 1000, subject: subject.join('\t') } : undefined
}

// `--long` always emits "<tag>-<count>-g<sha>", even on the tag; tag names may contain dashes
// (v1.2-rc1), so anchor the split on the trailing "-<N>-g<hex>".
export function parseTag(out: string | null) {
  const m = String(out ?? '').trim().match(/^(.+)-(\d+)-g[0-9a-f]+$/)
  return m ? { tag: m[1] ?? '', count: Number(m[2]) || 0 } : undefined
}

/** `git@host:owner/name.git`, `https://host/owner/name`, `ssh://git@host:22/owner/name.git` → parts. */
export function parseRemote(url: string | null) {
  const s = String(url ?? '').trim()
  const m = s.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i)
  if (!m) return undefined
  const path = (m[2] ?? '').split('/').filter(Boolean)
  if (path.length < 2) return undefined
  return { host: m[1] ?? '', owner: path.slice(0, -1).join('/'), name: path[path.length - 1] ?? '' }
}

const PR_TTL_MS = 5 * 60e3

/**
 * The Repo row: one concurrent batch of git subprocesses (status / toplevel+common dir / describe
 * / origin), and — at most every five minutes per branch, when enabled — `gh pr view` for the
 * branch's open PR. Null outside a repository.
 */
export async function collectRepo($: $, cwd: string, prev: Repo | null, withPr: boolean, now: number): Promise<Repo | null> {
  const git = (...args: string[]) => run($, ['git', '--no-optional-locks', ...args], cwd)
  const [st, rp, desc, origin, log] = await Promise.all([
    git('status', '--porcelain=v2', '--branch'),
    git('rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'),
    git('describe', '--tags', '--long', '--match', 'v*', 'HEAD'),
    git('remote', 'get-url', 'origin'),
    git('log', '-1', '--format=%h%x09%ct%x09%s'),
  ])
  if (st === null) return null
  const s = parseGitStatus(st)
  const [top = cwd, common = ''] = (rp ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
  // The common git dir's parent is the MAIN repo root, so a linked worktree shows its parent
  // repository's name as the headline and its own name as the worktree widget.
  const stripped = common.replace(/[\\/]\.git[\\/]*$/i, '')
  const main = stripped && stripped !== common ? stripped : top
  const isWorktree = norm(main) !== norm(top)
  const repo: Repo = {
    name: basename(main),
    ...s,
    worktree: isWorktree ? basename(top) : undefined,
    remote: parseRemote(origin),
    tag: parseTag(desc),
    ...parseChanged(st),
    lastCommit: parseLastCommit(log),
  }
  if (withPr && repo.remote?.host.includes('github')) {
    const fresh = prev?.prBranch === s.branch && prev.prCheckedAt !== undefined && now - prev.prCheckedAt < PR_TTL_MS
    if (fresh) {
      repo.pr = prev?.pr
      repo.prCheckedAt = prev?.prCheckedAt
    } else {
      repo.pr = await prView($, cwd)
      repo.prCheckedAt = now
    }
    repo.prBranch = s.branch
  }
  return repo
}

// The branch's open PR, colored by review state. `gh` missing, signed out, or no PR → undefined.
async function prView($: $, cwd: string): Promise<Repo['pr']> {
  const out = await run($, ['gh', 'pr', 'view', '--json', 'number,url,state,isDraft,reviewDecision'], cwd, 8000)
  if (!out) return undefined
  try {
    const p = JSON.parse(out)
    if (p.state !== 'OPEN' || typeof p.number !== 'number') return undefined
    const rd = String(p.reviewDecision ?? '')
    const state = p.isDraft ? 'draft' : rd === 'APPROVED' ? 'approved' : rd === 'CHANGES_REQUESTED' ? 'changes' : rd === 'REVIEW_REQUIRED' ? 'pending' : 'open'
    return { number: p.number, url: String(p.url ?? ''), state }
  } catch {
    return undefined
  }
}

// ── host ─────────────────────────────────────────────────────────────────────────────────────────

async function osLabel($: $, kind: Host['os']['kind']): Promise<string> {
  if (kind === 'windows') {
    // "Microsoft Windows [Version 10.0.26200.1234]": 11 from build 22000.
    const ver = (await run($, ['cmd', '/d', '/c', 'ver'])) ?? ''
    const build = Number(ver.match(/\d+\.\d+\.(\d+)/)?.[1]) || 0
    return build ? `Win ${build >= 22000 ? '11' : '10'} (${build})` : 'Windows'
  }
  if (kind === 'macos') {
    const plist = (await readText($, '/System/Library/CoreServices/SystemVersion.plist')) ?? ''
    const ver = plist.match(/<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/)?.[1]?.trim()
    return ver ? `macOS ${ver}` : 'macOS'
  }
  // Short "Name Version" from /etc/os-release: Debian 12, Ubuntu 22.04, …
  const txt = (await readText($, '/etc/os-release')) ?? ''
  const field = (k: string) => txt.match(new RegExp(`^${k}="?([^"\\n]+)`, 'm'))?.[1]
  const id = field('ID')
  if (!id) return field('PRETTY_NAME') ?? 'Linux'
  const name = id.charAt(0).toUpperCase() + id.slice(1)
  const ver = field('VERSION_ID')
  return ver ? `${name} ${ver}` : name
}

/**
 * Other live Claude Code sessions on this machine. Claude Code registers each running process in
 * ~/.claude/sessions/<pid>.json ({pid, sessionId, name, …}); a crashed process can leave its file
 * behind, so a pid only counts once one `ps`/`tasklist` call shows it alive.
 */
async function fleet($: $, home: string, kind: Host['os']['kind'], sessionId: string): Promise<string[]> {
  const dir = join(home, '.claude', 'sessions')
  const entries: Array<{ pid: number; name: string }> = []
  for (const e of await list($, dir)) {
    if (!e.name.endsWith('.json')) continue
    const s = await readJson($, join(dir, e.name))
    if (!s?.pid || !s.sessionId || s.sessionId === sessionId) continue
    entries.push({ pid: Number(s.pid), name: String(s.name || s.pid) })
  }
  if (!entries.length) return []
  const alive = new Set<number>()
  if (kind === 'windows') {
    for (const line of ((await run($, ['tasklist', '/FO', 'CSV', '/NH'])) ?? '').split('\n')) {
      const pid = Number(line.split('","')[1])
      if (pid) alive.add(pid)
    }
  } else {
    const out = (await run($, ['ps', '-o', 'pid=', '-p', entries.map((e) => e.pid).join(',')])) ?? ''
    for (const t of out.split(/\s+/)) if (Number(t)) alive.add(Number(t))
  }
  return entries.filter((e) => alive.has(e.pid)).map((e) => e.name)
}

export async function collectHost($: $, home: string, sessionId: string): Promise<Host> {
  const kind = await platform($)
  const user = (await $.env.get('USER')) || (await $.env.get('USERNAME')) || ''
  let host = (await $.env.get('HOSTNAME')) || (await $.env.get('COMPUTERNAME')) || ''
  if (!host) host = ((await run($, ['hostname'])) ?? '').trim()
  return {
    os: { kind, label: await osLabel($, kind) },
    user,
    host: host.split('.')[0] ?? host, // drop .local / the domain
    fleet: await fleet($, home, kind, sessionId),
  }
}

export async function collectInfo($: $, home: string): Promise<Info> {
  const settings = await $.settings.read().catch(() => ({}) as Record<string, unknown>)
  return {
    cwd: await $.session.cwd(),
    home,
    version: (await $.session.version()).version,
    sessionId: await $.session.id(),
    outputStyle: typeof settings.outputStyle === 'string' ? settings.outputStyle : undefined,
    agent: typeof settings.agent === 'string' ? settings.agent : undefined,
  }
}

// ── the OAuth usage API ──────────────────────────────────────────────────────────────────────────
// Model-scoped weekly caps and usage-credit spend are not in the session's rate limits; only the
// OAuth usage endpoint has them. The session's credential stays in the engine: `authorize` hands
// back an opaque handle and the engine sets the header on a first-party https request.

export async function collectApi($: $, now: number): Promise<ApiUsage | null> {
  try {
    const auth = await $.session.authorize()
    if (!auth || auth.kind !== 'bearer') return null // an API key or a gateway has no subscription usage
    const res = await $.http.fetch('https://api.anthropic.com/api/oauth/usage', {
      auth: auth.handle,
      headers: { Accept: 'application/json', 'anthropic-beta': 'oauth-2025-04-20' },
    })
    if (!res.ok) return null
    return parseApiUsage(JSON.parse(res.text), now)
  } catch {
    return null
  }
}

export function parseApiUsage(u: any, now: number): ApiUsage {
  const scoped: ApiUsage['scoped'] = []
  // The modern `limits` array: `weekly_scoped` entries are per-model caps, each on its own 0-100%
  // scale; `session` / `weekly_all` duplicate the 5h / 7d windows the session already reports.
  // Labelled 7d + the model's initial (Fable → 7dF).
  for (const l of Array.isArray(u?.limits) ? u.limits : []) {
    if (l?.kind !== 'weekly_scoped') continue
    const name = String(l.scope?.model?.display_name || l.scope?.surface || '').trim()
    const pct = Number(l.percent)
    if (Number.isFinite(pct)) scoped.push({ label: `7d${(name.charAt(0) || '?').toUpperCase()}`, percent: pct, resetsAt: l.resets_at })
  }
  // Credits in minor currency units (amount_minor 5000, exponent 2 = $50.00); shown only once
  // something has actually been spent this month.
  let credits: ApiUsage['credits']
  const sp = u?.spend
  const minor = (m: any) => (Number(m?.amount_minor) || 0) / 10 ** (Number.isFinite(Number(m?.exponent)) ? Number(m.exponent) : 2)
  if (sp?.enabled && Number(sp.used?.amount_minor) > 0) {
    const used = minor(sp.used)
    const limit = minor(sp.limit)
    credits = { used, limit, percent: Math.round(Number(sp.percent) || (limit > 0 ? (used / limit) * 100 : 0)) }
  }
  return { at: now, scoped, credits }
}

// ── agents ───────────────────────────────────────────────────────────────────────────────────────

/** The agent roster as the engine has it now: sub-agents in start order, and teammate names. */
export async function collectAgents($: $): Promise<{ subs: Array<{ id: string; type: string; description: string; status: string }>; teammates: string[] } | null> {
  try {
    const all = await $.agent.list()
    return {
      subs: all.filter((a) => !a.teammateId).map((a) => ({ id: a.id, type: a.type, description: a.description, status: a.status })),
      teammates: all.filter((a) => a.teammateId).map((a) => a.name ?? a.teammateId?.split('@')[0] ?? '?'),
    }
  } catch {
    return null
  }
}

// ── config counts ────────────────────────────────────────────────────────────────────────────────
// Scopes, broad → narrow: m = managed (policy), u = user (~/.claude), p = project (committed in the
// repo), l = local (uncommitted per-project overrides), x = plugin (bundled by enabled plugins).
// Instruction files, agents and skills come from the engine's context breakdown (exactly what is
// loaded, trust and precedence applied); the rest is counted from disk and gated on workspace
// trust the way Claude Code gates loading: an untrusted workspace loads no EXECUTABLE project or
// local config (hooks, MCP, commands, workflows, routines, project-enabled plugins), while content
// (rules) still loads.

function managedDir(kind: Host['os']['kind']): string {
  if (kind === 'windows') return 'C:/Program Files/ClaudeCode'
  if (kind === 'macos') return '/Library/Application Support/ClaudeCode'
  return '/etc/claude-code'
}

function countHookMap(hooks: unknown): number {
  if (!hooks || typeof hooks !== 'object') return 0
  let n = 0
  for (const groups of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue
    for (const g of groups) n += Array.isArray(g?.hooks) ? g.hooks.length : 1
  }
  return n
}

const enabledNames = (ep: unknown) =>
  ep && typeof ep === 'object' ? Object.entries(ep as Record<string, unknown>).filter(([, v]) => v === true).map(([k]) => k) : []

async function settingsOf($: $, source: 'user' | 'project' | 'local' | 'policy'): Promise<Record<string, any>> {
  try {
    return (await $.settings.read({ source })) as Record<string, any>
  } catch {
    return {}
  }
}

/**
 * Components the ENABLED plugins bundle (the x scope), de-duped by base name so a plugin enabled
 * from two marketplaces counts once. Component declarations can also live INLINE in a plugin's
 * marketplace entry (the official LSP plugins ship a stub folder and declare `lspServers` there),
 * so each plugin's manifest is merged over its marketplace entry.
 */
async function pluginComponents($: $, home: string, keys: string[], mcpOff: Set<string>) {
  const out = { agents: 0, commands: 0, skills: 0, hooks: 0, mcps: 0, workflows: 0, lsp: 0, monitors: 0, themes: 0, bin: 0, channelNames: new Set<string>() }
  const installed = await readJson($, join(home, '.claude', 'plugins', 'installed_plugins.json'))
  const marketplaces = new Map<string, any[]>()
  const seen = new Set<string>()
  for (const key of keys) {
    const [base = key, mp = ''] = key.split('@')
    if (seen.has(base)) continue
    const recs: any[] = Array.isArray(installed?.plugins?.[key]) ? installed.plugins[key] : []
    const root: string | undefined = recs[recs.length - 1]?.installPath
    if (!root) continue
    seen.add(base)
    if (mp && !marketplaces.has(mp)) {
      const j = await readJson($, join(home, '.claude', 'plugins', 'marketplaces', mp, '.claude-plugin', 'marketplace.json'))
      marketplaces.set(mp, Array.isArray(j?.plugins) ? j.plugins : [])
    }
    const entry = (marketplaces.get(mp) ?? []).find((p) => p?.name === base) ?? {}
    const eff = { ...entry, ...((await readJson($, join(root, '.claude-plugin', 'plugin.json'))) ?? {}) }
    out.agents += await countMdRecursive($, join(root, 'agents'))
    out.commands += await countMdRecursive($, join(root, 'commands'))
    out.skills += await countFiles($, join(root, 'skills'))
    out.hooks += countHookMap((await readJson($, join(root, 'hooks', 'hooks.json')))?.hooks) + countHookMap(eff.hooks)
    // A plugin .mcp.json declares servers at the TOP LEVEL, not under `mcpServers` like a
    // project's; accept either. Servers toggled off in /mcp read "plugin:<base>:<server>".
    const mcpFile = (await readJson($, join(root, '.mcp.json'))) ?? {}
    const servers = { ...(mcpFile.mcpServers && typeof mcpFile.mcpServers === 'object' ? mcpFile.mcpServers : mcpFile), ...(eff.mcpServers ?? {}) }
    for (const srv of Object.keys(servers)) if (!mcpOff.has(`plugin:${base}:${srv}`)) out.mcps++
    // .lsp.json is a top-level language → config map; inline form is eff.lspServers.
    const lsp = (await readJson($, join(root, '.lsp.json'))) ?? {}
    const lspInline = eff.lspServers && typeof eff.lspServers === 'object' && !Array.isArray(eff.lspServers) ? eff.lspServers : {}
    out.lsp += new Set([...Object.keys(lsp), ...Object.keys(lspInline)]).size
    // Monitors: monitors/monitors.json is an array; an inline array replaces it (a path string is
    // the path form, left uncounted).
    const mon = eff.experimental?.monitors ?? eff.monitors
    if (Array.isArray(mon)) out.monitors += mon.length
    else if (typeof mon !== 'string') {
      const file = await readText($, join(root, 'monitors', 'monitors.json'))
      try {
        const arr = file ? JSON.parse(file) : null
        if (Array.isArray(arr)) out.monitors += arr.length
      } catch {}
    }
    const themes = eff.experimental?.themes ?? eff.themes
    if (Array.isArray(themes)) out.themes += themes.length
    else if (typeof themes !== 'string') out.themes += await countFiles($, join(root, 'themes'), /\.json$/i)
    out.workflows += await countFiles($, join(root, 'workflows'))
    out.bin += await countFiles($, join(root, 'bin'))
    if (Array.isArray(eff.channels)) for (const ch of eff.channels) {
      const name = typeof ch === 'string' ? ch : ch?.name || ch?.id
      if (name) out.channelNames.add(String(name))
    }
  }
  return out
}

export async function collectCounts($: $, home: string, kind: Host['os']['kind'], root: string, b: Breakdown | null, sessionMcp: string[]): Promise<Counts> {
  // Launched in the home directory itself, the "project" .claude/ IS the user scope: treat it as
  // no project, or user config would count twice.
  const proj = norm(root) === norm(home) ? '' : root
  // ~/.claude.json can outgrow the 4 MiB read limit on a long-lived install; then trust and the
  // per-project MCP state are unknown and the project is taken as trusted (what Claude Code would
  // have asked about already).
  const cj = await readJson($, join(home, '.claude.json'))
  const projects: Record<string, any> = cj?.projects ?? {}
  const entry = Object.entries(projects).find(([k]) => norm(k) === norm(root))?.[1]
  const trusted = !proj || !cj || entry?.hasTrustDialogAccepted === true
  const arr = (v: unknown) => (Array.isArray(v) ? (v as string[]) : [])
  const mcpOff = new Set([...arr(entry?.disabledMcpServers), ...Object.keys((await readJson($, join(home, '.claude', 'mcp-needs-auth-cache.json'))) ?? {})])

  const [policy, user, project, local] = await Promise.all([settingsOf($, 'policy'), settingsOf($, 'user'), settingsOf($, 'project'), settingsOf($, 'local')])

  // Plugins enabled per scope, counted once at the broadest scope enabling them; project and local
  // enablement only takes effect in a trusted workspace.
  const pm = new Set(enabledNames(policy.enabledPlugins).map((k) => k.split('@')[0]))
  const pu = new Set(enabledNames(user.enabledPlugins).map((k) => k.split('@')[0]).filter((n) => !pm.has(n)))
  const pp = new Set(trusted ? enabledNames(project.enabledPlugins).map((k) => k.split('@')[0]).filter((n) => !pm.has(n) && !pu.has(n)) : [])
  const pl = new Set(trusted ? enabledNames(local.enabledPlugins).map((k) => k.split('@')[0]).filter((n) => !pm.has(n) && !pu.has(n) && !pp.has(n)) : [])
  // The effective enabled keys: user < project < local, later layers overriding.
  const merged: Record<string, unknown> = { ...(user.enabledPlugins ?? {}), ...(trusted ? project.enabledPlugins ?? {} : {}), ...(trusted ? local.enabledPlugins ?? {} : {}), ...(policy.enabledPlugins ?? {}) }
  const plug = await pluginComponents($, home, enabledNames(merged), mcpOff)

  // MCP servers, de-duped by precedence local > project > user: u = ~/.claude.json top level,
  // p = the repo's .mcp.json once approved, l = ~/.claude.json projects[root], m = managed.
  const on = (k: string) => !mcpOff.has(k)
  const mu = new Set(Object.keys(cj?.mcpServers ?? {}).filter(on))
  const ml = new Set(Object.keys(entry?.mcpServers ?? {}).filter(on))
  const mp = new Set<string>()
  if (proj && trusted) {
    const pj = (await readJson($, join(proj, '.mcp.json')))?.mcpServers ?? {}
    const approved = new Set(arr(entry?.enabledMcpjsonServers))
    const rejected = new Set(arr(entry?.disabledMcpjsonServers))
    for (const k of Object.keys(pj)) if ((entry?.enableAllProjectMcpServers === true || approved.has(k)) && !rejected.has(k) && on(k)) mp.add(k)
  }
  for (const k of ml) (mp.delete(k), mu.delete(k))
  for (const k of mp) mu.delete(k)
  const managedMcp = { ...((await readJson($, join(managedDir(kind), 'managed-mcp.json')))?.mcpServers ?? {}), ...(policy.mcpServers ?? {}) }

  const dirCount = async (sub: string, recursive: boolean, pattern?: RegExp): Promise<Scopes> => {
    const count = (d: string) => (recursive ? countMdRecursive($, d) : countFiles($, d, pattern))
    return { u: await count(join(home, '.claude', sub)), p: proj ? await count(join(proj, '.claude', sub)) : 0 }
  }
  const gate = (s: Scopes): Scopes => (trusted ? s : { ...s, p: 0, l: 0 })

  // Auto-memory: the memory files beside the loaded index (MEMORY.md is the index, not a memory).
  const memDir = b?.memoryDir
  const memFiles = memDir ? (await list($, memDir)).filter((e) => /\.md$/i.test(e.name) && e.name !== 'MEMORY.md').length : 0

  // Message channels installed at user scope live in ~/.claude/channels/<name>/ (a non-empty dir
  // is a configured one); a plugin-declared channel already installed counts once, as user.
  const chanDir = join(home, '.claude', 'channels')
  const userChans = new Set<string>()
  for (const e of await list($, chanDir)) if (e.kind === 'dir' && (await list($, join(chanDir, e.name))).length) userChans.add(e.name)

  const addDirs = (await $.settings.read({ key: 'permissions' }).catch(() => undefined)) as { additionalDirectories?: unknown } | undefined

  return {
    trusted,
    instructions: b?.instructions ?? {},
    memory: { u: memFiles },
    agents: b?.agents ?? {},
    commands: { ...gate(await dirCount('commands', false, /\.md$/i)), x: plug.commands },
    skills: b?.skills ?? {},
    workflows: { ...gate(await dirCount('workflows', false)), x: plug.workflows },
    routines: gate(await dirCount('routines', false)),
    rules: await dirCount('rules', true),
    mcp: gate({ m: Object.keys(managedMcp).length, u: mu.size, p: mp.size, l: ml.size, x: plug.mcps }),
    // Account-level claude.ai connectors: the connected servers the engine lists under that name.
    connectors: { u: sessionMcp.filter((s) => /^claude\.ai /i.test(s)).length },
    // claude-in-chrome counts as enabled only with the extension installed, the toggle on and
    // onboarding done — all readable locally. Live "connected" is session-only.
    chrome: cj?.cachedChromeExtensionInstalled === true && cj?.claudeInChromeDefaultEnabled === true && cj?.hasCompletedClaudeInChromeOnboarding === true,
    hooks: gate({ m: countHookMap(policy.hooks), u: countHookMap(user.hooks), p: countHookMap(project.hooks), l: countHookMap(local.hooks), x: plug.hooks }),
    plugins: { m: pm.size, u: pu.size, p: pp.size, l: pl.size },
    themes: { u: await countFiles($, join(home, '.claude', 'themes'), /\.json$/i), x: plug.themes },
    dirs: { l: arr(addDirs?.additionalDirectories).length },
    lsp: { x: plug.lsp },
    monitors: { x: plug.monitors },
    bin: { x: plug.bin },
    channels: { u: userChans.size, x: [...plug.channelNames].filter((n) => !userChans.has(n)).length },
  }
}

// ── legacy status line ───────────────────────────────────────────────────────────────────────────
// 1.x wired `statusLine` / `subagentStatusLine` in ~/.claude/settings.json to Bun scripts (staged
// copies in the plugin data dir, or a checkout). 2.x draws in the band instead, so those blocks
// would show a second dashboard. Only blocks whose command names this plugin's scripts are ours.

const LEGACY_RE = /statusline-dashboard[\\/].*(?:subagent-)?statusline\.js|statusline-dashboard-[^\\/]*[\\/](?:subagent-)?statusline\.js/i

export function legacyKeys(settings: Record<string, any> | null): string[] {
  if (!settings) return []
  return ['statusLine', 'subagentStatusLine'].filter((k) => LEGACY_RE.test(String(settings[k]?.command ?? '')))
}

/** Removes the legacy blocks from user settings, keeping a .bak of the file first. */
export async function removeLegacy($: $, home: string): Promise<string[]> {
  const path = join(home, '.claude', 'settings.json')
  const text = await readText($, path)
  if (text === null) return []
  let settings: Record<string, any>
  try {
    settings = JSON.parse(text)
  } catch {
    return []
  }
  const keys = legacyKeys(settings)
  if (!keys.length) return []
  await $.fs.write(`${path}.bak`, text)
  for (const k of keys) delete settings[k]
  await $.fs.write(path, JSON.stringify(settings, null, 2) + '\n')
  return keys
}
