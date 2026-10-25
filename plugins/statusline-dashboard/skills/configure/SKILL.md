---
name: configure
description: Customize the statusline-dashboard status line — show, hide, or reorder its rows and widgets, drop the row labels or gauge bars, switch the clock to 12h, cap its height, or turn off the usage-API lookup. Use when the user runs /statusline-dashboard:configure, or asks to change, trim, simplify, or customize what the dashboard shows.
argument-hint: "[what to change, e.g. \"hide the host row and the OS badge\"]"
allowed-tools: Read, Write, Edit
---

# Configure the statusline-dashboard

The dashboard reads an optional JSON file, **`~/.claude/statusline-dashboard.json`** (or the path
in `$CLAUDE_STATUSLINE_CONFIG` when that is set). The same file applies to a plugin install and a
checkout install, and plugin updates never touch it. Changes show on the next render; no restart.

## Steps

1. Read the current file. A missing file means every option is at its default.
2. Work out the change from `$ARGUMENTS` or the conversation. If the request is vague ("make it
   smaller"), propose a concrete change from the reference below and confirm it before writing.
3. Write the file back as pretty-printed JSON. Keep any keys you were not asked to change. Use
   only the keys and ids below, because the dashboard ignores anything else without telling you.
4. Tell the user in one or two lines what will change. To undo everything, delete the file.

## Reference

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `rows` | array of row ids | all, in the order below | Which rows render, in this order. |
| `hide` | array of row or widget ids | `[]` | Drops these rows or widgets. |
| `labels` | boolean | `true` | `false` drops the left label column, which frees 9 columns per row. |
| `bars` | boolean | `true` | `false` shows every gauge as a number only, with no bar. |
| `pace` | boolean | `true` | `false` drops the `+N%` / `-N%` pace balance from the Limits gauges. |
| `clock` | `"24h"` or `"12h"` | `"24h"` | Format of the Host-row clock. |
| `usageApi` | boolean | `true` | `false` never reads the OAuth token or calls the usage API, so there are no model-scoped weekly gauges and no `Cr` gauge. |
| `maxRows` | positive integer | none | Caps the number of rows. It can only lower the built-in limit of a third of the terminal height. |

**Row ids**, in the default order: `model`, `limits`, `usage`, `turn`, `activity`, `repo`,
`config`, `exts`, `host`, `info`.

**Widget ids** for `hide`:

- `model.effort`, `model.thinking`, `model.context`
- `limits.5h`, `limits.7d`, `limits.scoped` (model-scoped weekly, e.g. `7dF`), `limits.spend`
  (gateway `Sp`), `limits.credits` (`Cr`)
- `usage.cost`, `usage.burn` ($/h), `usage.speed` (tok/s), `usage.api`, `usage.duration`
- `turn.tokens`, `turn.cache` (prompt-cache health)
- `activity.command`, `activity.todo`, `activity.tool`, `activity.agents`, `activity.team`,
  `activity.lines`
- `repo.remote`, `repo.worktree`, `repo.branch`, `repo.pr`, `repo.tag`
- `config.instructions`, `config.memory`, `config.agents`, `config.commands`, `config.skills`,
  `config.workflows`, `config.routines`, `config.rules`, `config.mcp`, `config.connectors`,
  `config.chrome`, `config.hooks`, `config.plugins`, `config.themes`, `config.dirs`, and
  `config.scopes` (the `(m/u/p/l/x)` breakdowns)
- `exts.lsp`, `exts.monitors`, `exts.bin`, `exts.channels`
- `host.clock`, `host.os`, `host.user`, `host.fleet`
- `info.cwd`, `info.style`, `info.vim`, `info.version`, `info.agent`, `info.remote`, `info.session`
- Agent panel rows: `subagent.label`, `subagent.model`, `subagent.elapsed`, `subagent.tokens`

Example: a compact three-row dashboard without the Host clutter:

```json
{
  "rows": ["model", "limits", "info"],
  "hide": ["info.version", "model.thinking"],
  "labels": false
}
```

If the user hides `info.vim`, mention that Claude Code's own `-- INSERT --` indicator stays hidden
while `statusLine.hideVimModeIndicator` is `true` in their settings.
