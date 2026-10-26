#!/bin/sh
# CC Hooks — session-color (Linux, tmux-aware)
#
# Tint the terminal background by Claude Code session status.
#
# Inside tmux we color the pane natively with `select-pane -P bg=...`. tmux
# intercepts raw OSC 11 escapes, so writing them to the pane's pty is
# unreliable — the native pane style is the tmux-friendly path, and it's
# per-pane, so concurrent sessions in other panes are never touched.
#
# Outside tmux we fall back to a single OSC 11 escape written to the pane's
# real tty (resolved by walking up the process tree, since hooks run without a
# controlling terminal).
#
# States (wired into ~/.claude/settings.json by install.sh):
#   working  amber   -> UserPromptSubmit, PostToolUse, PostToolUseFailure,
#                       ElicitationResult            (Claude is busy; you wait)
#   needs    red     -> PermissionRequest, Elicitation
#                                          (blocked: Claude needs a decision)
#   done     green   -> Stop               (turn finished / idle; your move)
#   reset    default -> SessionStart, SessionEnd
#
# Tweak the hex values below; dim tints keep text readable across the pane.
case "$1" in
  working) col='#574515' ;;   # amber — working
  needs)   col='#501d22' ;;   # red   — needs you (blocking)
  done)    col='#233f20' ;;   # green — done / idle, your move
  reset|*) col='default' ;;   # reset bg to terminal/tmux default
esac

# Resolve the pane's tty (`ps -o tty=` gives it without /dev, e.g. "pts/3"; "?" is none): walk up the process tree to the NEAREST Claude Code process and take its
# tty. Stopping there matters: a background session (`claude agents`, a detached agent) has no tty
# of its own, and climbing past it would reach the terminal of whichever session launched it and
# paint THAT pane with the background session's state. A Claude with no tty → nothing to paint.
# Only when no Claude ancestor exists at all (run by hand) does the first ancestor with a tty do.
# Claude by its executable (the native build), or a node/bun running the npm package's CLI. Only
# argv[0] and argv[1] are looked at: a shell whose command line merely MENTIONS a claude path (a hook
# command, a snapshot) is not Claude.
is_claude() {
  c=$(ps -o comm= -p "$1" 2>/dev/null)
  case "${c##*/}" in claude) return 0 ;; esac
  set -- $(ps -o args= -p "$1" 2>/dev/null)
  case "${1##*/}" in
    claude) return 0 ;;
    node|bun) case "${2:-}" in *claude*) return 0 ;; esac ;;
  esac
  return 1
}
tty_of() {
  t=$(ps -o tty= -p "$1" 2>/dev/null | tr -d ' ')
  case "$t" in pts/*|tty*|ttys*) echo "/dev/$t" ;; esac
}
tty_dev=""
first_tty=""
pid=$$
while [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null; do
  [ -z "$first_tty" ] && first_tty=$(tty_of "$pid")
  if is_claude "$pid"; then
    tty_dev=$(tty_of "$pid")
    [ -n "$tty_dev" ] || exit 0
    break
  fi
  pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
done
[ -z "$tty_dev" ] && tty_dev="${first_tty:-/dev/tty}"

# Inside tmux: color the matching pane natively. Map our tty to a pane id so we
# only touch this session's pane.
if [ -n "$TMUX" ] && command -v tmux >/dev/null 2>&1 && [ -n "$tty_dev" ]; then
  pane=$(tmux list-panes -a -F '#{pane_tty} #{pane_id}' 2>/dev/null \
         | awk -v t="$tty_dev" '$1 == t { print $2; exit }')
  if [ -n "$pane" ]; then
    tmux select-pane -t "$pane" -P "bg=$col" 2>/dev/null || true
    exit 0
  fi
fi

# Outside tmux (or pane not found): OSC 11 to the pane's tty.
if [ "$col" = "default" ]; then
  printf '\033]111\007' > "$tty_dev" 2>/dev/null || true
else
  printf '\033]11;%s\007' "$col" > "$tty_dev" 2>/dev/null || true
fi
