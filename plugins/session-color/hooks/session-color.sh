#!/bin/sh
# session-color — hook dispatcher. hooks.json runs this for every wired event with one argument,
# the state to paint (working | needs | done | reset); it hands off to the platform implementation.
#
# WHY A DISPATCHER: a plugin's hooks.json is one file for every OS, with no per-platform branching,
# while the tint is delivered three different ways (OSC 11 to the pane's pty on macOS, tmux-native
# pane style or OSC 11 on Linux, a ConPTY console attach from a native exe on Windows). `sh` is the
# one runtime every Claude Code install has — Git Bash provides it on Windows — so this stays a
# POSIX script, and it `exec`s the implementation so the process tree the implementations walk
# (up to the `claude` process, to find its tty / console) is unchanged.
#
# AGENTS: sub-agents and in-process agent-team teammates run inside the lead's Claude process, so
# their tool calls fire the lead's hooks (the hook input then carries `agent_id`) and would paint
# the lead's pane. The pane shows the LEAD's state: a background agent still calling tools after
# the lead's turn ended must not turn a green "your move" pane amber. So, per session:
#   - a lead event paints and is remembered as the session's state;
#   - an agent's PermissionRequest / Elicitation paints red — it does need you, whoever asked;
#   - an agent's next working event clears that red back to the lead's remembered state;
#   - any other agent event paints nothing.
# Split-pane teammates (tmux / iTerm2 teammate mode) are Claude processes of their own, each with
# its own pane and its own session — they paint their own pane as leads do.
#
# Always exits 0: a hook failure here must never surface in the session.
state="${1:-reset}"
here="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)" # the plugin root

# The hook input (JSON on stdin). Only two top-level string fields matter, so a match needs no jq:
# the FIRST occurrence (the envelope's own fields come before tool input and output), and a key
# quoted inside a string value is escaped (\"agent_id\") so it can't match.
input=""
[ -t 0 ] || input="$(cat 2>/dev/null)"
field() { printf '%s' "$input" | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/'; }
session="$(field session_id | tr -cd 'A-Za-z0-9_-')"
agent="$(field agent_id)"

# Per-session memory: the lead's last state, and whether an agent's red overlays it.
dir="${TMPDIR:-/tmp}"
memo="$dir/session-color-${session:-none}"
if [ -n "$session" ]; then
  if [ -n "$agent" ]; then
    case "$state" in
      needs) : > "$memo.agent-needs" 2>/dev/null ;;
      working)
        [ -f "$memo.agent-needs" ] || exit 0 # nothing of ours to clear
        rm -f "$memo.agent-needs" 2>/dev/null
        state="$(cat "$memo" 2>/dev/null)"
        state="${state:-working}"
        ;;
      *) exit 0 ;;
    esac
  else
    rm -f "$memo.agent-needs" 2>/dev/null
    if [ "$state" = reset ]; then rm -f "$memo" 2>/dev/null; else printf '%s' "$state" > "$memo" 2>/dev/null; fi
  fi
fi

case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*)
    # Windows: the Rust exe lives in the plugin's persistent data dir, where /session-color:setup
    # builds it (the plugin root is a per-version cache path, and it holds only source). Until
    # setup has run there's nothing to paint with — stay silent. The env var may carry backslashes;
    # MSYS sh is happier with forward slashes.
    data="$(printf '%s' "${CLAUDE_PLUGIN_DATA:-}" | tr '\\' '/')"
    exe="$data/session-color.exe"
    [ -n "$data" ] && [ -f "$exe" ] || exit 0
    exec "$exe" "$state"
    ;;
  Darwin) exec sh "$here/macos/session-color.sh" "$state" ;;
  Linux)  exec sh "$here/linux/session-color.sh" "$state" ;;
esac
exit 0
