# statusline-dashboard

An opinionated [Claude Code](https://claude.com/claude-code) dashboard: context, cost,
rate-limit windows with pace balance, activity and sub-agents, git/PR, and full config-scope
breakdowns, drawn with Nerd Font glyphs in the band above the prompt. Every row folds to one line
and opens to its full detail.

It's a [mod](https://code.claude.com/docs/en/plugins/mods/overview) (Claude Code **2.1.287+**):
nothing to set up, nothing written to your settings. Install it and it draws. Uninstall it and
it's gone.

```
▸ Model    󰚩 Opus 4.7 |  xhigh 󰛨 |  ████░░░░░░ 40% 80K/200K
  Limits   󰊚 5h ████▎░░░░░ 42% 15:00 +18% | 7d █▎░░░░░░░░ 13% Tue 09:00 +16%
  Usage     $1.50 |  ~$1.50/h |  44 tok/s |  API 12m |  1h
▾ Repo      cc-plugins | 󰊤 anthonybaldwin |  main ↑2 +1 ~3 ?1 |  #12 ● |  v1.2.0+3
           a1b2c3d Fix the pace sign  12m ago
           ~ plugins/statusline-dashboard/hooks/layout.ts
           ? notes.md
  Info.     ~/src/cc-plugins |  v2.1.310 |  abcd1234
+ Turn Activity Config Exts. Host
```

## Install

```
/plugin marketplace add anthonybaldwin/cc-plugins
/plugin install statusline-dashboard@cc-plugins
```

**Coming from 1.x?** 1.x was a `statusLine` script wired into `~/.claude/settings.json`. Run
`/dash cleanup` once: it removes that block (it backs up `settings.json` to `settings.json.bak`
first), so you don't get two dashboards. **Coming from context-bar?** It's now the Model row's open
view. Run `/plugin uninstall context-bar@cc-plugins`.

## Use

| | |
| --- | --- |
| Click a row's `▸`/`▾` label (fullscreen), or `ctrl+x tab` then Tab and Enter | Open or close that row. Only rows with more to show have the arrow; a row without one is already whole. |
| `/dash` | Show or hide the whole dashboard. Your choice is remembered across sessions. |
| `/dash <row>` | Open or close one row (`/dash config`) |
| `/dash open all` · `/dash close all` | Open or close every row |
| `/dash cleanup` | Remove the 1.x `statusLine` / `subagentStatusLine` blocks from `settings.json` (the agent panel's rows are now the [agent-panel](../agent-panel/) plugin) |
| `ctrl+x ctrl+a` | Claude Code's own collapse for the band above the prompt |

The band is shared with other mods and with Claude Code's surveys. A survey takes precedence while
it's up.

### How it fits the terminal

- **Closed rows** are one line each. Items take their compact form (no bars, no scope
  parentheses) and are cut with `…` when even that won't fit.
- **Open rows** show everything. Items wrap to aligned continuation lines, gauges keep their
  bars, and Config keeps its `(m/u/p/l/x)` breakdowns. Some rows add what a single line has no
  room for:
  - **Model**: the context window broken down by category, as `/context` shows it — a stacked
    bar, one colour per category, and a legend.
  - **Turn**: the last five turns — duration, output, input and how much of it came from the cache.
  - **Activity**: the todo list around the current item, and the last five tool calls, one per
    line with what each acted on (✔ answered, ✘ failed, … running; repeats collapse to `×n`).
  - **Agents**: the session's last six sub-agents and teammates in the order they started, each
    with a robot (sub-agent) or person (teammate), its type or name, its task and where it stands.
    The dashboard keeps this history itself, because Claude Code's agent list drops an agent soon
    after it finishes.
  - **Repo**: the last commit and the first changed files.
- **Height budget.** In fullscreen the dashboard takes what the bottom slot has left. On the main
  screen it takes at most a third of the terminal, so the conversation keeps its room. Over
  budget, in this order:
  1. The oldest open row folds back to one line (`▹`). The row you opened last wins.
  2. The least essential rows move into a one-line strip of toggles (`+ Turn Activity …`). They
     stay one click away.
  3. Only then is the open row cut short.
- **Width.** No line is ever wider than the band. A terminal hard-wrap would desync Claude Code's
  repaint, so Nerd Font glyphs are measured as two cells (fonts draw them one or two wide).
- A row with nothing to show takes no space, for example Activity after `/clear`, or Repo outside
  a git repository.

## What it shows

- **Model**: the model (⚡ when fast mode is on), the reasoning effort of the last model request
  (styled to echo Claude Code's `/effort` menu) with a lamp when extended thinking is on, and the
  context gauge. The gauge warns early: yellow from 50%, red from 80%. **Open** for the
  per-category breakdown.
- **Limits**: the `5h` and `7d` windows with bars, percentages, reset times and a signed **pace
  balance** against even consumption. `+N%` (green) is quota in hand, `-N%` (yellow) is burning
  ahead, and it's dim within ±2%. It also shows model-scoped weekly caps from the OAuth usage API
  (`7dF` for the Fable weekly allowance, on its own 0–100% scale). A `Cr` gauge appears once
  usage credits start being spent, and `Sp` appears behind a Claude apps gateway spend limit.
- **Usage**: session cost, `$/h` burn rate, throughput (tok/s over the time the model was actually
  streaming), API time, and wall-clock.
- **Turn**: the last call's token makeup (input / output / cache write / cache read) and the
  session's prompt-cache hit ratio.
- **Activity**: the active slash command, todo or task progress, the last tool call (yellow while
  it runs) with a call count, and the session's edit volume (+added / −removed lines).
- **Agents**: sub-agents (running, a green ✔ tally of finished ones, a red ✘ for failed ones) and
  the agent-team teammates on the team now.
- **Repo** (inside a git repository only): project name, origin owner with a GitHub / GitLab /
  Bitbucket badge, worktree, branch with ahead/behind and staged / modified / untracked /
  conflict counts, and the latest `v*` tag with commits since. With an authed
  [`gh`](https://cli.github.com/), the branch's open PR also shows, colored by review state and
  clickable. `gh` runs at most every five minutes per branch.
- **Config**: what's loaded, each item broken down by scope (see below): instruction files
  (CLAUDE.md / AGENTS.md), auto-memory files, agents, commands, skills, workflows, routines,
  rules, MCP servers, claude.ai connectors, claude-in-chrome, hooks, plugins, themes, and added
  directories.
- **Exts.**: plugin-only component types: LSP servers, background monitors, `bin/` executables,
  and message channels.
- **Host**: clock, OS and version, `user@host`, and how many *other* Claude Code sessions are live
  on this machine.
- **Info.**: current directory (leaf kept when long), output style, Claude Code version, agent
  name, and the session id.

Instruction files, agents, skills, MCP servers and the sub-agent roster come straight from
Claude Code: what is actually loaded, with trust and precedence applied. The rest is counted from
disk and gated on workspace trust the same way Claude Code gates loading.

### Reading the `(0/1/1/0/-)` scope breakdown

`icon total (m/u/p/l/x)` is a count followed by where those items come from. The slots are fixed,
broadest to narrowest:

| Slot | Scope | Where it lives |
| --- | --- | --- |
| `m` | **managed** | Enterprise/org policy: `managed-settings.json`, `managed-mcp.json`, the Windows registry policy. |
| `u` | **user** | `~/.claude/` and `~/.claude.json`. Loads in every project. |
| `p` | **project** | Committed in the repo: `.claude/`, `.mcp.json`, `CLAUDE.md`. |
| `l` | **local** | Your uncommitted overrides: `.claude/settings.local.json`, `CLAUDE.local.md`, `~/.claude.json` `projects[…]`. |
| `x` | **plugin** | Bundled by enabled plugins. |

A number (`0` included) means the item can come from that scope, and that many currently do. A
`-` means it never can. The parentheses appear only when the total is above 0.

| Item | Slots that can hold a count |
| --- | --- |
| Instruction files, Plugins | `m` `u` `p` `l` |
| MCP servers, Hooks | `m` `u` `p` `l` `x` |
| Agents, Skills | `m` `u` `p` `x` |
| Commands, Workflows | `u` `p` `x` |
| Rules, Routines | `u` `p` |
| Themes, Channels | `u` `x` |

## Requirements

- Claude Code **2.1.287+** (mods). The dashboard draws in the terminal and in the Desktop app's
  Code tab. The VS Code chat panel and `claude -p` run the hooks but draw nothing.
- A [**Nerd Font**](https://www.nerdfonts.com/) for the icons in the terminal. It doesn't have to
  be your primary font: Ghostty falls back to installed fonts automatically, and in Windows
  Terminal you can set the font face to e.g. `MonoLisa, SymbolsNerdFont`. The Desktop app draws no
  icons.
- Optional: `git` for the Repo row, and an authed `gh` for its PR badge.

## Configuration

Everything is optional. Create `~/.claude/statusline-dashboard.json`, or run
`/statusline-dashboard:configure` and describe what you want. Changes apply within a minute.
The file lives outside the plugin, so updates and uninstalls never touch it.

```json
{
  "rows": ["model", "limits", "usage", "repo", "info"],
  "hide": ["host.os", "usage.api", "config.scopes"],
  "expanded": ["limits"],
  "labels": false,
  "bars": true,
  "pace": true,
  "clock": "12h",
  "usageApi": true,
  "pr": true,
  "maxRows": 6,
  "padTop": 1
}
```

| Key | Default | Effect |
| --- | --- | --- |
| `rows` | all rows | Which rows render, and in what order: `model`, `limits`, `usage`, `turn`, `activity`, `agents`, `repo`, `config`, `exts`, `host`, `info`. |
| `hide` | `[]` | Row ids or individual widget ids to drop (listed below). |
| `expanded` | `[]` | Rows open by default, until you first open or close one yourself. |
| `labels` | `true` | `false` drops the row labels. The ▸/▾ toggles stay. |
| `bars` | `true` | `false` renders every gauge as a number only. |
| `pace` | `true` | `false` drops the `+N%` / `-N%` pace balance. |
| `clock` | `"24h"` | `"12h"` for a 12-hour clock and reset times. |
| `usageApi` | `true` | `false` never calls the usage API: no model-scoped weekly gauges and no `Cr` gauge. |
| `pr` | `true` | `false` never runs `gh` for the Repo row's PR badge. |
| `maxRows` | none | Caps the dashboard's height. It can only lower the built-in budget. |
| `padTop` | `1` | Blank lines above the first row (0–3), so the spinner doesn't sit on it. Taken only from room the rows don't need. |

Widget ids for `hide`:

| Row | Widgets |
| --- | --- |
| Model | `model.effort` `model.thinking` `model.context` |
| Limits | `limits.5h` `limits.7d` `limits.scoped` `limits.spend` `limits.credits` |
| Usage | `usage.cost` `usage.burn` `usage.speed` `usage.api` `usage.duration` |
| Turn | `turn.tokens` `turn.cache` `turn.history` |
| Activity | `activity.command` `activity.todo` `activity.tool` `activity.lines` |
| Agents | `agents.subagents` `agents.team` `agents.history` |
| Repo | `repo.remote` `repo.worktree` `repo.branch` `repo.pr` `repo.tag` `repo.files` |
| Config | `config.instructions` `config.memory` `config.agents` `config.commands` `config.skills` `config.workflows` `config.routines` `config.rules` `config.mcp` `config.connectors` `config.chrome` `config.hooks` `config.plugins` `config.themes` `config.dirs` `config.scopes` |
| Exts. | `exts.lsp` `exts.monitors` `exts.bin` `exts.channels` |
| Host | `host.clock` `host.os` `host.user` `host.fleet` |
| Info. | `info.cwd` `info.style` `info.version` `info.agent` `info.session` |

Unknown keys and ids are ignored. A file that isn't valid JSON falls back to the defaults, so a
typo never blanks the dashboard. `CLAUDE_STATUSLINE_CONFIG` points it at a different file.

## Uninstall

`/plugin uninstall statusline-dashboard@cc-plugins`. Nothing is left behind except your
`~/.claude/statusline-dashboard.json`, which is kept on purpose for a reinstall. Delete it if you
don't want it.

## How it works

`hooks/register.tsx` collects into `$.state` from Claude Code's events. The render hook for the
band above the prompt only reads that state, so each update redraws just the band, and nothing
ever blocks a render on git, the disk or the network.

| Event | What it refreshes |
| --- | --- |
| `session.start`, `/clear`, `/resume`, compaction | Everything. The slow parts run off the event, so the first prompt never waits. |
| `session.measure` (after each turn, when a rate-limit window moves) | Usage, plus the context breakdown when it changed |
| `turn.step` (each model request) | Effort level and API time |
| `turn.complete` | Tokens, cache ratio, then git and the config counts |
| `tool.call` | Activity: last tool, todos and tasks, edit lines |
| Every minute | Clock, countdowns, pace, other sessions, git, the usage API (at most every 5 minutes) |

The usage API call uses `$.session.authorize()`: Claude Code attaches your credential to the
request itself, so the token never reaches the mod.

Tests: `claude plugin test plugins/statusline-dashboard` covers the layout arithmetic (width,
height budget, the breakdown bar), the parsers, the activity bookkeeping, drawing on both
surfaces, toggling rows, `/dash`, the user config, and the 1.x cleanup.
