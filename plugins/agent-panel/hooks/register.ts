// agent-panel — a mod that draws each sub-agent's and agent-team teammate's row in the agent list
// under the prompt: icon, name or type, live progress, model + effort, a colored status glyph,
// elapsed time, tokens.
//
// WHY A MOD (2.x; 1.x was a Bun script behind the plugin's `subagentStatusLine` setting): Claude
// Code 2.1.323 removed `subagentStatusLine`. The `AgentRow` render hook took its place, and it
// needs no staging, no settings and no Bun: the engine hands over the agent and takes the row's
// `body` back.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { renderRow } from './row'

const hide = atom({ plugin: 'agent-panel', key: 'hide' } as const, [] as string[])

async function homeDir($: EngineInterface): Promise<string> {
  return ((await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || '').replace(/\\/g, '/')
}

// Shares statusline-dashboard's config file (~/.claude/statusline-dashboard.json, or
// CLAUDE_STATUSLINE_CONFIG) and reads only its `hide` list, for the `subagent.*` ids.
async function loadHide($: EngineInterface): Promise<void> {
  const path = (await $.env.get('CLAUDE_STATUSLINE_CONFIG')) || `${await homeDir($)}/.claude/statusline-dashboard.json`
  let ids: string[] = []
  try {
    const h = JSON.parse(await $.fs.read(path))?.hide
    if (Array.isArray(h)) ids = h.map((x) => String(x).toLowerCase())
  } catch {
    // missing or broken file → nothing hidden
  }
  await update($, hide, () => ids)
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await loadHide($)
    return next(e)
  })

  // $.state resets with /clear; read the file again on every start-like event.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork', 'compact'] }, async ($, e, next) => {
    await loadHide($)
    return next(e)
  }).catch(($, e, next) => next(e)) // observing only: on a failure, carry on as if unhooked

  // Terminal only: the glyphs need a Nerd Font, and the desktop and VS Code draw their own rows
  // well enough. Visibility (isHidden) stays the engine's and the person's.
  on('ui.render', { component: 'AgentRow' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isHidden) return next(e)
    const body = renderRow(e.props, new Set(await read($, hide)), await $.clock.now(), e.props.columns)
    return next({ ...e, props: { ...e.props, body } })
  })
}
