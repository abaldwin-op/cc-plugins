# Notifications

Native desktop notifications for [Claude Code](https://claude.com/product/claude-code) — Windows (WinRT toasts, Rust) and macOS (UserNotifications, Swift).

<img width="360" height="164" alt="macOS notification" src="https://github.com/user-attachments/assets/2440aaf1-2743-44ac-ac4e-996badfce202" /> <br>
<img width="352" height="90" alt="macOS notification, compact" src="https://github.com/user-attachments/assets/54159d33-c3ca-4719-9058-f265e70014fe" />

## What it does

When Claude finishes or needs input, you get a notification showing:

- **Project directory** and **elapsed time** (e.g., "Task completed (12s)"), and on macOS the **session** — its `/rename` name, else the short session id
- Clicking it (macOS) or the **Focus Terminal** button (Windows) focuses the originating **window/tab/pane**:
  - Windows Terminal: UI Automation switches to the correct tab (preserves snap/maximize layout)
  - Ghostty: the pane's terminal ID, found once per session by briefly tagging the pane's title through Claude's tty (so panes sharing a directory, or tabs dragged to another window, still resolve); raises the pane's window first, so a fullscreen Space or Stage Manager stage comes forward. Only without an ID (Ghostty `title` pinned in its config, tmux): CWD, when exactly one pane matches
  - iTerm2: session ID → CWD+name → prefix CWD · WezTerm: pane ID via CLI · Terminal.app: tty → process name
- **Open in Editor** button — opens the project directory in your configured editor
- Notifications replace by session (no stacking), and go away with their session: SessionEnd clears them, and a session that dies without one (pane closed, crash) is noticed by its waiting notifier and swept on the next notification. Clicking one whose session is gone does nothing rather than focus a wrong pane (macOS)
- Optional **webhook** — JSON POST to Discord, Slack, ntfy, Gotify… when you're AFK (screen locked / idle)
- Configurable sound, per-type messages and icons
- Skips IDE terminals (VS Code, Zed, Cursor) — only fires in standalone terminals
- macOS falls back to [terminal-notifier](https://github.com/julienXX/terminal-notifier), then `osascript`, if native notifications are unavailable

### Why not just use…

**Built-in terminal notifications?** [Windows Terminal](https://aka.ms/terminal) doesn't support Claude Code's [desktop notifications](https://code.claude.com/docs/en/terminal-config#notification-setup). [Ghostty](https://ghostty.org/) notifications from a split pane [open a new window](https://github.com/ghostty-org/ghostty/discussions/10445) instead of focusing the originating pane. [WezTerm](https://wezfurlong.org/wezterm/) clicking only brings the window to the foreground, not the tab or pane ([PR #7643](https://github.com/wez/wezterm/pull/7643) is open on Windows). [iTerm2](https://iterm2.com/)'s focus the correct pane but offer no elapsed time or editor integration.

**[BurntToast](https://github.com/Windos/BurntToast) / terminal-notifier / `osascript display notification`?** PowerShell startup cost on every hook, no session awareness, or no click actions respectively. This plugin uses the WinRT and UserNotifications APIs directly from a compiled binary.

## Install

```
/plugin marketplace add anthonybaldwin/cc-plugins
/plugin install notifications@cc-plugins
/notifications:setup
```

The plugin registers the hooks; `/notifications:setup` builds the native binary for your platform and stages it in the plugin's persistent data directory (`~/.claude/plugins/data/…`). That directory is stable across plugin updates, which matters because the Windows protocol handlers and the macOS `.app` bundle are referenced from outside the plugin; the plugin's own install path changes with every version. Until setup has run the hooks are silent no-ops.

- **Windows**: [Rust](https://rustup.rs/) + PowerShell 7 (`pwsh`). Setup builds `notifications.exe`, registers the `claude-focus://` / `claude-editor://` protocol handlers (HKCU) and the toast AUMID (HKLM — a UAC prompt; declining still works, just no icon on toasts).
- **macOS**: macOS 12+, Swift 5.9+ (`xcode-select --install`). Setup builds, assembles a `<Title>.app` bundle (required for native notifications) and ad-hoc signs it. Optional: `brew install terminal-notifier` as a fallback.
- **Linux**: not implemented yet. The plan is to relay Linux (SSH/WSL) notifications to the macOS/Windows notifier rather than reimplement natively.

Restart Claude Code after setup.

## Configuration

Setup seeds `config.json` (from `config.json.example`) in **`~/.claude/notifications/`** (`%USERPROFILE%\.claude\notifications\` on Windows; `$CLAUDE_CONFIG_DIR/notifications/` if you set `CLAUDE_CONFIG_DIR`), alongside the webhook templates; icons go in `icons/` there. Relative paths in the config resolve against that directory. It deliberately lives outside the plugin's data directory, which `/plugin uninstall` deletes — your config and icons survive updates and uninstalls. (Older versions kept them in the data directory; re-running setup moves them over.) Edit and re-run `/notifications:setup` if you change `title` (it names the macOS bundle and the Windows AUMID display name).

```json
{
    "title": "CC Notification",
    "terminal": "ghostty",
    "editor": "zed",
    "desktop": true,
    "sound": "default",
    "messages": {
        "notification": "Claude needs your input",
        "permission": "Claude needs permission",
        "elicitation": "Action required",
        "idle": "Claude is waiting",
        "stop": "Task completed"
    },
    "icons": {
        "app": "icons/AppIcon.png",
        "notification": "icons/notification.png",
        "permission": "icons/notification.png",
        "elicitation": "icons/notification.png",
        "idle": "icons/notification.png",
        "stop": "icons/stop.png",
        "title": "icons/title.ico"
    },
    "webhook": {
        "enabled": true,
        "url": "",
        "idle_minutes": 15,
        "payload": "webhook.discord.json"
    }
}
```

| Field | Description |
|-------|-------------|
| `title` | Name shown in the notification attribution (macOS bundle name / Windows AUMID display name) |
| `terminal` | macOS only: terminal to focus on click (`ghostty`, `iterm2`, `wezterm`, `terminal`). Windows focuses Windows Terminal. |
| `editor` | Editor to open projects in (`zed`, `code`, `cursor`) |
| `desktop` | Set to `false` to skip desktop notifications (webhook-only mode) |
| `sound` | `"default"`, a sound name, or `""` to disable. macOS: `/System/Library/Sounds` names (`Basso`, `Blow`, `Glass`, `Ping`, `Pop`, `Purr`, `Sosumi`, …) or a `.aiff`/`.wav`/`.caf` in `~/Library/Sounds/`. Windows: `Default`, `IM`, `Mail`, `Reminder`, `SMS` (`ms-winsoundevent:Notification.{name}`). |
| `icons.*` | Per-type icons; types without one fall back to `notification`. `icons.app` (macOS bundle icon) and `icons.title` (Windows attribution-bar `.ico`) are platform-specific. |

### Webhook

Sends a JSON POST when you're AFK (screen locked or idle for `idle_minutes`).

| Field | Description |
|-------|-------------|
| `webhook.enabled` | Set to `false` to disable without removing config |
| `webhook.url` | Webhook endpoint (leave empty to disable) |
| `webhook.idle_minutes` | Minutes of inactivity before sending (default: 15, `0` = always send) |
| `webhook.payload` | Path to a JSON template file (relative to the config directory) |

Copy a service template (`webhook.discord.json.example`, `webhook.slack.json.example`, `webhook.ntfy.json.example`, `webhook.gotify.json.example`) to the name in `payload` and customize. Template variables: `{{title}}`, `{{message}}`, `{{elapsed}}`, `{{project}}`, `{{event}}`, `{{notification_type}}`, `{{session}}` (macOS).

## How it works

`hooks/hooks.json` wires four events, all through `hooks/notifications.sh`, a tiny POSIX dispatcher (one hooks file serves every OS) that `exec`s the staged binary with the subcommand:

| Event | Subcommand | Does |
|-------|-----------|------|
| `UserPromptSubmit` (async) | `on-submit` | Records session state (cwd, timestamp, terminal/tab/tty). On Windows it stays alive as the **focus watcher** — spawned inside Windows Terminal's process tree so UI Automation tab selection works. |
| `Notification` (async) | `notify notification` | Shows the notification; `permission_prompt` / `elicitation_dialog` / `idle_prompt` pick their own message + icon |
| `Stop` (async) | `notify stop` | "Task completed (12s)" |
| `SessionEnd` | `on-end` | Stops the watcher, cleans up temp files and (macOS) the session's notification |

`Notification`/`Stop` are async because the macOS handler blocks until the notification is clicked or dismissed. Per-session state lives in `%TEMP%` / `/tmp` as `claude-timer-{session_id}`, `claude-watcher-…`, `claude-focus-trigger-…` (Windows) and `claude-notifier-…` (macOS).

## Uninstall

Claude Code runs no hook when a plugin is uninstalled, so run setup's uninstall **first**:

```
/notifications:setup --uninstall
/plugin uninstall notifications@cc-plugins
```

`--uninstall` removes everything setup created outside your config directory:

- **Both**: the staged binary / `.app` and its build directory, the per-session temp files.
- **Windows**: the `claude-focus://` / `claude-editor://` protocol handlers (HKCU), the AUMID (HKLM — UAC prompt — plus the HKCU fallback), Windows' per-app notification settings for it, and its toasts in Action Center. Skip this step and those registry entries are orphaned, pointing at a deleted exe.
- **macOS**: the bundle's LaunchServices registration and the `~/Library` caches/preferences macOS keeps under its bundle id. macOS also lists the app under System Settings → Notifications; there's no supported way to remove that entry from a script.

Plugin uninstall then removes the hooks and the data directory. **`~/.claude/notifications/` (config, icons, webhook templates) is kept on purpose** — delete it yourself if you don't want it.

## Files

| Path | Purpose |
|------|---------|
| `hooks/hooks.json`, `hooks/notifications.sh` | Hook registration + platform dispatcher |
| `windows/src/main.rs`, `windows/Cargo.toml` | Rust source — hook commands, focus watcher, protocol handlers |
| `windows/setup.ps1` | Build, stage, register (what `/notifications:setup` runs) |
| `macos/Sources/main.swift`, `macos/Package.swift`, `macos/Info.plist` | Swift source + bundle metadata |
| `macos/setup.sh` | Build, bundle, sign, stage |
| `*/config.json.example`, `*/webhook.*.json.example` | Config + webhook templates (copied into `~/.claude/notifications/` by setup) |

Both binaries still have `install` / `uninstall` subcommands that merge hooks into `~/.claude/settings.json` directly; they're for running from a plain checkout without the plugin system and aren't used by the plugin.
