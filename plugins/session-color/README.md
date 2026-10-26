# Session Color

Tint the terminal background by [Claude Code](https://claude.com/product/claude-code) session status, so you can tell at a glance — across a wall of panes — which session is working, which needs you, and which is done.

<img width="30%" alt="working — amber" src="https://github.com/user-attachments/assets/ed8736db-05dd-4cb4-8418-e60c32ea8f3b" />
<img width="30%" alt="needs you — red" src="https://github.com/user-attachments/assets/cde1bc8e-248f-456c-b5f4-57f06c34f78d" />
<img width="30%" alt="done — green" src="https://github.com/user-attachments/assets/48705014-a675-432c-9d19-d19f253e2a1c" />

| State | Color | Fires on |
|-------|-------|----------|
| 🟡 **working** | amber | `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `ElicitationResult` |
| 🔴 **needs you** | red | `PermissionRequest`, `Elicitation` |
| 🟢 **done / idle** | green | `Stop` |
| ⬛ **reset** | default | `SessionStart`, `SessionEnd` |

It flips **back** to amber after a red prompt (via `PostToolUse`), so a session that asked for permission mid-task doesn't get stuck looking like it still needs you.

Red is reserved for *actual* blocking decisions (`PermissionRequest`, `Elicitation`). The `Notification` event is deliberately left unwired: it fires for `permission_prompt`, `idle_prompt`, `elicitation_*`, and `auth_success` — every one already covered by a more specific event above. In particular `idle_prompt` (idle ~60s after finishing) would just repaint an already-green session, so coloring on `Notification` adds nothing but conflicts.

## Install

```
/plugin marketplace add anthonybaldwin/cc-plugins
/plugin install session-color@cc-plugins
```

The hooks are registered by the plugin itself. On **macOS and Linux** that's it — restart Claude Code. On **Windows** run `/session-color:setup` once to build the native exe (see below).

## How it works

The tint is a single [OSC 11](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h3-Operating-System-Commands) escape (`ESC ] 11 ; #rrggbb BEL`) written to the terminal. The catch, on every platform, is *getting the escape to the right pane*: hooks run with their stdout captured by Claude Code and **without a controlling terminal**, so a naive `printf ... > /dev/tty` fails (`Device not configured`) and the color silently never lands.

`hooks/session-color.sh` is a tiny POSIX dispatcher (one `hooks.json` serves every OS) that hands the state word to the platform implementation:

- **macOS** (`macos/session-color.sh`) — walks up the process tree to the *nearest* Claude process and writes the escape to *its* real tty device (the pane's pty, e.g. `/dev/ttys003`). Per-pane, so concurrent sessions never clobber each other. Fullscreen-safe: in `/tui fullscreen` Claude draws on the alternate screen but inherits the background rather than painting opaque cells, so the tint shows through (confirmed in [Ghostty](https://ghostty.org/)).
- **Linux** (`linux/session-color.sh`) — same tty walk, but **tmux-aware**: inside tmux raw OSC 11 escapes get intercepted and don't reliably reach the pane, so it maps the resolved pty to its tmux pane id and colors it natively with `tmux select-pane -P bg=…`. Outside tmux it falls back to OSC 11 on the pty.
- **Windows** (`windows/`, Rust) — there is no `/dev/tty`. The exe walks up the process tree to the `claude` process, `AttachConsole()`s to **its** console — the pane's pseudoconsole ([ConPTY](https://devblogs.microsoft.com/commandline/windows-command-line-introducing-the-windows-pseudo-console-conpty/)) — and writes the escape to `CONOUT$`. ConPTY relays it to the terminal; per-pane for free.

### Agents, agent teams and background sessions

- **Sub-agents and in-process teammates** run inside the lead's Claude process, so their tool calls
  fire the lead's hooks. The pane shows the **lead's** state. An agent still calling tools after the
  lead's turn ended doesn't turn a green "your move" pane amber. An agent that needs a permission
  or an answer still turns it red, and once it carries on, the pane goes back to the lead's state.
  The dispatcher tells them apart by the hook input's `agent_id` and remembers the lead's last state
  per session in a small file in `$TMPDIR`, which `SessionEnd` removes.
- **Split-pane teammates** (tmux or iTerm2 teammate mode) are Claude processes of their own, each in
  its own pane. Each tints its own pane.
- **Background sessions** (`claude agents`, detached agents) have no terminal. The tree walk stops
  at the nearest Claude process. If that process has no terminal, nothing is painted. In 1.0.1 the
  walk climbed past it and could tint the pane of the session that started it.

### Windows setup

The exe has to be built once with [Rust](https://rustup.rs/) (PowerShell 7 `pwsh` runs the script). `/session-color:setup` does it:

```
/session-color:setup
```

It builds `session-color.exe` and stages it in the plugin's persistent data directory (`~/.claude/plugins/data/…`), which is where the dispatcher runs it from — the plugin's own install path changes with every version, the data directory doesn't. Until setup has run the hooks are silent no-ops. Needs [Windows Terminal](https://github.com/microsoft/terminal) on a recent Windows 11 build: older ConPTY swallows OSC 11, in which case the tint silently won't appear.

### Requirements

- **macOS**: a terminal that honors OSC 11 under the alternate screen (e.g. Ghostty).
- **Linux**: under tmux, 2.1+ (hex colors need 2.2+) with truecolor on so the tints land faithfully:
  ```tmux
  # ~/.tmux.conf
  set -g default-terminal "tmux-256color"
  set -ag terminal-overrides ",xterm-256color:RGB"
  ```
  Over SSH nothing extra — `TERM` rides the pty, so as long as the server has the `tmux-256color` terminfo, color just works. Outside tmux, any emulator that honors OSC 11 (VTE/GNOME Terminal, Kitty, Alacritty, WezTerm, Ghostty); `xterm` honors it but not under the alt-screen.
- **Windows**: Windows Terminal, recent Windows 11, Rust to build.

## Uninstall

Claude Code runs no hook when a plugin is uninstalled, so reset first:

```
/session-color:setup --uninstall
/plugin uninstall session-color@cc-plugins
```

`--uninstall` resets the current pane's tint (through the plugin's own implementation — a `printf` from Claude's Bash tool never reaches the terminal, and inside tmux the tint is a pane style OSC 111 doesn't clear) and, on Windows, removes the staged exe and its build directory. Plugin uninstall then removes the hooks and the data directory. Nothing else is left behind: no registry entries, no `settings.json` changes, no temp files.

Panes of other sessions still running at uninstall stay tinted until those sessions end. To reset one by hand: `printf '\033]111\007'` typed in that pane's shell, or in tmux `tmux select-pane -t <pane> -P bg=default`.

## Customizing

Edit the hex values at the top of `macos/session-color.sh` / `linux/session-color.sh`, or in `paint()` in `windows/src/main.rs` (then re-run `/session-color:setup` to rebuild). Keep them dim — they fill the whole pane, so bright values hurt text contrast.

```sh
case "$1" in
  working) seq='\033]11;#574515\007' ;;   # amber — working
  needs)   seq='\033]11;#501d22\007' ;;   # red   — needs you (blocking)
  done)    seq='\033]11;#233f20\007' ;;   # green — done / idle
  reset|*) seq='\033]111\007'        ;;   # reset bg to terminal default
esac
```

To change which status a given event maps to, edit `hooks/hooks.json` (one entry per event; the argument is the state). Plugin edits apply on the next session or `/reload-plugins` when the checkout is added as a local marketplace; for marketplace installs bump `version` in `.claude-plugin/plugin.json`.
