---
name: setup
description: Finish setting up the session-color plugin (status-driven terminal background tint). Needed on Windows only, where the hook is a Rust exe that has to be built once; on macOS and Linux the plugin works as soon as it's installed. Use when the user runs /session-color:setup, asks why the terminal isn't changing color after installing session-color, or wants to remove it (--uninstall).
argument-hint: "[--uninstall]"
allowed-tools: Bash(pwsh *), Bash(uname *), Bash(sh *)
---

# Set up session-color

The hooks themselves are registered by the plugin (`hooks/hooks.json`), so on **macOS and Linux
there is nothing to do**: the tint is live from the next Claude Code start. Tell the user that,
plus the one requirement for their platform:

- **macOS**: a terminal that honors OSC 11 background changes under the alternate screen
  (Ghostty does).
- **Linux**: inside tmux nothing extra (coloring is native `select-pane`, tmux 2.2+ for hex
  colors, with truecolor enabled: `set -g default-terminal "tmux-256color"` and
  `set -ag terminal-overrides ",xterm-256color:RGB"`). Outside tmux, a terminal that honors
  OSC 11 (VTE/GNOME Terminal, Kitty, Alacritty, WezTerm, Ghostty).

With `--uninstall` on macOS/Linux, reset the current pane by running the plugin's own reset:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/hooks/session-color.sh" reset
```

(Not a bare `printf '\033]111\007'`: Claude captures the Bash tool's stdout, so an escape
printed there never reaches the terminal, and inside tmux the tint is a pane style that OSC 111
doesn't clear anyway. The implementation writes to the pane's real tty / resets the tmux pane
style.) Nothing else is left outside the plugin on macOS/Linux — no files, no settings. Then tell
the user to run `/plugin uninstall session-color@cc-plugins` to remove the hooks.

## Windows

The Windows implementation is a native exe (it has to `AttachConsole` to the pane's ConPTY to get
the escape through — hook stdout never reaches the terminal). It must be built once with Rust and
is staged into the plugin's persistent data directory, where the dispatcher looks for it. Until
then the hooks are silent no-ops.

Requires [Rust](https://rustup.rs/) and PowerShell 7 (`pwsh`), and Windows Terminal on a recent
Windows 11 build (older ConPTY swallows OSC 11). Run:

```bash
pwsh -NoProfile -File "${CLAUDE_PLUGIN_ROOT}/windows/setup.ps1" -Data "${CLAUDE_PLUGIN_DATA}"
```

For `--uninstall`, add `-Uninstall` to that command (resets this pane's tint through the exe,
then removes it and its build dir; the hooks go with `/plugin uninstall session-color@cc-plugins`).
Run it BEFORE the plugin uninstall — Claude Code runs no hook at uninstall, and once the plugin's
gone there's no exe left to reset a tinted pane with.

On every platform, panes of OTHER running sessions stay tinted until those sessions end (their
SessionEnd hook resets them) or are restarted; say so.

Show the script's output verbatim and tell the user to restart Claude Code. If `cargo` is
missing, point them at https://rustup.rs/ and stop.
