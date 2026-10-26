# cc-plugins

[Claude Code](https://claude.com/claude-code) plugins, served from this repo as a
[plugin marketplace](https://code.claude.com/docs/en/plugins/marketplace-reference):

```
/plugin marketplace add anthonybaldwin/cc-plugins
```

| Plugin | What it does | Install |
| --- | --- | --- |
| [**statusline-dashboard**](plugins/statusline-dashboard/) | A mod: an opinionated dashboard above the prompt, one collapsible row per section — context (with the per-category breakdown that used to be context-bar), rate-limit windows with pace balance, cost, activity and sub-agents, git/PR, and config-scope breakdowns. Nerd Font glyphs. Claude Code 2.1.287+. | `/plugin install statusline-dashboard@cc-plugins` |
| [**session-color**](plugins/session-color/) | Tints the terminal background by session status — amber while Claude works, red when it needs you, green when done — per pane via OSC 11 (tmux-native on Linux, ConPTY on Windows). | `/plugin install session-color@cc-plugins` (+ `/session-color:setup` on Windows) |
| [**notifications**](plugins/notifications/) | Native desktop notifications when Claude finishes or needs input: elapsed time, focus-the-originating-pane, open-in-editor, AFK webhook. Windows (WinRT) and macOS (UserNotifications). | `/plugin install notifications@cc-plugins` then `/notifications:setup` |

Each plugin's README covers requirements, configuration and how it works. A few things are the
same for all of them:

- **`setup` skills exist because plugins can't do everything.** A plugin can register hooks,
  skills and MCP servers, but it can't run a build. Where a native binary is needed
  (notifications, session-color on Windows), the plugin ships a `/<plugin>:setup` skill that
  builds it and stages it in the plugin's **persistent data directory** (`~/.claude/plugins/data/…`)
  rather than the plugin's install path — the install path is a per-version cache directory that
  moves on every update, the data directory is stable.
- **Updates**: `/plugin update <name>@cc-plugins` (or enable auto-update for the marketplace in
  `/plugin` → Marketplaces). Plugins are versioned by their manifest; a push without a version
  bump isn't an update.
- **Uninstall**: `/plugin uninstall <name>@cc-plugins`. It removes the plugin's hooks and its data
  directory; Claude Code runs no plugin code at uninstall, so where a plugin's setup wrote outside
  those (the Windows notification registry entries, a tinted terminal), run
  `/<plugin>:setup --uninstall` **first**. Your own config and images live outside the data
  directory on purpose (`~/.claude/statusline-dashboard.json`, `~/.claude/notifications/`) and
  survive an uninstall, ready for a reinstall.
- **Coming from context-bar or statusline-dashboard 1.x?** context-bar is now the Model row of
  statusline-dashboard (open it for the breakdown): `/plugin uninstall context-bar@cc-plugins`.
  statusline-dashboard 2.x draws above the prompt instead of in the status line: run
  `/dash cleanup` once to remove the 1.x `statusLine` block from your settings.

## Layout

```
cc-plugins/
├─ .claude-plugin/marketplace.json   # the marketplace: one entry per plugin below
├─ plugins/
│  ├─ statusline-dashboard/          # a mod: hooks/register.tsx (+ layout, sections, collect), types/, tests/
│  ├─ session-color/                 # hooks.json + sh dispatcher; macos/ linux/ (shell), windows/ (Rust)
│  └─ notifications/                 # hooks.json + sh dispatcher; windows/ (Rust), macos/ (Swift)
└─ .github/workflows/check.yml       # `claude plugin validate` + `test`, sh -n, cargo + swift builds, .ps1 parse
```

To work on a plugin from a checkout, add the checkout as a local marketplace — it then loads in
place, and edits apply on the next session or `/reload-plugins`:

```
/plugin marketplace add /path/to/cc-plugins
/plugin install session-color@cc-plugins
```

## License

[MIT](LICENSE) © Anthony Baldwin.
