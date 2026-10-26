---
name: setup
description: Build and stage the native notification binary for the notifications plugin (Windows WinRT toasts / macOS UserNotifications), seed its config, and register the Windows protocol handlers. Use when the user runs /notifications:setup, asks why no notifications appear after installing the plugin, wants to change where config.json lives, or wants to remove it (--uninstall).
argument-hint: "[--uninstall]"
allowed-tools: Bash(pwsh *), Bash(bash *), Bash(uname *), Bash(cat *)
---

# Set up notifications

The hooks are registered by the plugin (`hooks/hooks.json`), but they run a **native binary** that
has to be built once on this machine and staged into the plugin's persistent data directory —
the plugin's own install path changes with every version, and the registry entries / app bundle
must point somewhere stable. Until setup has run, the hooks are silent no-ops.

Pick the platform with `uname -s`:

## macOS (Darwin)

Requires macOS 12+ and Swift 5.9+ (`xcode-select --install`). Run:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/macos/setup.sh" --data "${CLAUDE_PLUGIN_DATA}" $ARGUMENTS
```

It builds the Swift binary, assembles and ad-hoc signs a `<Title>.app` bundle in the data
directory, and seeds `config.json` + the webhook templates into `~/.claude/notifications/` if
missing (moving them over from the data directory first if an older setup left them there).

## Windows (MINGW / MSYS)

Requires [Rust](https://rustup.rs/) and PowerShell 7 (`pwsh`). Run:

```bash
pwsh -NoProfile -File "${CLAUDE_PLUGIN_ROOT}/windows/setup.ps1" -Data "${CLAUDE_PLUGIN_DATA}" $ARGUMENTS
```

(For `--uninstall`, pass `-Uninstall` instead.) It builds `notifications.exe`, stages it, seeds
`config.json` + webhook templates into `%USERPROFILE%\.claude\notifications\` (moving them over
from the data directory first if an older setup left them there), registers the
`claude-focus://` / `claude-editor://` protocol handlers at the staged exe, and registers the toast
AUMID — a UAC prompt appears for the icon registry entry; declining still works, just no icon on
toasts.

## Linux

Not implemented yet (the plan is to relay to the macOS/Windows notifier over SSH/WSL). Say so and
stop.

## After setup

Show the script's output verbatim, then tell the user:

- Config is at `~/.claude/notifications/config.json` (`$CLAUDE_CONFIG_DIR/notifications/` if that
  is set; the script prints the path) — title, editor, terminal on macOS, sound, per-type
  messages, webhook. Icons go in `icons/` next to it. It lives outside the plugin's data directory
  on purpose, so it survives plugin updates AND uninstall.
- Restart Claude Code to activate. On macOS the first notification prompts for permission.

## Uninstalling

Claude Code runs no hook when a plugin is uninstalled, so the order matters:

1. `/notifications:setup --uninstall` — removes everything setup created outside the config dir:
   the staged exe / `.app` and build dir; on Windows the protocol handlers, the AUMID registry
   keys (UAC prompt for the HKLM one) and Windows' per-app notification settings; on macOS the
   LaunchServices registration and the app's `~/Library` caches/preferences.
2. `/plugin uninstall notifications@cc-plugins` — removes the hooks and the data directory.

Skipping step 1 on Windows orphans the registry entries (they keep pointing at a deleted exe).
`~/.claude/notifications/` (config, icons, webhook templates) is kept on purpose; tell the user to
delete it by hand if they want it gone.

If the build tool is missing, point at the install link above and stop.
