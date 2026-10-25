#!/usr/bin/env bun
// Invariant checker for the dashboard — the closest thing this repo has to a test suite.
//
//   bun check.js                 render fixture payloads across a grid of terminal sizes, assert
//   bun check.js --show 60x30    also print one stripped render (COLUMNSxLINES) for eyeballing
//
// WHY: CLAUDE.md's "critical invariants" exist to dodge real Claude Code rendering bugs — a line
// wider than the terminal or a height that shrinks between renders corrupts the user's TERMINAL,
// not just the look. Nothing else exercises them, and the packer's squeeze path (short terminals)
// is exactly the code nobody sees on a tall dev window. This drives statusline.js the way CC does
// (JSON on stdin, COLUMNS/LINES in env) and checks the OUTPUT, so it holds for any refactor.
//
// HERMETIC: HOME is pointed at an empty sandbox (no real ~/.claude config is read, no OAuth token),
// and TEMP at a scratch dir (CLAUDE.md: test renders otherwise share the live sl-*.json caches). A
// FRESH usage-API cache is seeded there so the render never fires the out-of-band network refresh.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = import.meta.dir;
const PLUGIN = join(here, "plugins", "statusline-dashboard"); // the plugin root (see marketplace.json)
const MAIN = join(PLUGIN, "statusline.js");
const SUB = join(PLUGIN, "subagent-statusline.js");
const STAGE = join(PLUGIN, "scripts", "stage.js");
const showArg = (process.argv.find((a, i) => process.argv[i - 1] === "--show") || "").match(/^(\d+)x(\d+)$/);

// --- sandbox ---------------------------------------------------------------------------------
const sandbox = mkdtempSync(join(tmpdir(), "sl-check-"));
const home = join(sandbox, "home");
const temp = join(sandbox, "tmp");
const nonRepo = join(sandbox, "plain-dir"); // a cwd OUTSIDE any git repo → Repo row must vanish
for (const d of [join(home, ".claude"), temp, nonRepo]) mkdirSync(d, { recursive: true });
// Usage-API response in its modern shape (scoped weekly + credits), so the 7dF / Cr gauges render.
writeFileSync(
  join(temp, "sl-usage.json"),
  JSON.stringify({
    ts: Date.now(),
    data: {
      limits: [{ kind: "weekly_scoped", percent: 15, resets_at: "2026-10-02T08:00:00Z", scope: { model: { display_name: "Fable" } } }],
      spend: { enabled: true, used: { amount_minor: 4300, exponent: 2 }, limit: { amount_minor: 5000, exponent: 2 }, percent: 86 },
    },
  }),
);
// A short transcript so the Activity row (slash command, tool call, live sub-agent) has content.
const transcript = join(sandbox, "session.jsonl");
writeFileSync(
  transcript,
  [
    { type: "user", timestamp: "2026-09-28T16:00:00Z", message: { content: "<command-name>/review</command-name>" } },
    { type: "assistant", timestamp: "2026-09-28T16:00:05Z", message: { usage: { output_tokens: 300 }, content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "git status --porcelain" } }] } },
    { type: "user", timestamp: "2026-09-28T16:00:06Z", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } },
    { type: "assistant", timestamp: "2026-09-28T16:00:10Z", message: { usage: { output_tokens: 900 }, content: [{ type: "tool_use", id: "t2", name: "Agent", input: { subagent_type: "Explore", description: "find packer call sites" } }] } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n") + "\n",
);

// Agent team led by the FULL session (implicit team name: "session-" + first 8 chars of its id).
mkdirSync(join(home, ".claude", "teams", "session-check-fu"), { recursive: true });
writeFileSync(
  join(home, ".claude", "teams", "session-check-fu", "config.json"),
  JSON.stringify({ name: "session-check-fu", leadAgentId: "lead@t", leadSessionId: "check-full", members: [{ agentId: "lead@t", name: "team-lead" }, { agentId: "r@t", name: "researcher" }, { agentId: "w@t", name: "writer" }] }),
);

// --- fixtures --------------------------------------------------------------------------------
const reset5h = new Date(Date.now() + 3 * 3600e3).toISOString();
const reset7d = new Date(Date.now() + 4 * 24 * 3600e3).toISOString();
const FULL = {
  session_id: "check-full",
  session_name: "invariant probe with a deliberately long session title",
  transcript_path: transcript,
  cwd: here,
  workspace: { current_dir: here, project_dir: here, added_dirs: ["/extra/dir"], repo: { host: "github.com", owner: "someone-else", name: "renamed-fork" } },
  version: "2.1.283",
  model: { id: "claude-fable-5-1", display_name: "Fable" },
  output_style: { name: "Explanatory" },
  cost: { total_cost_usd: 3.2, total_duration_ms: 3600e3, total_api_duration_ms: 900e3, total_lines_added: 10, total_lines_removed: 3 },
  context_window: { context_window_size: 200000, current_usage: { input_tokens: 50000, output_tokens: 1200, cache_creation_input_tokens: 5000, cache_read_input_tokens: 90000 } },
  prompt_cache: { warm: true, caching_observed: true, expires_at: Math.floor(Date.now() / 1000) + 2400, misses: 2, hit_ratio: 0.91, last_miss_cause: { causes: ["tools_changed"] } },
  rate_limits: { five_hour: { used_percentage: 42, resets_at: reset5h }, seven_day: { used_percentage: 88, resets_at: reset7d }, spend_limit: { used_percentage: 130, resets_at: Math.floor(Date.now() / 1000) + 20 * 86400, used_usd: 65, limit_usd: 50, period: "monthly" } },
  effort: { level: "max" },
  thinking: { enabled: true },
  fast_mode: true,
  vim: { mode: "VISUAL LINE" },
  agent: { name: "security-reviewer" },
  remote: { session_id: "r1" },
  pr: { number: 7, url: "https://example.invalid/pr/7", review_state: "changes_requested" },
};
// Before the first API call: null usage, no limits, no transcript, outside any repo, 1M window.
const MINIMAL = {
  session_id: "check-min",
  cwd: nonRepo,
  model: { display_name: "Opus" },
  cost: {},
  context_window: { context_window_size: 1000000, current_usage: null, used_percentage: null },
  exceeds_200k_tokens: true,
};
// Gateway session: spend_limit ALONE (no claude.ai usage to read) — must not reach for the usage cache.
const GATEWAY = { ...MINIMAL, session_id: "check-gw", rate_limits: { spend_limit: { used_percentage: 62.8, resets_at: Math.floor(Date.now() / 1000) + 86400 } } };

const COLUMNS = [40, 60, 80, 100, 140, 220];
const LINES = [8, 12, 24, 40, 60, null]; // null → LINES unset (piped / older CC)

// --- helpers (mirrors of the script's own width math) ------------------------------------------
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, ""); // SGR + OSC 8 links
const isWide = (c) => (c >= 0xe000 && c <= 0xf8ff) || (c >= 0xf0000 && c <= 0xffffd) || (c >= 0x100000 && c <= 0x10fffd);
const vlen = (s) => {
  let w = 0;
  for (const ch of stripAnsi(s)) w += isWide(ch.codePointAt(0)) ? 2 : 1;
  return w;
};
const BLANK = "⠀";
const SECTIONS = 10; // entries in sectionSpecs
const WRAP_HEADROOM = 4;

function render(script, payload, cols, lines, extraEnv = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp, COLUMNS: String(cols), ...extraEnv };
  if (lines) env.LINES = String(lines);
  else delete env.LINES;
  return spawnSync(process.execPath, [script], { input: JSON.stringify(payload), env, encoding: "utf8", windowsHide: true });
}

let checks = 0;
let failures = 0;
const fail = (where, msg) => {
  failures++;
  console.log(`  ✗ ${where}: ${msg}`);
};
const expect = (where, ok, msg) => {
  checks++;
  if (!ok) fail(where, msg);
};

// --- main dashboard ----------------------------------------------------------------------------
function checkDashboard(name, payload, cols, lines, extraEnv = {}, labels = true) {
  const where = `${name} @ ${cols}x${lines ?? "?"}`;
  const r = render(MAIN, payload, cols, lines, extraEnv);
  expect(where, r.status === 0 && !r.error, `exit ${r.status} ${r.error?.message || ""} ${r.stderr}`);
  if (r.status !== 0) return null;
  expect(where, !r.stderr, `stderr: ${r.stderr.trim()}`);
  const out = r.stdout;
  const all = out.split("\n");
  // Invariant 3 (plus the layout contract): one trailing Braille-blank gap row, never a bare newline.
  expect(where, all[all.length - 1] === BLANK, "output must end with a single U+2800 gap row");
  const content = all.slice(0, -1);
  const widest = Math.max(...content.map(vlen));
  // Invariant 2: no line may exceed the terminal width (the script reserves a 2-cell cushion).
  expect(where, widest <= cols - 2, `line width ${widest} exceeds budget ${cols - 2}`);
  for (const line of content) {
    expect(where, line.length > 0 && !/^\s/.test(line), `row starts with whitespace or is empty: ${JSON.stringify(stripAnsi(line)).slice(0, 60)}`);
    // A squeezed row must still say SOMETHING: "Limits  󰊚 …" is a row that costs height and
    // carries no data. Continuation rows (Braille indent) are exempt — the data sits above them.
    if (line.startsWith(BLANK)) continue;
    const body = stripAnsi(line).slice(labels ? 9 : 0).replace(/…$/, "").replace(/\s+/g, "");
    expect(where, body.length > 1, `row carries no data: ${JSON.stringify(stripAnsi(line))}`);
  }
  // Invariant 1 (short terminal): at most a third of LINES, never more than sections + headroom.
  const cap = Math.min(SECTIONS + WRAP_HEADROOM, lines ? Math.max(1, Math.floor(lines / 3)) : Infinity);
  expect(where, content.length <= cap, `${content.length} content rows exceed cap ${cap}`);
  return { lines: content.length, widest, out };
}

console.log("dashboard renders (rows / widest cell) — sandbox:", sandbox);
const grid = [];
for (const [name, payload] of [["full", FULL], ["minimal", MINIMAL], ["gateway", GATEWAY]]) {
  for (const cols of COLUMNS) {
    for (const lines of LINES) {
      const res = checkDashboard(name, payload, cols, lines);
      if (res) grid.push(`${name.padEnd(8)} ${String(cols).padStart(3)}x${String(lines ?? "-").padEnd(3)} ${String(res.lines).padStart(2)} rows  ${String(res.widest).padStart(3)} wide`);
    }
  }
}
console.log(grid.join("\n"));

// Invariant 1 (shrink): a later, emptier render at the same geometry and session must not be
// shorter than an earlier taller one — the per-session high-water mark pads it back up.
{
  const sid = "check-hwm";
  const tall = checkDashboard("hwm-tall", { ...FULL, session_id: sid }, 60, 60);
  const short = checkDashboard("hwm-short", { ...MINIMAL, session_id: sid, cwd: here }, 60, 60);
  if (tall && short) expect("hwm @ 60x60", short.lines >= tall.lines, `height shrank ${tall.lines} → ${short.lines} between renders`);
}
// Payload features the FULL fixture exercises: team roll-up, spend-limit dollars, clickable PR.
{
  const res = checkDashboard("features", FULL, 220, null);
  const plain = res ? stripAnsi(res.out) : "";
  expect("team widget", /2 \(researcher, writer\)/.test(plain), "Activity row lacks the 2-teammate roll-up");
  expect("spend usd", /\$65\.00\/\$50/.test(plain), "Sp gauge lacks $used/$limit");
  expect("pr link", res && res.out.includes("\x1b]8;;https://example.invalid/pr/7\x07#7\x1b]8;;\x07"), "PR number is not an OSC 8 link");
}

// User config (~/.claude/statusline-dashboard.json, here via CLAUDE_STATUSLINE_CONFIG): row
// selection + order, hidden widgets, no labels, no bars, a row cap — invariants must still hold.
{
  const cfgFile = join(sandbox, "sl-config.json");
  writeFileSync(cfgFile, JSON.stringify({ rows: ["info", "model", "limits", "repo"], hide: ["info.version", "repo.tag", "limits.5h"], labels: false, bars: false, clock: "12h", maxRows: 3, usageApi: false }));
  const env = { CLAUDE_STATUSLINE_CONFIG: cfgFile };
  for (const cols of COLUMNS) for (const lines of LINES) checkDashboard("custom", FULL, cols, lines, env, false);
  const res = checkDashboard("custom-shape", FULL, 220, 60, env, false);
  const plain = res ? stripAnsi(res.out) : "";
  expect("custom", res && res.lines <= 3, `maxRows 3 but ${res?.lines} rows`);
  expect("custom", !/Model|Limits|Info\./.test(plain), "labels:false still renders labels");
  expect("custom", !/v2\.1\.283|5h /.test(plain), "hidden widgets still render");
  expect("custom", !/7dF|Cr /.test(plain), "usageApi:false still renders usage-API gauges");
  expect("custom", !res?.out.includes("█"), "bars:false still renders bars");
  const infoAt = plain.indexOf("invariant probe"); // session name → Info. row
  expect("custom", infoAt >= 0 && infoAt < plain.indexOf("Fable"), "rows not in configured order (info before model)");
  // A broken config file must degrade to the stock dashboard, not a blank one.
  writeFileSync(cfgFile, "{ not json");
  const broken = checkDashboard("custom-broken", FULL, 220, 60, env);
  expect("custom-broken", broken && /Model/.test(stripAnsi(broken.out)), "broken config did not fall back to defaults");
}

// Robustness: empty and non-JSON stdin must exit 0 silently (CC feeds us whatever it has).
for (const [label, input] of [["empty stdin", ""], ["garbage stdin", "not json"]]) {
  const r = spawnSync(process.execPath, [MAIN], { input, env: { ...process.env, HOME: home, TEMP: temp, TMP: temp }, encoding: "utf8", windowsHide: true });
  expect(label, r.status === 0 && r.stdout === "" && !r.stderr, `exit ${r.status}, stdout ${JSON.stringify(r.stdout)}, stderr ${r.stderr.trim()}`);
}

// --- subagent rows -----------------------------------------------------------------------------
{
  const cols = 60;
  const tasks = [
    { id: "a1", name: "Explore", type: "agent", status: "running", description: "find every place the config scope breakdown is rendered", model: "claude-haiku-4-5-20251001", effort: "low", tokenCount: 15300 },
    { id: "a2", name: "local_agent", status: "complete", description: "done thing", tokenCount: 0 },
    { id: "a3", name: "Plan", status: "failed", description: "", model: "claude-opus-5-5", tokenCount: 2_400_000 },
    { name: "no-id" }, // un-addressable → must be skipped, not emitted
  ];
  const r = render(SUB, { columns: cols, tasks }, cols, 40);
  const where = `subagent @ ${cols}`;
  expect(where, r.status === 0 && !r.stderr, `exit ${r.status} ${r.stderr}`);
  const rows = r.stdout ? r.stdout.split("\n") : [];
  expect(where, rows.length === 3, `expected 3 rows, got ${rows.length}`);
  for (const row of rows) {
    let obj = null;
    try { obj = JSON.parse(row); } catch {}
    expect(where, obj && typeof obj.id === "string" && typeof obj.content === "string", `row is not {id, content} JSON: ${row.slice(0, 60)}`);
    if (!obj) continue;
    expect(where, tasks.some((t) => t.id === obj.id), `unknown task id ${obj.id}`);
    expect(where, vlen(obj.content) <= cols - 1, `row ${obj.id} is ${vlen(obj.content)} cells, max ${cols - 1}`);
    expect(where, !/\n/.test(obj.content), `row ${obj.id} contains a newline`);
  }
}

// --- plugin staging hook -----------------------------------------------------------------------
// stage.js copies the scripts from the (per-version) plugin root into the stable plugin data dir.
// Contract: silent (SessionStart stdout lands in Claude's context), exit 0, copies exactly the
// three scripts, rewrites nothing on a repeat run, and is a no-op outside a plugin hook.
{
  const where = "stage.js";
  const data = join(sandbox, "plugin-data", "nested"); // must be created on demand
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN, CLAUDE_PLUGIN_DATA: data };
  const r = spawnSync(process.execPath, [STAGE], { env, encoding: "utf8", windowsHide: true });
  expect(where, r.status === 0 && r.stdout === "" && !r.stderr, `exit ${r.status}, stdout ${JSON.stringify(r.stdout)}, stderr ${r.stderr.trim()}`);
  const staged = ["statusline.js", "subagent-statusline.js", "install.js"];
  for (const name of staged) {
    const ok = existsSync(join(data, name)) && readFileSync(join(data, name)).equals(readFileSync(join(PLUGIN, name)));
    expect(where, ok, `${name} not staged byte-for-byte`);
  }
  expect(where, readdirSync(data).sort().join(",") === staged.slice().sort().join(","), `staged extra files: ${readdirSync(data).join(", ")}`);
  // The staged copy must still run from the data dir (the user's statusLine command points there).
  const r2 = spawnSync(process.execPath, [join(data, "statusline.js")], { input: JSON.stringify(MINIMAL), env: { ...process.env, HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp, COLUMNS: "80" }, encoding: "utf8", windowsHide: true });
  expect(where, r2.status === 0 && !r2.stderr && r2.stdout.length > 0, `staged statusline.js: exit ${r2.status} ${r2.stderr.trim()}`);
  // Repeat run: byte-identical copies are left alone (mtime unchanged).
  const before = staged.map((n) => statSync(join(data, n)).mtimeMs);
  const r3 = spawnSync(process.execPath, [STAGE], { env, encoding: "utf8", windowsHide: true });
  const after = staged.map((n) => statSync(join(data, n)).mtimeMs);
  expect(where, r3.status === 0 && before.every((t, i) => t === after[i]), "repeat run rewrote an unchanged file");
  // Outside Claude Code (no plugin env): nothing written, nothing said.
  const bare = { ...process.env };
  delete bare.CLAUDE_PLUGIN_ROOT;
  delete bare.CLAUDE_PLUGIN_DATA;
  const r4 = spawnSync(process.execPath, [STAGE], { env: bare, encoding: "utf8", windowsHide: true });
  expect(where, r4.status === 0 && r4.stdout === "" && !r4.stderr, `bare run: exit ${r4.status} ${r4.stdout} ${r4.stderr}`);
}

if (showArg) {
  const [, c, l] = showArg.map(Number);
  console.log(`\n--- full fixture @ ${c}x${l} (ANSI stripped) ---`);
  const r = render(MAIN, FULL, c, l);
  console.log(stripAnsi(r.stdout));
}

rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${checks} checks, ${failures} failure${failures === 1 ? "" : "s"}`);
process.exit(failures ? 1 : 0);
