#!/usr/bin/env bash
# notifications — macOS setup (run by the /notifications:setup skill)
#
#   bash setup.sh --data <CLAUDE_PLUGIN_DATA>              build + stage the .app bundle
#   bash setup.sh --data <CLAUDE_PLUGIN_DATA> --uninstall  remove it
#
# Builds the Swift binary, assembles it into a <Title>.app bundle (required for native
# UserNotifications), ad-hoc signs it, and stages the bundle in the plugin's persistent data dir.
# The hook dispatcher (hooks/notifications.sh) runs the binary from THERE: the plugin root is a
# per-version cache path that moves on every update, the data dir is stable.
#
# Two directories, split by who owns what:
#   $DATA  ${CLAUDE_PLUGIN_DATA} — rebuildable artifacts only (the .app, build/). `claude plugin
#          uninstall` deletes it, so nothing the user wrote may live here.
#   $CONF  $CLAUDE_CONFIG_DIR/notifications, else ~/.claude/notifications — the user's config.json,
#          icons/ and webhook templates. Never deleted by this script (not even by --uninstall).
#          The binary looks here first (baseDir in main.swift); relative config paths resolve
#          against it. A pre-1.1 setup kept these in $DATA; setup (and --uninstall) moves them over.
#
# --uninstall removes what setup put outside $CONF: the bundle (unregistered from LaunchServices
# first — macOS registers any .app it sees launched), the build dir, the /tmp state files, and the
# per-bundle-id containers Foundation creates on the app's behalf in ~/Library (URLSession cache +
# HTTP storage from the webhook, preferences). Claude Code runs no hook at plugin uninstall, so
# run it BEFORE `/plugin uninstall`.
#
# Never touches ~/.claude/settings.json: the hooks come from the plugin's hooks.json (and go away
# with `/plugin uninstall`). This replaces the old `notifications install` step.

set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"   # <plugin root>/macos
DATA=""
UNINSTALL=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --data) DATA="$2"; shift 2 ;;
        --uninstall|-u) UNINSTALL=1; shift ;;
        *) echo "Unknown argument: $1"; exit 1 ;;
    esac
done
[[ -n "$DATA" ]] || { echo "Usage: setup.sh --data <CLAUDE_PLUGIN_DATA> [--uninstall]"; exit 1; }

CONF="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/notifications"
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$SRC_DIR/Info.plist" 2>/dev/null || echo com.cchooks.notifications)"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

read_config() { # read_config <key> <default>  — top-level string from config.json
    python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], sys.argv[3]))" \
        "$CONF/config.json" "$1" "$2" 2>/dev/null || echo "$2"
}

# move_entry <src> <dst> — move a user file/dir from $DATA to $CONF unless $CONF already has it.
# Directories merge entry by entry; an identical duplicate (a re-seeded example template) is just
# dropped; a real conflict is left in place and reported — $CONF wins, and the $DATA copy dies
# with the data dir.
move_entry() {
    local src="$1" dst="$2" child
    if [[ ! -e "$dst" ]]; then
        mkdir -p "$(dirname "$dst")"
        mv "$src" "$dst"
        echo "Moved $src -> $dst"
    elif [[ -d "$src" && ! -L "$src" && -d "$dst" ]]; then
        for child in "$src"/* "$src"/.[!.]*; do
            [[ -e "$child" || -L "$child" ]] || continue
            move_entry "$child" "$dst/$(basename "$child")"
        done
        rmdir "$src" 2>/dev/null || true
    elif [[ -f "$src" && -f "$dst" ]] && cmp -s "$src" "$dst"; then
        rm -f "$src"
    else
        echo "Kept $dst; left the data-dir copy $src in place (it is deleted on plugin uninstall — merge it by hand if you need it)"
    fi
}

# Everything in $DATA that isn't a rebuildable artifact (*.app, build/) is the user's.
migrate_user_files() {
    [[ -d "$DATA" ]] || return 0
    local item name
    for item in "$DATA"/* "$DATA"/.[!.]*; do
        [[ -e "$item" || -L "$item" ]] || continue
        name="$(basename "$item")"
        case "$name" in *.app|build) continue ;; esac
        move_entry "$item" "$CONF/$name"
    done
}

if [[ $UNINSTALL -eq 1 ]]; then
    # Rescue config/icons a pre-1.1 setup left in the data dir before plugin uninstall deletes it.
    migrate_user_files
    # A notify handler may still be blocking on a visible notification.
    pkill -f "$DATA/.*\.app/Contents/MacOS/notifications" 2>/dev/null || true
    rm -f /tmp/claude-timer-* /tmp/claude-notifier-* 2>/dev/null || true
    shopt -s nullglob
    for app in "$DATA"/*.app; do
        [[ -x "$LSREGISTER" ]] && "$LSREGISTER" -u "$app" 2>/dev/null || true
        rm -rf "$app"; echo "Removed $app"
    done
    [[ -d "$DATA/build" ]] && { rm -rf "$DATA/build"; echo "Removed $DATA/build"; }
    # Foundation-created per-bundle-id state (no-ops when absent). `defaults delete` also drops
    # cfprefsd's cached copy, which would otherwise rewrite the plist we just deleted.
    defaults delete "$BUNDLE_ID" >/dev/null 2>&1 || true
    for p in "$HOME/Library/Caches/$BUNDLE_ID" "$HOME/Library/HTTPStorages/$BUNDLE_ID" \
             "$HOME/Library/HTTPStorages/$BUNDLE_ID.binarycookies" \
             "$HOME/Library/Preferences/$BUNDLE_ID.plist" \
             "$HOME/Library/Saved Application State/$BUNDLE_ID.savedState"; do
        [[ -e "$p" ]] && { rm -rf "$p"; echo "Removed $p"; }
    done
    echo "Done. Your config and icons in $CONF are kept on purpose (delete that folder yourself if you don't want them)."
    echo "Now run /plugin uninstall notifications@cc-plugins to remove the hooks and the data dir."
    echo "macOS keeps the app's entry under System Settings > Notifications; there's no supported way to remove it from a script."
    exit 0
fi

command -v swift >/dev/null 2>&1 || { echo "swift not found — install the Xcode Command Line Tools (xcode-select --install) and re-run."; exit 1; }

# User files: migrate from the data dir (pre-1.1 layout), then seed what's missing (never overwrite).
mkdir -p "$DATA" "$CONF/icons"
migrate_user_files
if [[ ! -f "$CONF/config.json" ]]; then
    cp "$SRC_DIR/config.json.example" "$CONF/config.json"
    echo "Created $CONF/config.json from the example — edit it to set terminal/editor/webhook"
fi
for tpl in "$SRC_DIR"/webhook.*.json.example; do
    [[ -f "$CONF/$(basename "$tpl")" ]] || cp "$tpl" "$CONF/"
done

TITLE="$(read_config title "CC Notification")"
APP_DIR="$DATA/$TITLE.app"
EXE="$APP_DIR/Contents/MacOS/notifications"

# Build — scratch path in the data dir so nothing lands in the per-version plugin root.
echo "Building..."
swift build -c release --package-path "$SRC_DIR" --scratch-path "$DATA/build/notifications" 2>&1 | tail -3

# Assemble the .app bundle (drop any stale bundle first, e.g. after a title change).
pkill -f "$DATA/.*\.app/Contents/MacOS/notifications" 2>/dev/null || true
shopt -s nullglob
for old in "$DATA"/*.app; do
    [[ -x "$LSREGISTER" ]] && "$LSREGISTER" -u "$old" 2>/dev/null || true
    rm -rf "$old"
done
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"
cp "$DATA/build/notifications/release/notifications" "$EXE"

# App icon, if present (configurable via icons.app in config.json; relative paths resolve against $CONF).
APP_ICON="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('icons', {}).get('app', 'icons/AppIcon.png'))" "$CONF/config.json" 2>/dev/null || echo "icons/AppIcon.png")"
[[ "$APP_ICON" == /* ]] || APP_ICON="$CONF/$APP_ICON"
if [[ -f "$APP_ICON" ]]; then cp "$APP_ICON" "$APP_DIR/Contents/Resources/AppIcon.png"; fi

# Info.plist with the configured title.
python3 -c "
import sys
with open(sys.argv[1]) as f: plist = f.read()
print(plist.replace('CC Notifications', sys.argv[2]), end='')
" "$SRC_DIR/Info.plist" "$TITLE" > "$APP_DIR/Contents/Info.plist"

codesign --force --sign - "$APP_DIR" || echo "Warning: ad-hoc code signing failed — notifications may not work correctly"

echo "Staged $APP_DIR"
echo "Config: $CONF/config.json (icons in $CONF/icons)"
echo "Done! Restart Claude Code to activate (the hooks are already registered by the plugin)."
echo "On first notification macOS asks for permission; optional: brew install terminal-notifier as a fallback."
