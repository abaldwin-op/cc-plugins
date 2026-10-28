---
name: configure
description: Customize the statusline-dashboard (the dashboard above the prompt) — show, hide, or reorder its rows and widgets, choose which rows start open, drop the row labels or gauge bars, switch the clock to 12h, cap its height, or turn off the usage-API or gh lookups. Use when the user runs /statusline-dashboard:configure, or asks to change, trim, simplify, or customize what the dashboard shows.
argument-hint: "[what to change, e.g. \"hide the host row and the OS badge\"]"
allowed-tools: Read, Write, Edit
---

# Configure the statusline-dashboard

The dashboard reads an optional JSON file, **`~/.claude/statusline-dashboard.json`** (or the path
in `$CLAUDE_STATUSLINE_CONFIG` when that is set). Plugin updates and uninstalls never touch it.
The dashboard re-reads it every minute and at each session start; no restart.

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
| `expanded` | array of row ids | `[]` | Rows open by default, until the user first opens or closes one (clicking a label, or `/dash <row>`); after that their own choice is remembered. |
| `labels` | boolean | `true` | `false` drops the row labels, which frees 9 columns per row; the ▸/▾ toggles stay. |
| `bars` | boolean | `true` | `false` shows every gauge as a number only, with no bar. |
| `pace` | boolean | `true` | `false` drops the `+N%` / `-N%` pace balance from the Limits gauges. |
| `clock` | `"24h"` or `"12h"` | `"24h"` | Format of the Host-row clock and the reset times. |
| `usageApi` | boolean | `true` | `false` never calls the usage API, so there are no model-scoped weekly gauges and no `Cr` gauge. |
| `pr` | boolean | `true` | `false` never runs `gh` for the Repo row's PR badge. |
| `maxRows` | positive integer | none | Caps the dashboard's height. It can only lower the built-in budget. |
| `padTop` | integer 0–3 | `1` | Blank lines above the first row, between it and the spinner. Taken only from height the rows leave unused, so it never costs a row; `0` removes it. |

**Row ids**, in the default order: `model`, `limits`, `usage`, `turn`, `activity`, `agents`,
`repo`, `config`, `exts`, `host`, `info`.

**Widget ids** for `hide`:

- `model.effort`, `model.thinking`, `model.context`
- `limits.5h`, `limits.7d`, `limits.scoped` (model-scoped weekly, e.g. `7dF`), `limits.spend`
  (gateway `Sp`), `limits.credits` (`Cr`)
- `usage.cost`, `usage.burn` ($/h), `usage.speed` (tok/s), `usage.api`, `usage.duration`
- `turn.tokens`, `turn.cache` (prompt-cache health), `turn.history` (the open row's last turns)
- `activity.command`, `activity.todo`, `activity.tool`, `activity.lines`
- `agents.subagents` (running / ✔ / ✘ counts), `agents.team` (teammates), `agents.history` (the open
  row's list of sub-agents and teammates)
- `repo.remote`, `repo.worktree`, `repo.branch`, `repo.pr`, `repo.tag`, `repo.files` (the open row's last commit and changed files)
- `config.instructions`, `config.memory`, `config.agents`, `config.commands`, `config.skills`,
  `config.workflows`, `config.routines`, `config.rules`, `config.mcp`, `config.connectors`,
  `config.chrome`, `config.hooks`, `config.plugins`, `config.themes`, `config.dirs`, and
  `config.scopes` (the `(m/u/p/l/x)` breakdowns)
- `exts.lsp`, `exts.monitors`, `exts.bin`, `exts.channels`
- `host.clock`, `host.os`, `host.user`, `host.fleet`
- `info.cwd`, `info.style`, `info.version`, `info.agent`, `info.session`

Example: a compact three-row dashboard without the Host clutter:

```json
{
  "rows": ["model", "limits", "info"],
  "hide": ["info.version", "model.thinking"],
  "labels": false
}
```

Opening and closing rows doesn't need the file: the user clicks a row's label, or runs
`/dash <row>`, `/dash open all`, `/dash close all`. `/dash` alone hides or shows the whole dashboard.
