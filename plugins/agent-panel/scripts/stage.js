#!/usr/bin/env bun
// SessionStart hook: copy agent-panel.js into the plugin's persistent data directory.
//
// WHY: settings.json's `subagentStatusLine` command can't name the plugin root — it's a per-VERSION
// cache dir that moves with every update, and the docs promise no ${CLAUDE_PLUGIN_ROOT}
// substitution there. ${CLAUDE_PLUGIN_DATA} (~/.claude/plugins/data/agent-panel-cc-plugins/) is
// stable across updates and deleted on uninstall, so the command points at a copy there and this
// hook keeps it current (at most one session behind an update). The path in settings.json and
// this directory must agree.
//
// MUST stay silent: SessionStart stdout is added to Claude's context. Always exits 0 — a failed
// stage must never degrade the session (the previous copy keeps rendering).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.CLAUDE_PLUGIN_ROOT;
const data = process.env.CLAUDE_PLUGIN_DATA;
if (!root || !data) process.exit(0); // not run by Claude Code as a plugin hook — nothing to do

try {
  mkdirSync(data, { recursive: true });
  const want = readFileSync(join(root, "agent-panel.js"));
  const dst = join(data, "agent-panel.js");
  // Byte-compare first: an identical copy keeps its mtime, so nothing watching it sees a change.
  if (!existsSync(dst) || !want.equals(readFileSync(dst))) writeFileSync(dst, want);
} catch {
  // swallow — see header
}
process.exit(0);
