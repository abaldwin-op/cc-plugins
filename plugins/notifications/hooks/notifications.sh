#!/bin/sh
# notifications — hook dispatcher. hooks.json runs this with the binary's subcommand and args
# (on-submit | notify notification | notify stop | on-end); it execs the native implementation
# that /notifications:setup built into the plugin's persistent data dir:
#
#   Windows  $CLAUDE_PLUGIN_DATA/notifications.exe            (Rust, WinRT toasts)
#   macOS    $CLAUDE_PLUGIN_DATA/<Title>.app/Contents/MacOS/notifications   (Swift, UserNotifications;
#            the .app bundle name comes from config.json's "title", so it's globbed)
#   Linux    not implemented yet — the plan is to relay to the macOS/Windows notifier over
#            SSH/WSL rather than reimplement natively. Silent no-op.
#
# WHY THE DATA DIR: the plugin root is a per-version cache path that moves on every update, and the
# binaries are referenced from outside the plugin too (Windows protocol handlers in the registry,
# the macOS .app bundle identity). The data dir is stable across updates — but `claude plugin
# uninstall` deletes it, so it holds only rebuildable artifacts. The user's config.json, icons/ and
# webhook templates live in ~/.claude/notifications/ ($CLAUDE_CONFIG_DIR/notifications), which the
# binaries check first.
#
# `exec` keeps the process tree intact (the implementations walk up to `claude` / Windows Terminal
# for tty, pane and UI-Automation targeting) and hands the hook's stdin JSON straight through.
# Always exits 0 when there's nothing to run: a missing binary must never surface in the session.
data="$(printf '%s' "${CLAUDE_PLUGIN_DATA:-}" | tr '\\' '/')"
[ -n "$data" ] || exit 0

case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*)
    exe="$data/notifications.exe"
    [ -f "$exe" ] || exit 0
    exec "$exe" "$@"
    ;;
  Darwin)
    for app in "$data"/*.app; do
      exe="$app/Contents/MacOS/notifications"
      [ -x "$exe" ] && exec "$exe" "$@"
    done
    ;;
esac
exit 0
