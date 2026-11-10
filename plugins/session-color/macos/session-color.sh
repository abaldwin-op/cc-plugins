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
#   done     green   -> Stop               (turn finished; your move)
#   failed   orange  -> StopFailure        (the turn ended on an API error: rate
#                                          limit, overload, auth; it did NOT finish)
#   idle     blue    -> Notification/idle_prompt   (done, gone cold: ~60s idle
#                                          after a finished turn; the dispatcher
#                                          lets it through only from done)
#   reset    default -> SessionStart, SessionEnd
#
# Note: of Notification's types only idle_prompt is wired. permission_prompt,
# elicitation_* and auth_success are each covered by a more specific event above
# (PermissionRequest, Elicitation, ElicitationResult); coloring on them only
# double-paints.
#
# Tweak the hex values below; dim tints keep text readable across the pane.
case "$1" in
  working) seq='\033]11;#574515\007' ;;   # amber — working
  needs)   seq='\033]11;#501d22\007' ;;   # red   — needs you (blocking)
  done)    seq='\033]11;#233f20\007' ;;   # green — done, your move
  failed)  seq='\033]11;#5c2e0e\007' ;;   # orange — turn died on an API error
  idle)    seq='\033]11;#1d3150\007' ;;   # blue  — done, gone cold
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

# A pane already cleared as seen that now goes idle (still unanswered a minute on) turns blue
# only if the user has left it: the watcher looks first and paints, or doesn't (see SEEN).
defer=0
[ "$1" = idle ] && [ "${SESSION_COLOR_WAS:-}" = seen ] && defer=1
paint() { printf "$seq" > "$tty_dev" 2>/dev/null || true; }
[ "$defer" = 1 ] || paint

# SEEN: green and blue are for panes you aren't at. Once you are at one — its pane focused in the
# frontmost window, with input in the last ten seconds, on two checks running (a second apart
# while the terminal is frontmost: 1–2 s from arriving, in step with the notification) — it returns to the default background (never
# sooner than SEEN_AFTER seconds after the turn finished, so the green registers). Focus alone isn't attention: passing through a pane on the way to another doesn't clear
# it, and a pane left focused while you're away keeps its tint (and cools to blue as usual) until
# you're back at the keyboard. The notifications plugin clears its notification by the same test.
#
# Hooks can't see focus, so a finished pane gets a small detached watcher, alive only while the
# session's remembered state is `done` or `idle` (the next prompt, SessionEnd or Claude exiting
# ends it). One watcher serves both: started at done, it carries what it has seen across the
# change to idle, and `$memo.watch` holds its pid so idle doesn't start a second one.
#
# It needs two things from the terminal: which pane is OURS, and which pane is FOCUSED.
#   Herdr         ours: HC_TERMINAL_ID -> its pane, from `herdr-app ls`   focused: `herdr-app status`
#   iTerm2        ours: ITERM_SESSION_ID (the part after ":")            focused: AppleScript
#   Terminal.app  ours: the pane's tty                                    focused: AppleScript
#   WezTerm       ours: WEZTERM_PANE                                      focused: `wezterm cli`
#   Ghostty       ours: no id in the environment and none by tty, so the pane is asked to name
#                 itself once per session — a title carrying a nonce goes to its tty and the
#                 terminal showing it is ours (a pinned `title` in Ghostty's config defeats this)
#                                                                         focused: AppleScript
# Anything else — and anything inside tmux, where the pane is tmux's and the outer terminal can't
# say which one is showing — keeps its tint until the next prompt.
#
# COST: a wall of finished panes means a wall of watchers, so the answer to "which pane is
# focused" is shared: whoever asks first writes it to a file the others read for the next
# second. One query per terminal app per second however many panes wait, and none at all unless
# that app is frontmost (two lsappinfo calls say so, every 2 s while it isn't). The idle time is read last, only for a
# pane that is frontmost and focused.
tmp="${TMPDIR:-/tmp}"

# pane_kind: which terminal this is, from the environment alone (cheap: decides whether to watch).
# Herdr first — its terminals inherit TERM_PROGRAM from whatever shell started its daemon.
pane_kind=""
if [ -n "${HC_TERMINAL_ID:-}" ]; then pane_kind=herdr
elif [ -n "${TMUX:-}" ]; then pane_kind=""
else
  case "${TERM_PROGRAM:-}" in
    ghostty) pane_kind=ghostty ;;
    iTerm.app) pane_kind=iterm ;;
    Apple_Terminal) pane_kind=terminal ;;
    WezTerm) pane_kind=wezterm ;;
  esac
fi

tool() { # tool <name> <fallback path> — a CLI that may not be on a hook's PATH
  t=$(command -v "$1" 2>/dev/null)
  [ -n "$t" ] || t="$2"
  [ -x "$t" ] && echo "$t"
}

# Ghostty: the pane names itself. Runs in the watcher, never in the hook (it takes a moment).
ghostty_pane_id() { # ghostty_pane_id <tty>
  osascript - "$1" "session-color-$$-$(date +%s)" 2>/dev/null <<'APPLESCRIPT'
on title(theTty, theTitle)
    do shell script "printf '\\033]2;%s\\007' " & quoted form of theTitle & " > " & quoted form of theTty
end title
on run argv
    set theTty to item 1 of argv
    set nonce to item 2 of argv
    tell application "Ghostty"
        set ids to id of every terminal
        set names to name of every terminal
    end tell
    set found to ""
    repeat 5 times
        my title(theTty, nonce)
        delay 0.05
        tell application "Ghostty"
            try
                set found to id of (first terminal whose name is nonce)
            end try
        end tell
        if found is not "" then exit repeat
    end repeat
    if found is "" then return ""
    repeat with i from 1 to count of ids
        if item i of ids is found then my title(theTty, item i of names)
    end repeat
    return found
end run
APPLESCRIPT
}

# own_pane: this session's pane, in the terminal's own terms. Empty -> nothing to watch for.
own_pane() {
  case "$pane_kind" in
    herdr)
      "$cli" ls 2>/dev/null | awk -v t="\"$HC_TERMINAL_ID\"" '
        $1 == "\"terminal\":" && $2 == t "," { f = 1 }
        f && $1 == "\"pane\":" { gsub(/[",]/, "", $2); print $2; exit }' ;;
    iterm) echo "${ITERM_SESSION_ID#*:}" ;;
    terminal) echo "$tty_dev" ;;
    wezterm) echo "${WEZTERM_PANE:-}" ;;
    ghostty)
      id=$(cat "$SESSION_COLOR_MEMO.pane" 2>/dev/null)
      if [ -z "$id" ]; then
        id=$(ghostty_pane_id "$tty_dev")
        [ -n "$id" ] && printf '%s' "$id" > "$SESSION_COLOR_MEMO.pane" 2>/dev/null
      fi
      echo "$id" ;;
  esac
}

frontmost() { # is our terminal app the one in front?
  f=$(lsappinfo info -only name,bundleid "$(lsappinfo front 2>/dev/null)" 2>/dev/null)
  case "$pane_kind:$f" in
    herdr:*Herdr*|herdr:*herdr-app*) return 0 ;; # no bundle id when started as `herdr-app`
    ghostty:*com.mitchellh.ghostty*) return 0 ;;
    iterm:*com.googlecode.iterm2*) return 0 ;;
    terminal:*com.apple.Terminal*) return 0 ;;
    wezterm:*com.github.wez.wezterm*) return 0 ;;
  esac
  return 1
}

# focused_pane: the focused pane(s) of the frontmost window, one per line, shared between
# watchers (see COST). Only called while the app is frontmost, so `tell application` never
# launches one.
focused_pane() { # focused_pane <max age, seconds>
  cache="$tmp/session-color-focus-$pane_kind"
  age=$(( $(date +%s) - $(stat -f %m "$cache" 2>/dev/null || echo 0) ))
  if [ "$age" -ge "$1" ] || [ "$age" -lt 0 ]; then
    touch "$cache" 2>/dev/null # claim it: watchers waking in the same instant read the last answer
    case "$pane_kind" in
      herdr) "$cli" status | sed -n 's/.*"focused_pane": *"\([^"]*\)".*/\1/p' ;;
      ghostty) osascript -e 'tell application "Ghostty" to return id of focused terminal of selected tab of front window' ;;
      iterm) osascript -e 'tell application "iTerm2" to return id of current session of current tab of current window' ;;
      terminal) osascript -e 'tell application "Terminal" to return tty of selected tab of front window' ;;
      wezterm) "$cli" cli list-clients --format json | sed -n 's/.*"focused_pane_id": *\([0-9]*\).*/\1/p' ;;
    esac 2>/dev/null > "$cache.$$"
    mv -f "$cache.$$" "$cache" 2>/dev/null
  fi
  cat "$cache" 2>/dev/null
}

at_keyboard() { # input within the last ten seconds
  idle=$(ioreg -c IOHIDSystem 2>/dev/null | awk '/HIDIdleTime/ { print int($NF / 1000000000); exit }')
  [ "${idle:-999}" -lt 10 ]
}

# Seconds of waiting before a finished pane may lose its tint, however closely it is being
# watched. The checks between the waits take time too, so 4 comes out near 5 s on the clock —
# which is when the notifications plugin's notification leaves (4 s from being posted, about a
# second after the turn ends), so that the two go together.
SEEN_AFTER=4

watch_seen() { # uses tty_dev, claude_pid, pane_kind, cli, SESSION_COLOR_MEMO
  memo="$SESSION_COLOR_MEMO"
  pane=$(own_pane)
  if [ "$defer" = 1 ]; then
    # Seen, and still here: stay clear. Otherwise it has gone cold after all.
    if [ -n "$pane" ] && frontmost && focused_pane 2 | grep -qxF "$pane" && at_keyboard; then
      printf seen > "$memo" 2>/dev/null
      return 0
    fi
    paint
  fi
  [ -n "$pane" ] || return 0
  hits=0; t=0; nap=2
  while [ "$t" -lt 86400 ]; do # a day, at most
    # Every second while our terminal is in front — arriving at the pane should clear it as
    # promptly as the notification — and every other second while it isn't.
    sleep "$nap"; t=$((t + nap))
    case "$(cat "$memo" 2>/dev/null)" in done|idle) ;; *) return 0 ;; esac
    [ -z "$claude_pid" ] || kill -0 "$claude_pid" 2>/dev/null || return 0
    if frontmost; then nap=1; else nap=2; hits=0; continue; fi
    if focused_pane 1 | grep -qxF "$pane" && at_keyboard; then hits=$((hits + 1)); else hits=0; fi
    # two checks running: not just passing through; and the tint has had its time on screen
    [ "$hits" -ge 2 ] && [ "$t" -ge "$SEEN_AFTER" ] || continue
    case "$(cat "$memo" 2>/dev/null)" in done|idle) ;; *) return 0 ;; esac
    # `seen`, not removed: an agent's red must still have a lead state to fall back to, and every
    # implementation paints an unknown state as reset.
    printf seen > "$memo" 2>/dev/null
    printf '\033]111\007' > "$tty_dev" 2>/dev/null
    return 0
  done
}

case "$1" in done|idle) ;; *) exit 0 ;; esac
unwatched() { [ "$defer" = 1 ] && paint; exit 0; } # nobody to look first: blue it is
[ -n "$pane_kind" ] && [ -n "${SESSION_COLOR_MEMO:-}" ] || unwatched
watcher=$(cat "$SESSION_COLOR_MEMO.watch" 2>/dev/null)
[ -n "$watcher" ] && kill -0 "$watcher" 2>/dev/null && unwatched
cli=""
case "$pane_kind" in
  herdr) cli=$(tool herdr-app "$HOME/.local/bin/herdr-app"); [ -n "$cli" ] || unwatched ;;
  wezterm) cli=$(tool wezterm /Applications/WezTerm.app/Contents/MacOS/wezterm); [ -n "$cli" ] || unwatched ;;
esac
claude_pid=""
is_claude "${pid:-0}" && claude_pid=$pid
{ watch_seen; rm -f "$SESSION_COLOR_MEMO.watch"; } </dev/null >/dev/null 2>&1 &
echo $! > "$SESSION_COLOR_MEMO.watch" 2>/dev/null
