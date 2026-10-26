#!/bin/sh
# CC Hooks — session-color
#
# Tint the terminal background by Claude Code session status, via OSC 11.
# Pure hooks: no launcher, no per-session theme files. Works in /tui fullscreen
# too — Claude inherits the terminal background rather than painting opaque
# cells, so an OSC 11 change to the pane's background shows through.
#
# THE CATCH this solves: hooks run WITHOUT a controlling terminal, so a naive
# `> /dev/tty` fails ("Device not configured") and the color never lands.
# Instead we walk up the process tree to the Claude process and write the escape
# to its real tty device (e.g. /dev/ttys003) — the terminal pane's pty. That
# makes the tint per-pane, so concurrent sessions never clobber each other.
#
# States (wired into ~/.claude/settings.json by install.sh):
#   working  amber   -> UserPromptSubmit, PostToolUse, PostToolUseFailure,
#                       ElicitationResult            (Claude is busy; you wait)
#   needs    red     -> PermissionRequest, Elicitation
#                                          (blocked: Claude needs a decision)
#   done     green   -> Stop               (turn finished / idle; your move)
#   reset    default -> SessionStart, SessionEnd
#
# Note: Notification is intentionally NOT wired. It fires for permission_prompt,
# idle_prompt, elicitation_*, and auth_success — every one already covered by a
# more specific event above (PermissionRequest, Elicitation, ElicitationResult,
# Stop). Coloring on it only double-paints; idle_prompt in particular would
# repaint an already-finished (green) session for no reason.
#
# Tweak the hex values below; dim tints keep text readable across the pane.
case "$1" in
  working) seq='\033]11;#574515\007' ;;   # amber — working
  needs)   seq='\033]11;#501d22\007' ;;   # red   — needs you (blocking)
  done)    seq='\033]11;#233f20\007' ;;   # green — done / idle, your move
  reset|*) seq='\033]111\007'        ;;   # reset bg to terminal default
esac

# Resolve the pane's tty: walk up the process tree to the NEAREST Claude Code process and take its
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
  case "$t" in ttys*|tty*|pts*) echo "/dev/$t" ;; esac
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

printf "$seq" > "$tty_dev" 2>/dev/null || true
