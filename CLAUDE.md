# cc-plugins

A Claude Code plugin marketplace (`.claude-plugin/marketplace.json`, name `cc-plugins`) with one
plugin per `plugins/<name>/` folder. Each plugin is self-contained — its own manifest, hooks,
skills, sources and README — and the root holds only the marketplace file, CI and docs.

## Repo-wide rules

- **Plugin names can't start with `claude-`** (reserved; `claude plugin validate` errors), and a
  marketplace can't be named `claude-code-plugins` or any other official name — hence
  `statusline-dashboard` / `cc-plugins`.
- **A plugin can't set `statusLine`, can't run a build, and its install path moves on every
  update** (`${CLAUDE_PLUGIN_ROOT}` is `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`).
  Anything that has to be built, or referenced from outside the plugin (a settings.json command,
  a registry entry, an .app bundle), goes in `${CLAUDE_PLUGIN_DATA}` (stable), produced by the
  plugin's `/<plugin>:setup` skill. Hooks themselves live in `hooks/hooks.json` and may reference
  `${CLAUDE_PLUGIN_ROOT}` freely — Claude Code substitutes it per version.
- **One `hooks.json` serves every OS.** Platform branching happens in a POSIX `sh` dispatcher
  under `hooks/` (Git Bash provides `sh` on Windows), which `exec`s the implementation so the
  process tree the implementations walk stays intact. Dispatchers always exit 0 when there is
  nothing to run.
- **Shipping to plugin users = bumping `version` in that plugin's `.claude-plugin/plugin.json`.**
  The manifest version IS the plugin version; a push without a bump never reaches installed
  copies. A checkout added as a local marketplace loads in place and ignores the version.
- After touching anything under `plugins/` or `.claude-plugin/`: `claude plugin validate --strict .`
  and `claude plugin validate --strict plugins/<name>` (validating the marketplace also validates
  every plugin's manifest, so a warning anywhere fails the strict root run).
  CI does the same, plus `sh -n` on the dispatchers, `cargo build` of the Windows crates and
  `swift build` of the macOS package.
- Commit when a change is done and verified; **do not push without being asked.**
- Subprocess hygiene everywhere: secrets never on a command line (the statusline passes its OAuth
  token to `curl` via `-K -`), `windowsHide: true` on every `spawn`/`spawnSync`.

## plugins/statusline-dashboard

A **mod** (a plugin of function hooks, Claude Code 2.1.287+) that draws an opinionated dashboard
in the band above the prompt: one collapsible row per section. 2.x replaced the 1.x Bun
`statusLine` scripts (and absorbed the old context-bar mod as the Model row's open view) because a
mod needs no settings.json edit — uninstall leaves nothing behind but the user's config file.
Load the `plugin-authoring` skill before editing it: the API is the build's `claude-code.d.ts`,
and the static validator has rules of its own — helpers that take `$` must be top-level function
declarations (they may live in imported files), `$` is always spelled `$.noun.method(...)`,
`$.env.get` takes string literals, `atom()` refs need literal `plugin`/`key`, and every `$.state`
key must be declared in `types/index.d.ts`.

### Files

- `hooks/register.tsx` — event wiring, the `/dash` command, and the `AbovePrompt` render hook.
  Data flows one way: event hooks collect into `$.state`; the render hook only reads (a write
  redraws exactly the band). Slow work (git, config scans, the usage API) runs from
  `$.clock.after(0, …)` timers, never on an event's dispatch, so it can't delay a prompt.
  Observing hooks on gating events (`tool.call`, `prompt.submit`, `classic.SessionStart`) carry
  `.catch(($, e, next) => next(e))`. `recordTool`/`editLines` are pure and exported for tests.
- `hooks/collect.ts` — every engine/fs/git/network read: usage, the context breakdown (instruction
  files, agents, skills, MCP servers come from it — engine truth, not file guesses), git + `gh pr
  view` (5-min TTL per branch), host/fleet, config counts (disk + `$.settings.read({ source })`,
  trust-gated), the OAuth usage API via `$.session.authorize()` (the credential never reaches the
  mod), and the 1.x legacy cleanup. Each collector swallows its own failures.
- `hooks/sections.ts` — pure row builders (state in, `Section[]` out), user-config parsing, Nerd
  Font glyph table. Widget ids (`on("row.widget")`) must stay in sync with the README table and
  the configure skill's id list.
- `hooks/layout.ts` — pure layout: `Run`/`Item`/`Section`, `packSection` (the status line's
  packer, carried over), `plan` (height budget), `contextDetail`/`stack` (the breakdown bar),
  `stripLabels`, formatting. Tests check its arithmetic directly.
- `types/index.d.ts` — the `$.state` contract.
- `tests/dashboard.test.tsx` — `claude plugin test plugins/statusline-dashboard`.
- `skills/configure/SKILL.md` — edits the user config, `~/.claude/statusline-dashboard.json`
  (`CLAUDE_STATUSLINE_CONFIG` overrides the path); outside the plugin so updates and uninstalls
  never touch it.

### Layout invariants

- **Lines never exceed `bodyColumns - 1`.** `packSection` measures with `cells` (Nerd Font PUA
  glyphs count as 2, since fonts draw them 1 or 2 wide and the layout engine counts 1) and
  degrades per item: widest alt → narrowest → wrap → truncate with `…`. The overflow strip is
  fitted too (`stripLabels`). A hard-wrapped row desyncs the repaint.
- **Height stays within budget**: fullscreen → `props.maxRows`; main screen → a third of the
  viewport rows (`maxRows` there is the whole terminal); config `maxRows` can only lower it. `plan`
  gives every section with data one line; over budget, sections leave to a one-line overflow strip
  of toggles in `DROP_ORDER`; the oldest open row folds before the newest; other rows yield seats
  to the newest open row before it is cut. Nothing scrolls; nothing is unreachable.
- **Adding a row** = a builder in `sections.ts`, an id in `ROW_IDS` and `DROP_ORDER`, the README
  row list and table, and the configure skill.
- Glyphs only on the `terminal` surface (desktop has no Nerd Font); semantic colours are theme
  keys (`success`/`warning`/`error`), decorative hues `c256(n)` → hex. Before adding a hue, grep
  `c256(` to confirm it's unused.

### Pace balance

Each Limits gauge appends a signed pace balance vs the even-consumption budget line
(`(elapsed/window)·100`, window start = `resetsAt` − window length): `+N%` = quota in hand
(green), `-N%` = burning ahead (yellow), dim within ±2%. Kept to a few chars on purpose — the user
wants it terse; don't expand it into words or give it a dedicated row.

### Style

Comments explain *why* (engine quirks, font quirks, API gotchas); preserve and imitate that
register. Verify with `claude plugin validate --strict plugins/statusline-dashboard` and
`claude plugin test plugins/statusline-dashboard`; a real look in a terminal is still needed for
anything visual (the test kit checks the tree, not the paint).

## plugins/agent-panel

The agent panel's rows (`subagentStatusLine`) for sub-agents and agent-team teammates, split out
of statusline-dashboard 1.x. `agent-panel.js` is a single-file Bun script: JSON on stdin (`columns`,
`tasks[]`), one `{"id","content"}` line per row out, every row clamped to `columns - 1` cells with
`vlen` (Nerd Font PUA glyphs count 2). Wiring needs no settings edit: the plugin's root
`settings.json` sets `subagentStatusLine` (with `agent`, the only keys a plugin's settings take),
and its command (`bun -e "import(…)"`, resolving `CLAUDE_CONFIG_DIR` or the home dir in JS so it
runs the same under bash, cmd and PowerShell — Claude Code picks the shell on Windows) loads
`<config dir>/plugins/data/agent-panel-cc-plugins/agent-panel.js`, which `scripts/stage.js` (SessionStart hook; silent, always exit 0) keeps current — the docs
promise no `${CLAUDE_PLUGIN_ROOT}` substitution in that command, and the root moves per version.
The path in `settings.json` and the data dir must agree. A user's own `subagentStatusLine` in
`~/.claude/settings.json` outranks the plugin's. It reads the `subagent.*` ids from
statusline-dashboard's config file's `hide` list.

## plugins/session-color

Status-driven terminal background tint. `hooks/hooks.json` maps nine events to one of four state
words (`working` / `needs` / `done` / `reset`). The dispatcher shows the LEAD's state: events
carrying `agent_id` (sub-agents, in-process teammates) paint only `needs`, and their next `working`
restores the lead's last state (remembered per session in `$TMPDIR/session-color-<session_id>`).
The macOS/Linux tty walk stops at the nearest `claude` process (no tty there → paint nothing), so a
background session never tints the pane of the session that launched it — keep it in sync with the tables in the README and
the `MAPPING` comment in `windows/src/main.rs`. `Notification` is deliberately unwired (it only
repaints states the specific events already cover). Implementations: `macos/session-color.sh`
(OSC 11 to the pane's pty, found by walking the process tree to `claude`), `linux/session-color.sh`
(same, but tmux-native `select-pane -P bg=` when inside tmux), `windows/` (Rust: `AttachConsole`
to Claude's ConPTY, write to `CONOUT$`). The Windows exe is built by `windows/setup.ps1` into the
data dir; the dispatcher no-ops until then. The binaries' own `install`/`uninstall` subcommands
(which edit settings.json) are legacy for non-plugin use and are not called by the plugin.

## plugins/notifications

Native desktop notifications. Four events in `hooks/hooks.json` → `hooks/notifications.sh` →
the staged binary's subcommand (`on-submit`, `notify notification`, `notify stop`, `on-end`).
`Notification`/`Stop` are `async` (macOS blocks until the notification is clicked/dismissed);
`UserPromptSubmit` is `async` (Windows stays alive as the focus watcher, inside Windows
Terminal's process tree so UI Automation works). Sources: `windows/src/main.rs` (Rust, WinRT
toasts, `claude-focus://` / `claude-editor://` protocol handlers), `macos/Sources/main.swift`
(Swift, UserNotifications, needs the `.app` bundle `macos/setup.sh` assembles and ad-hoc signs).
User-owned files (config.json, icons/, webhook templates) live in `~/.claude/notifications/`
(`$CLAUDE_CONFIG_DIR/notifications/` when set), NOT the data dir — `claude plugin uninstall`
deletes `${CLAUDE_PLUGIN_DATA}`, which therefore holds only rebuildable artifacts (exe / .app,
build/). Both binaries look there first, then fall back to walking up from their own location
(checkout / pre-1.1 layouts); relative config paths resolve against wherever config.json was
found. Setup scripts seed that dir and migrate anything else they find in the data dir into it.
Setup scripts never touch `settings.json`; the Windows one owns the registry (protocol handlers
HKCU, AUMID HKLM with UAC). No hook runs at plugin uninstall, so `--uninstall` must remove
everything setup created outside `~/.claude/notifications/` (registry, LaunchServices, ~/Library
state) and leave that dir alone; docs tell users to run it before `/plugin uninstall`.
Linux is not implemented (plan: relay to the macOS/Windows notifier over SSH/WSL).

## What doesn't belong here

Forks of other people's plugins (the official discord channel plugin was briefly a subtree and
was taken out again): install those from their own marketplace. This repo holds only plugins
written here.
