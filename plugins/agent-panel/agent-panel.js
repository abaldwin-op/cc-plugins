#!/usr/bin/env bun
// agent-panel — implements Claude Code's `subagentStatusLine` setting: a custom row body for each
// sub-agent AND agent-team teammate in the agent panel below the prompt, replacing the default
// `name · description · token count` with: icon (robot for a sub-agent, person for a teammate), name
// or type, live progress, model + effort, a status glyph coloured by state, elapsed time, tokens.
//
// Input (one JSON object on stdin): the base hook fields plus `columns` (usable row width) and a
// `tasks` array; each task has { id, name, type, agentType, status, description, label, startTime,
// model, effort, contextWindowSize, tokenCount, tokenSamples, cwd }. `type` is "local_agent" for a
// sub-agent and "in_process_teammate" for an agent-team teammate; `label` is the agent's live
// progress summary (falling back to its description); `agentType` (CC v2.1.293+) is the subagent
// type, e.g. "Explore".
// Output: one JSON line per row you want to OVERRIDE, in the form {"id": "<task id>", "content": "<row>"}.
//   - Omit a task's id to keep Claude Code's default rendering for that row.
//   - Emit an empty `content` string to hide a row.
// `content` is rendered as-is, including ANSI colors and OSC 8 hyperlinks.
// Docs: https://code.claude.com/docs/en/statusline#subagent-status-lines
//
// Wiring: the plugin's own settings.json sets `subagentStatusLine` (one of the two keys a plugin's
// settings may set), pointing at the copy hooks/hooks.json's SessionStart hook keeps in the
// plugin's data dir — so nothing is written to the user's settings, and an uninstall removes both.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const esc = "\x1b";
const RESET = `${esc}[0m`;
const BOLD = `${esc}[1m`;
const GREEN = `${esc}[32m`;
const YELLOW = `${esc}[33m`;
const RED = `${esc}[31m`;
const CYAN = `${esc}[36m`;
const SOFT = `${esc}[38;5;245m`;
const DIM = `${esc}[38;5;244m`;

const cp = (n) => String.fromCodePoint(n);
const gAgent = cp(0xf06a9); // nf-md-robot — matches the main dashboard's agent glyph
const gDone = cp(0x2714) + cp(0xfe0e); // ✔︎ text-presentation (never emoji)
const gErr = cp(0x2718) + cp(0xfe0e); // ✘︎
const gRun = cp(0x25cf); // ● running
const gPend = cp(0x25cb); // ○ pending
const gIdle = cp(0x25cc); // ◌ idle (a teammate waiting for its next message)
const gMate = cp(0xf0004); // nf-md-account — a person: an agent-team teammate (MD, since FA's user glyph is tofu in the Windows font)

// Shares statusline-dashboard's user config file (~/.claude/statusline-dashboard.json, or
// CLAUDE_STATUSLINE_CONFIG); this script reads only its `hide` list, for the "subagent.*" ids.
// Missing/broken file → nothing hidden.
const hidden = (() => {
  try {
    const path = process.env.CLAUDE_STATUSLINE_CONFIG || join(homedir(), ".claude", "statusline-dashboard.json");
    const h = JSON.parse(readFileSync(path, "utf8"))?.hide;
    return new Set(Array.isArray(h) ? h.map((x) => String(x).toLowerCase()) : []);
  } catch {
    return new Set();
  }
})();
const on = (id) => !hidden.has(id);

// --- shared primitives (kept self-contained so this script has no dependency on statusline.js) ---
function formatTokens(tokens) {
  const n = Number(tokens) || 0;
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return v >= 10 ? `${Math.round(v)}M` : `${v.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const v = n / 1_000;
    return v >= 10 ? `${Math.round(v)}K` : `${v.toFixed(1)}K`;
  }
  return String(Math.round(n));
}

function truncate(value, maxLen) {
  const s = String(value || "").replace(/\s+/g, " ").trim();
  return s.length <= maxLen ? s : `${s.slice(0, Math.max(0, maxLen - 3))}...`;
}

// Strip SGR + OSC 8 hyperlink sequences so width math counts only visible glyphs.
const stripAnsi = (s) =>
  s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
const isWide = (codePoint) =>
  (codePoint >= 0xe000 && codePoint <= 0xf8ff) ||
  (codePoint >= 0xf0000 && codePoint <= 0xffffd) ||
  (codePoint >= 0x100000 && codePoint <= 0x10fffd);
const vlen = (s) => {
  let w = 0;
  for (const ch of stripAnsi(s)) w += isWide(ch.codePointAt(0)) ? 2 : 1;
  return w;
};
// Truncate to maxVisible cells while preserving ANSI/OSC 8 (so colors/links stay balanced).
const truncateVisible = (s, maxVisible) => {
  if (maxVisible < 2 || vlen(s) <= maxVisible) return s;
  const limit = maxVisible - 1;
  let out = "";
  let visible = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const sgr = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (sgr) {
        out += sgr[0];
        i += sgr[0].length;
        continue;
      }
      const osc = /^\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/.exec(s.slice(i));
      if (osc) {
        out += osc[0];
        i += osc[0].length;
        continue;
      }
    }
    const c = s.codePointAt(i);
    const chLen = c > 0xffff ? 2 : 1;
    const w = isWide(c) ? 2 : 1;
    if (visible + w > limit) break;
    out += s.slice(i, i + chLen);
    visible += w;
    i += chLen;
  }
  return `${out}…${RESET}`;
};

// Map Claude Code's task statuses onto a small normalized set.
function normalizeStatus(status) {
  switch (status) {
    case "running":
      return "in_progress";
    case "complete":
    case "done":
      return "completed";
    case "not_started":
      return "pending";
    case "failed":
    case "error":
      return "error";
    case "killed":
    case "stopped":
    case "cancelled":
      return "stopped";
    default:
      return status;
  }
}

function statusStyle(s) {
  switch (s) {
    case "completed":
      return { color: GREEN, glyph: gDone };
    case "in_progress":
      return { color: YELLOW, glyph: gRun };
    case "error":
      return { color: RED, glyph: gErr };
    case "pending":
      return { color: DIM, glyph: gPend };
    case "idle":
      return { color: DIM, glyph: gIdle };
    case "stopped":
      return { color: SOFT, glyph: gErr };
    default:
      return { color: SOFT, glyph: gPend };
  }
}

// Names Claude Code assigns to plain (non-specialized) agents — not real identities, so hide them
// and let the description carry the row.
const GENERIC_NAMES = new Set(["internal_agent", "local_agent", "agent"]);

// Per-agent model + effort (each task carries `model`, `effort`, `contextWindowSize` since CC
// ~2.1.2xx). Strip the "claude-" prefix so "claude-opus-5" reads "opus-5"; effort appended plain.
// One dim string — metadata, not the row's signal.
// Elapsed since the agent started (startTime is epoch ms): "45s", "12m", "1h05m".
function elapsed(startTime) {
  const ms = Date.now() - Number(startTime);
  if (!Number.isFinite(ms) || ms < 0 || !Number(startTime)) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function modelEffort(task) {
  const model = String(task.model || "").replace(/^claude-/, "").replace(/-\d{8}$/, ""); // drop date suffix ("haiku-4-5-20251001" → "haiku-4-5")
  return [model, task.effort].filter(Boolean).join(" ");
}

// Row body: [robot|team] name · dim progress · dim model+effort · [status glyph] · elapsed · NNk tok
// — clamped to the row width.
function renderRow(task, cols) {
  // A generic CC name ("local_agent") yields to the subagent type when CC sends one ("Explore").
  const name = String((!GENERIC_NAMES.has(task.name) && task.name) || task.agentType || task.name || task.type || "agent");
  const st = statusStyle(normalizeStatus(task.status));
  // Teammates get a person, sub-agents a robot, so a mixed panel reads "who's on the team" vs "who's a helper".
  const icon = task.type === "in_process_teammate" ? gMate : gAgent;
  // `label` is the LIVE progress summary (what the agent is doing now), else the description.
  const text = (on("subagent.label") && typeof task.label === "string" && task.label.trim()) || task.description;
  const sep = ` ${DIM}·${RESET} `;
  // Glyph stays a stable brand cyan (matching the dashboard's agent widget); the trailing
  // status glyph below — not the icon — carries running/done/error color, so the agent's identity
  // icon doesn't flicker yellow/green/red as its status changes.
  const showName = !GENERIC_NAMES.has(name) || !text;
  const parts = showName
    ? [`${CYAN}${icon}${RESET} ${BOLD}${name}${RESET}`]
    : [`${CYAN}${icon}${RESET} ${SOFT}${truncate(text, 56)}${RESET}`];
  if (showName && text) parts.push(`${SOFT}${truncate(text, 40)}${RESET}`);
  const me = on("subagent.model") ? modelEffort(task) : "";
  if (me) parts.push(`${DIM}${me}${RESET}`);
  const el = on("subagent.elapsed") ? elapsed(task.startTime) : "";
  parts.push(`${st.color}${st.glyph}${RESET}${el ? ` ${SOFT}${el}${RESET}` : ""}`);
  const tok = Number(task.tokenCount) || 0;
  if (tok > 0 && on("subagent.tokens")) parts.push(`${SOFT}${formatTokens(tok)} tok${RESET}`);
  return truncateVisible(parts.join(sep), Math.max(8, cols - 1));
}

const raw = await Bun.stdin.text();
if (!raw) process.exit(0);

let data;
try {
  data = JSON.parse(raw);
} catch {
  process.exit(0);
}

const cols = Number(data.columns) || 80;
const tasks = Array.isArray(data.tasks) ? data.tasks : [];

const lines = [];
for (const task of tasks) {
  if (!task || !task.id) continue; // no id → can't address the row; leave it as CC's default
  lines.push(JSON.stringify({ id: task.id, content: renderRow(task, cols) }));
}

if (lines.length) process.stdout.write(lines.join("\n"));
