# agent-panel

A mod that styles Claude Code's **agent rows**, the list under the prompt that shows each running
sub-agent and agent-team teammate. Each row reads:

```
󰚩 Explore · Reading the hooks · haiku-4-5 low · ● 1m · 12K tok
󰀄 reviewer · Review the diff · ◌
```

- A robot icon marks a sub-agent and a person icon marks a teammate, so a mixed list shows who is on
  the team and who is a helper.
- **Name**: the agent's name, else its sub-agent type (`Explore`), else the task description.
- **Progress**: the agent's live progress summary, or its description when there is none.
- **Model and effort**: for example `haiku-4-5 low`.
- **Status glyph**: ● running (yellow), ○ waiting on you (yellow), ✔ done (green), ✘ failed
  (red), ✘ stopped (grey), ○ pending, ◌ an idle teammate waiting for its next message.
- **Elapsed time** and **tokens used**.

Rows are cut to the list's width, never wrapped. Terminal only: the desktop app and VS Code keep
their own rows. It draws through the `AgentRow` render hook.

## Install

```
/plugin marketplace add anthonybaldwin/cc-plugins
/plugin install agent-panel@cc-plugins
```

Requires **Claude Code 2.1.323+** and a [**Nerd Font**](https://www.nerdfonts.com/) for the robot
and person icons. Nothing is written to your settings.

### Upgrading from 1.x

1.x drew the rows with a Bun script behind the plugin's `subagentStatusLine` setting, which Claude
Code 2.1.323 removed (rows went back to the default look). 2.0 is a mod and needs neither the
setting nor Bun. A `subagentStatusLine` left in your own `~/.claude/settings.json` now does
nothing: `/dash cleanup` removes the one statusline-dashboard 1.x wrote; delete any other by hand.

## Configuration

To hide parts of a row, add their ids to the `hide` list in `~/.claude/statusline-dashboard.json`.
That file is shared with [statusline-dashboard](../statusline-dashboard/), and
`CLAUDE_STATUSLINE_CONFIG` points it elsewhere. It's read at session start.

| Id | Hides |
| --- | --- |
| `subagent.label` | The live progress (the description shows instead) |
| `subagent.model` | Model and effort |
| `subagent.elapsed` | Elapsed time |
| `subagent.tokens` | Token count |

## Uninstall

`/plugin uninstall agent-panel@cc-plugins`. The agent rows go back to Claude Code's default look.
