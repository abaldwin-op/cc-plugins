# cc-plugins

A Claude Code plugin marketplace (`.claude-plugin/marketplace.json`, name `cc-plugins`) with one
plugin per `plugins/<name>/` folder. Each plugin is self-contained — its own manifest, hooks,
skills, sources and README — and the root holds only the marketplace file, `check.js`, CI and docs.

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

An opinionated multi-row statusline dashboard. Single-file Bun scripts, no dependencies, no
build step.

### Files

- `statusline.js` — the main dashboard. Reads Claude Code's statusline JSON from stdin, writes
  ANSI-styled rows to stdout. Everything lives in this one file, ordered roughly: ANSI/color
  constants → glyphs → formatting helpers → config-counting subsystem (scopes, plugins, MCP) →
  stdin parse → per-row segment building → `packSection` layout → output.
- `subagent-statusline.js` — the per-subagent row for Claude Code's agent panel
  (`subagentStatusLine` in settings). Same conventions, much smaller.
- `install.js` — points `~/.claude/settings.json` at the scripts in ITS OWN directory (merges,
  backs up first). Run from the checkout it wires the checkout; run from the plugin data dir (via
  the `setup` skill) it wires the staged copies. `--print` for a dry run; `--uninstall` clears
  only blocks that point at that directory.
- `hooks/hooks.json` + `scripts/stage.js` — `SessionStart` hook that copies the three scripts
  into `${CLAUDE_PLUGIN_DATA}` so settings can point at a stable path (see repo-wide rules). Must
  stay silent (SessionStart stdout is injected into Claude's context) and always exit 0. Adding a
  file the status line needs at runtime = adding it to `FILES` there (and the `staged` list in
  `check.js`).
- `skills/setup/SKILL.md` — `/statusline-dashboard:setup`: stages, then runs `install.js` from the
  data dir (`--print` / `--uninstall` pass through).
- `skills/configure/SKILL.md` — `/statusline-dashboard:configure`: edits the user config file,
  `~/.claude/statusline-dashboard.json` (`CLAUDE_STATUSLINE_CONFIG` overrides the path). It lives
  outside the plugin so both install kinds share it and updates never clobber it. Both scripts
  read it: row selection/order, `hide` widget ids (gated with `on("row.widget")`), `labels`,
  `bars`, `pace`, `clock`, `usageApi`, `maxRows`. A new widget gets an id, and the README table
  and the skill's id list must stay in sync with the `on(...)` calls.
- `/check.js` (repo root) — the invariant checker (see below).

### Running / verifying changes

Requires **Bun** (`Bun.stdin` / `Bun.main`). Run `bun check.js` (from the repo root) after any
change to the packer, height budget, or output shape: it renders fixture payloads for both
scripts across a grid of `COLUMNS`×`LINES` inside a sandboxed `HOME`/`TEMP` (no real config, no
live caches, no network) and asserts the invariants below plus a "no data-less rows" rule and the
staging hook's contract. `--show 60x24` prints one stripped render. For a specific payload, pipe
it in by hand:

```sh
echo '{"session_id":"x","model":{"display_name":"Opus"},"cwd":"C:/some/repo","cost":{},
  "context_window":{"context_window_size":200000,"current_usage":{"input_tokens":50000}},
  "rate_limits":{"five_hour":{"used_percentage":42,"resets_at":"2026-06-12T20:00:00Z"}}}' \
  | COLUMNS=140 bun plugins/statusline-dashboard/statusline.js
```

The user's live statusline may run `statusline.js` **directly from this working tree** (a
checkout install points settings at the repo file, not a copy) — edits take effect on the next
render, including broken ones. Don't leave the file in a non-running state between edits.
(Plugin installs run the staged copy in `~/.claude/plugins/data/` instead and only pick up a
`version` bump.) A new row also means bumping `SECTIONS` in `check.js`, and updating the README
row list — it enumerates every row in render order.

### Critical invariants

These exist to dodge real Claude Code rendering bugs; violating them corrupts the user's
terminal, not just the aesthetics.

1. **Height never shrinks between renders, and never exceeds what the terminal can spare.**
   Shrink: CC reserves vertical space from the previous render's line count; if the count drops,
   stale rows stack (under-clear, fixed upstream in CC v2.1.170 but kept defensive). Guarded by
   the slot floor (empty sections backfill blank) AND a per-session high-water mark
   (`sl-hwm-*.json`, keyed to `COLUMNS×LINES`) that pads later renders up to the tallest height
   already shown; the mark resets on resize (which forces a full CC repaint anyway). Short
   terminal: CC gives the statusline what remains after the turn's transcript tail + prompt +
   its own footer, and hard-trims our tail AND the footer when we exceed it (observed
   v2.1.223) — the transcript share is unknowable, so content clamps to a THIRD of `LINES`
   (CC's exported height belief); over budget, the squeeze loop re-packs the tallest section
   (ties by `SQUEEZE_ORDER`) one row shorter via `packSection`'s `maxRows` (cut with a trailing
   `…`), then whole sections vanish in `DROP_ORDER`. Tall terminal: wraps beyond the section
   count are allowed (no `…` data loss) up to `WRAP_HEADROOM` extra rows. **Adding a row =
   adding one entry to `sectionSpecs`** (and to `SQUEEZE_ORDER` + `DROP_ORDER` + `ROW_IDS`);
   never conditionally omit a slot. The user config's row selection is the one exception: it
   filters `sectionSpecs` up front (a static choice, not a per-render one), and the config file's
   mtime joins the high-water-mark key so an edit resets the mark. Its `maxRows` can only lower
   the budget.
2. **Lines must never exceed the terminal width.** CC counts logical lines; a terminal
   hard-wrap desyncs its repaint. `packSection` measures with `vlen` (visible width, ANSI-, OSC 8 link- and
   wide-glyph-aware) and degrades per item: widest alt → narrowest alt → wrap to a fresh row →
   truncate the narrow alt with `…` when even that overflows a row on its own (any alt count —
   an unclipped over-wide item is exactly the hard-wrap this guards against). Width comes from
   `COLUMNS || stdout.columns || 80` — never a huge fallback (a `1e9` fallback once corrupted
   the terminal).
3. **U+2800 (Braille blank), not spaces, for indentation and blank rows.** CC strips leading
   whitespace and trailing blank rows; U+2800 renders blank but isn't whitespace.
4. **Never block the render on the network.** Slow data (OAuth usage API) is served from a
   TTL'd temp-file cache; a stale cache triggers a detached self-respawn
   (`CLAUDE_STATUSLINE_USAGE_REFRESH=1`) that refreshes out-of-band and exits before the stdin
   read. Cross-render state lives in `$TEMP/sl-*.json` files (usage cache,
   per-session accumulators).

### Layout conventions

- A row's content is a list of **segments**: plain strings, or `{ alts: [wide, narrow] }` where
  the packer uses `alts[0]` when the row fits and `alts[alts.length - 1]` when space is tight
  (bars and parenthesized detail go in the wide form only).
- `packSection(label, segments, lead, leadWidth, preferDetail, maxRows)` does the layout:
  all-widest on one line → all-narrowest on one line (skipped when `preferDetail`) → greedy
  per-item wrap, cut with `…` when `maxRows` is hit (only the height-cap squeeze loop passes
  `maxRows`). A finite `maxRows` flips the section into **squeeze mode**: items go narrow-first
  and the all-narrow probe runs even for `preferDetail` sections, because under a row budget a
  cut item is lost outright while a dropped bar or scope paren is only detail. The first item on
  an empty row always tries its narrow form, then truncates in place, before any wrap/cut — a
  row must never emit just its label and `…`. An empty segment list emits nothing (the slot
  backfills blank — rows like Turn/Activity disappear after `/clear`).
- Row **lead** glyphs render once before the first segment; pass the lead's true cell width —
  `vlen` guesses wrong for some glyphs in the user's terminal font.
- Section labels pad to `SECTION_WIDTH` (8) and render bold-italic-SOFT.

### Style conventions

- Colors are 256-color ANSI constants at the top of the file. `SOFT` (245) for labels/punctuation,
  `DIM` (244) for annotations and predictions, `VAL`/`WHITE` (97) for primary values; semantic
  colors (GREEN/YELLOW/RED, usageColor, contextColor) carry meaning — don't reuse them
  decoratively. Each row lead has its own hue; before introducing a color, grep `c256(` to
  confirm it's unused.
- Glyphs are Nerd Font codepoints declared as `g*` constants with the NF name in a comment.
  On the user's Windows font some Font Awesome glyphs render as tofu — Material Design (`nf-md-*`,
  `0xf0xxx`) codepoints are the safer choice; comments by existing glyphs note known exceptions.
- Comments throughout the file explain *why* (CC bugs, font quirks, API gotchas), and several
  encode hard-won diagnoses (e.g. the API-duration laptop-sleep artifact). Preserve and imitate
  that register; don't strip them when refactoring.

### Pace balance

Each Limits gauge appends a signed pace balance vs the even-consumption budget line
(`(elapsed/window)·100`, window start = `resets_at` − window length): `+N%` = quota in hand
(green), `-N%` = burning ahead (yellow), SOFT within ±2%, shown as soon as any time has elapsed
in the window (suppressed only for a degenerate just-reset window — matches usage-buttons'
PaceMetric). Kept to a few chars on purpose — the user wants it terse; don't expand it into words
("reserve"/"over pace") or give it a dedicated row.

### Test hygiene

Test renders share the real `$TEMP/sl-*.json` caches — clean up anything you seed with fake
data (`check.js` sandboxes `HOME`/`TEMP` for exactly this reason).

## plugins/context-bar

A **mod** (a plugin of function hooks, Claude Code 2.1.287+): `hooks/hooks.json` names
`hooks/register.ts` under `modules`; `types/index.d.ts` is the `$.state` contract the validator
holds the module to. Load the `plugin-authoring` skill before editing it — the API is the build's
`claude-code.d.ts`, and the static validator has rules of its own: helpers that take `$` must be
top-level function declarations (not closures inside `register`), `$` is always spelled
`$.noun.method(...)`, and every `$.state` key must be declared in the contract. Keep
`layout()`/`legend()` pure and exported so the tests can check the arithmetic without a drawing.
Verify with `claude plugin validate --strict plugins/context-bar` and
`claude plugin test plugins/context-bar` (no session needed); a real look in a terminal is still
needed for anything visual, since the test kit checks the tree, not the paint.

## plugins/session-color

Status-driven terminal background tint. `hooks/hooks.json` maps nine events to one of four state
words (`working` / `needs` / `done` / `reset`) — keep it in sync with the tables in the README and
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
Both locate `config.json` by walking up from the binary, which is why config, icons and webhook
templates live in the data dir next to the staged binary. Setup scripts never touch
`settings.json`; the Windows one owns the registry (protocol handlers HKCU, AUMID HKLM with UAC).
Linux is not implemented (plan: relay to the macOS/Windows notifier over SSH/WSL).

## What doesn't belong here

Forks of other people's plugins (the official discord channel plugin was briefly a subtree and
was taken out again): install those from their own marketplace. This repo holds only plugins
written here.
