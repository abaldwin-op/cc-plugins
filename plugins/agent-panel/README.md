# agent-panel

Styles the rows of Claude Code's **agent panel**, the list under the prompt that shows each
running sub-agent and agent-team teammate. Each row reads:

```
󰚩 Explore · Reading the hooks · haiku-4-5 low · ● 1m · 12K tok
󰀄 reviewer · Review the diff · ◌
```

- A robot icon marks a sub-agent and a person icon marks a teammate, so a mixed panel shows who is on
  the team and who is a helper.
- **Name**: the agent's name. A generic name such as `local_agent` gives way to the sub-agent type
  (`Explore`), or to the task description.
- **Progress**: the agent's live progress summary, or its description when there is none.
- **Model and effort**: for example `haiku-4-5 low`.
- **Status glyph**: ● running (yellow), ✔ done (green), ✘ failed (red), ○ pending, ◌ an idle
  teammate waiting for its next message.
- **Elapsed time** and **tokens used**.

Rows are cut to the panel's width, never wrapped. It uses Claude Code's
[`subagentStatusLine`](https://code.claude.com/docs/en/statusline#subagent-status-lines).

## Install

```
/plugin marketplace add anthonybaldwin/cc-plugins
/plugin install agent-panel@cc-plugins
```

Then **start a new session**: Claude Code reads a plugin's settings when a session starts. Nothing
is written to your settings. The plugin's own `settings.json` supplies `subagentStatusLine` (a
plugin may set that key). A `SessionStart` hook keeps a copy of the script in the plugin's data
directory, `~/.claude/plugins/data/agent-panel-cc-plugins/`, because the plugin's install path
changes with every update.

## Requirements

- [**Bun**](https://bun.sh), which runs the script.
- A [**Nerd Font**](https://www.nerdfonts.com/) for the robot and person icons.

## Configuration

To hide parts of a row, add their ids to the `hide` list in `~/.claude/statusline-dashboard.json`.
That file is shared with [statusline-dashboard](../statusline-dashboard/), and
`CLAUDE_STATUSLINE_CONFIG` points it elsewhere.

| Id | Hides |
| --- | --- |
| `subagent.label` | The live progress (the description shows instead) |
| `subagent.model` | Model and effort |
| `subagent.elapsed` | Elapsed time |
| `subagent.tokens` | Token count |

A `subagentStatusLine` in your own `~/.claude/settings.json` takes precedence over the plugin's.
If you used statusline-dashboard 1.x, run `/dash cleanup` once to remove the block it wrote,
otherwise that block keeps overriding this plugin.

## Uninstall

`/plugin uninstall agent-panel@cc-plugins`. This removes the setting and the data directory, and
the agent panel goes back to Claude Code's default rows.

## Troubleshooting

If the rows stay plain after a new session:

- Make sure you started a new session after installing or updating. The first one also stages the
  script.
- Check `~/.claude/settings.json` for a `subagentStatusLine` of your own, for example one left by
  statusline-dashboard 1.x. Yours takes precedence over the plugin's. `/dash cleanup` removes the
  1.x one.
- Run `claude --debug`, start a sub-agent, and look for `subagentStatusLine` in the log. An
  `exited` line gives the error, and `workspace trust not accepted` means the folder hasn't been
  trusted.
