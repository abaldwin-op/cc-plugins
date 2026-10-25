#!/usr/bin/env bun
// Cross-platform Claude Code status line. Run via: bun statusline.js (see install.js / README)
import { spawnSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import { basename as pathBasename, dirname, join, relative } from "node:path";
import { homedir, release, hostname, userInfo } from "node:os";

const esc = "\x1b";
const GREEN = `${esc}[32m`;
const YELLOW = `${esc}[33m`;
const RED = `${esc}[31m`;
const BRICK = `${esc}[38;5;196m`; // iconic LEGO red — for the plugins brick
const MAGENTA = `${esc}[35m`;
const BBLUE = `${esc}[94m`;
const CYAN = `${esc}[36m`;
const WHITE = `${esc}[97m`;
const PINK = `${esc}[38;5;211m`;
const PENCIL = `${esc}[38;5;220m`;
const ORANGE = `${esc}[38;5;216m`;
const SILVER = `${esc}[38;5;250m`;
const BOLD = `${esc}[1m`;
const ITALIC = `${esc}[3m`;
const SOFT = `${esc}[38;5;245m`;
const DIM = `${esc}[38;5;244m`; // (g/u/p) scope breakdown + doc notes — 244: dimmer than SOFT(245) but readable (240 was too dim)
const VAL = `${esc}[97m`; // primary value text — neutral/bright (one knob) so threshold & semantic
// colors (usage %, $/h, +/-, git counts, todo, vim) stand out instead of competing with a rainbow.
const TRACK = `${esc}[48;5;238m`; // empty-bar track — a DARK but visible container (slightly lighter than 236 so the unfilled portion reads against the terminal bg; same at 0% or 60%)
const BARLO = `${esc}[38;5;246m`;
const RESET = `${esc}[0m`;
const c256 = (n) => `${esc}[38;5;${n}m`; // 256-color foreground helper (config-row icon colors)

// Nerd Font glyphs only. Use fromCodePoint for symbols above U+FFFF.
const cp = (n) => String.fromCodePoint(n);
const gModel = cp(0xf06a9); // nf-md-robot
const gEffort = cp(0xf0e7); // nf-fa-bolt
const gCtx = cp(0xe28c); // nf-fae-brain
const gCost = cp(0xf0d6); // nf-fa-money
const gClock = cp(0xf0150); // nf-md-clock
const gGauge = cp(0xf029a); // nf-md-gauge — Limits-row lead (a quota meter; keeps the clock unique to the real time on Host)
const gDuration = cp(0xf252); // nf-fa-hourglass_half
const gDir = cp(0xf07c); // nf-fa-folder_open
const gTree = cp(0xe5fb); // nf-custom-folder_git_branch
const gBranch = cp(0xf126); // nf-fa-code_branch
const gPR = cp(0xf407); // nf-oct-git_pull_request — current-branch PR badge (if blank in your font, try an MD pull glyph, e.g. nf-md-source_pull)
const gLines = cp(0xeb7e); // nf-cod-edit
const gKey = cp(0xf084); // nf-fa-key
const gTools = cp(0xf013); // nf-fa-gear
const gAgent = cp(0xf06a9); // nf-md-robot
const gUser = cp(0xf007); // nf-fa-user
const gTodo = cp(0xf14a); // nf-fa-check_square
const gCache = cp(0xf1c0); // nf-fa-database
const gTokens = cp(0xf080); // nf-fa-bar_chart
const gSpeed = cp(0xf0e7); // nf-fa-bolt
const gApi = cp(0xf2f2); // nf-fa-stopwatch — API time
const gStyle = cp(0xf1fc); // nf-fa-paint_brush
const gThink = cp(0xf06e8); // nf-md-lightbulb_on — extended thinking enabled (distinct from gCtx's brain)
const gVersion = cp(0xf121); // nf-fa-code
const gWin = cp(0xf05b3); // nf-md-microsoft_windows
const gApple = cp(0xf0035); // nf-md-apple
const gLinux = cp(0xf17c); // nf-fa-linux (Tux) — only ever renders on Linux, so the Win-font FA-tofu gotcha doesn't apply here
const gPerson = cp(0xf0004); // nf-md-account (MD — the FA user glyph is tofu in the Windows font)
const gFleet = cp(0xf037a); // nf-md-monitor_multiple — OTHER live Claude Code sessions on this machine
const gVim = cp(0xe62b); // nf-dev-vim
const gCommand = cp(0xf120); // nf-fa-terminal
const gTeam = cp(0xf0849); // nf-md-account_group — agent team this session leads; codepoint verified against glyphnames.json
const gConfig = cp(0xf085); // nf-fa-gears
const gTag = cp(0xf02b); // nf-fa-tag
const gPaper = cp(0xf0f6); // nf-fa-file_text_o (docs)
const gCheck = cp(0xf00c); // nf-fa-check
const gX = cp(0xf00d); // nf-fa-times
const gAhead = cp(0xf062); // nf-fa-arrow_up
const gBehind = cp(0xf063); // nf-fa-arrow_down
const gIn = cp(0xf090); // nf-fa-sign_in (input tokens)
const gOut = cp(0xf08b); // nf-fa-sign_out (output tokens)
const gWrite = cp(0xf0ee); // nf-fa-cloud_upload (cache write)
const gRead = cp(0xf0ed); // nf-fa-cloud_download (cache read)
const gPromptCache = cp(0xf00e8); // nf-md-cached — session prompt-cache health (Turn row); codepoint verified against glyphnames.json
// Config-row icons — ALL Material Design (nf-md-*); Font Awesome renders blank in this font.
const gCfgDoc = cp(0xf0219); // nf-md-file_document — instruction files (CLAUDE.md + natively-loaded AGENTS.md)
const gCfgAgents = cp(0xf167a); // nf-md-robot_outline
const gCfgCmds = cp(0xf018d); // nf-md-console
const gCfgSkills = cp(0xf0068); // nf-md-auto_fix (magic wand)
const gCfgRules = cp(0xf0565); // nf-md-shield_check
const gCfgMcp = cp(0xf048b); // nf-md-server
const gCfgHooks = cp(0xf06e2); // nf-md-hook
const gCfgPlugins = cp(0xf1288); // nf-md-toy_brick (LEGO)
const gCfgConn = cp(0xf015f); // nf-md-cloud — claude.ai connectors
const gCfgDirs = cp(0xf0257); // nf-md-folder_plus
// Exts.-row icons (plugin-exclusive component types) — all Material Design.
const gCfgLsp = cp(0xf0761); // nf-md-code_braces — LSP / language servers
const gCfgMonitor = cp(0xf0437); // nf-md-radar — background monitors
const gCfgTheme = cp(0xf03d8); // nf-md-palette — color themes (artist's palette)
const gCfgBin = cp(0xf0614); // nf-md-application — bin/ executables on PATH
const gCfgChannel = cp(0xf028c); // nf-md-forum — message channels (telegram/slack-style injection)
const gCfgChrome = cp(0xf268); // nf-fa-chrome — claude-in-chrome (FA exception in this MD row; if it renders blank use nf-md-google_chrome 0xf02af)
const gCfgWorkflows = cp(0xf04aa); // nf-md-sitemap — saved orchestration workflows (.claude/workflows)
const gCfgRoutines = cp(0xf00f0); // nf-md-calendar_clock — scheduled routines (.claude/routines)
const gCfgMemory = cp(0xf09d1); // nf-md-brain — auto-memory files for this project (~/.claude/projects/<slug>/memory)
// Origin-remote host badges (Repo row) — Material Design; codepoints verified against glyphnames.json.
const gGithub = cp(0xf02a4); // nf-md-github
const gGitlab = cp(0xf0ba0); // nf-md-gitlab
const gBitbucket = cp(0xf00a8); // nf-md-bitbucket
const gRepoHost = cp(0xf0ccf); // nf-md-source_repository — any other origin host
const gOk = cp(0x2714) + cp(0xfe0e); // ✔︎ heavy check + U+FE0E text-presentation selector (forces glyph, never emoji)
const gNo = cp(0x2718) + cp(0xfe0e); // ✘︎ heavy ballot X + text-presentation selector
const FULL = "█";

const HOME = homedir();
const TRANSCRIPT_BYTES = readPositiveInt(process.env.CLAUDE_STATUSLINE_TRANSCRIPT_BYTES, 1024 * 1024);

function readPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// USER CONFIG — ~/.claude/statusline-dashboard.json (CLAUDE_STATUSLINE_CONFIG overrides the path).
// It lives under ~/.claude, not next to this script, so a checkout install and a plugin install
// (which runs a staged copy from the plugin data dir) read the SAME file, and a plugin update or a
// `git pull` can never clobber it. Every key is optional; anything missing, mistyped or unknown
// falls back to the default, so a broken file degrades to the stock dashboard instead of a blank
// one. Reference: README "Configuration"; `/statusline-dashboard:configure` edits it for you.
//   rows     — which rows render, in what order (ids below). Default: all, in the stock order.
//   hide     — widget ids to drop ("host.os", "usage.api", …) or whole rows ("exts").
//   labels   — false drops the "Model / Limits / …" column (reclaims 9 cells per row).
//   bars     — false renders every gauge in its compact (no-bar) form.
//   pace     — false drops the signed pace balance from the Limits gauges.
//   clock    — "24h" (default) or "12h".
//   usageApi — false never reads the OAuth token or calls the usage API (scoped weekly + Cr gauges).
//   maxRows  — cap on content rows; can only LOWER the built-in budget (a third of the terminal).
const ROW_IDS = ["model", "limits", "usage", "turn", "activity", "repo", "config", "exts", "host", "info"];
const CONFIG_PATH = process.env.CLAUDE_STATUSLINE_CONFIG || join(HOME, ".claude", "statusline-dashboard.json");
const cfg = (() => {
  const raw = readJson(CONFIG_PATH);
  const u = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const ids = (v) => (Array.isArray(v) ? v.map((s) => String(s).toLowerCase().replace(/\.$/, "")) : null);
  const hide = new Set(ids(u.hide) || []);
  const picked = ids(u.rows)?.filter((r, i, a) => ROW_IDS.includes(r) && a.indexOf(r) === i);
  return {
    rows: (picked?.length ? picked : ROW_IDS).filter((r) => !hide.has(r)),
    hide,
    labels: u.labels !== false,
    bars: u.bars !== false,
    pace: u.pace !== false,
    clock12: String(u.clock || "").toLowerCase() === "12h",
    usageApi: u.usageApi !== false,
    maxRows: readPositiveInt(u.maxRows, Infinity),
  };
})();
// Widget gate: `on("host.os")` is false when the user hid that widget.
const on = (id) => !cfg.hide.has(id);

// Fill color: gray (BARLO) when low → yellow ≥70 → red ≥90 (original scheme). The track was
// darkened to 236 so the gray fill keeps clear contrast against it without needing a fill hue.
function usageColor(p) {
  return p >= 90 ? RED : p >= 70 ? YELLOW : BARLO;
}

// Context fills differently from rate-limit usage: chat quality starts degrading around 50%, and
// with auto-compact OFF nearing the window limit is a hard wall — so warn EARLIER than usageColor:
// yellow ≥50% (degradation onset), red ≥80% (deep / near the wall). vs usage's 70/90.
function contextColor(p) {
  return p >= 80 ? RED : p >= 50 ? YELLOW : BARLO;
}

function makeBar(pct, width = 10, colorCode = "") {
  pct = Math.max(0, Math.min(100, pct));
  const eighths = Math.round((pct / 100) * width * 8);
  const full = Math.floor(eighths / 8);
  const rem = eighths % 8;
  let bar = FULL.repeat(full);
  let used = full;

  if (rem > 0) {
    bar += String.fromCodePoint(0x2590 - rem); // partials: ▏▎▍▌▋▊▉
    used++;
  }

  bar += " ".repeat(Math.max(0, width - used));
  return `${TRACK}${colorCode}${bar}${RESET}`;
}

// Timestamps arrive as ISO strings, epoch seconds, or epoch ms — normalize to epoch ms (NaN if unparseable).
function toEpochMs(ts) {
  if (ts === null || ts === undefined || ts === "") return NaN;
  const s = String(ts).trim();
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return n > 1e12 ? n : n * 1000;
  }
  return new Date(ts).getTime();
}

function formatResetTime(ts, fmt = "HH:mm") {
  if (ts === null || ts === undefined || ts === "") return "";

  try {
    const d = new Date(toEpochMs(ts));
    if (Number.isNaN(d.getTime())) return "";

    const pad = (n) => String(n).padStart(2, "0");
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
    if (fmt === "ddd HH:mm") return `${wd} ${hm}`;
    // "date": for periods LONGER than a week (spend-limit billing periods), where a bare weekday is
    // ambiguous — "Sep 30" while the reset is ≥6 days out, then the usual weekday + time.
    if (fmt === "date") {
      if (d.getTime() - Date.now() < 6 * 24 * 3600e3) return `${wd} ${hm}`;
      const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
      return `${mon} ${d.getDate()}`;
    }
    // "auto": time only, but prepend the weekday when the reset falls on a DIFFERENT calendar
    // day than now (e.g. a 5h window that rolls past midnight → "Tue 01:00" instead of "01:00").
    if (fmt === "auto") {
      const now = new Date();
      const sameDay =
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();
      return sameDay ? hm : `${wd} ${hm}`;
    }
    return hm;
  } catch {
    return "";
  }
}

function formatCountdown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}h${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

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

function formatCost(cost) {
  const n = Number(cost) || 0;
  return `$${n.toFixed(2)}`;
}

function truncate(value, maxLen) {
  const s = String(value || "").replace(/\s+/g, " ").trim();
  return s.length <= maxLen ? s : `${s.slice(0, Math.max(0, maxLen - 3))}...`;
}

// Dotted-numeric version compare ("2.1.277" ≥ "2.1.260"). Unknown/absent version → false, so a
// version-gated behavior stays OFF when we can't tell which Claude Code is feeding us.
function versionAtLeast(version, min) {
  const parse = (v) => String(v || "").split(".").map((n) => parseInt(n, 10));
  const a = parse(version);
  const b = parse(min);
  if (!a.length || a.some((n) => !Number.isFinite(n))) return false;
  for (let i = 0; i < b.length; i++) {
    if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i];
  }
  return true;
}

function percent(current, total) {
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((current / total) * 100)));
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readTail(filePath, maxBytes) {
  try {
    const st = statSync(filePath);
    if (st.size <= maxBytes) return readFileSync(filePath, "utf8");

    const fd = openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      readSync(fd, buffer, 0, maxBytes, st.size - maxBytes);
      return buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

function git(dir, args) {
  const r = spawnSync("git", ["-C", dir, "--no-optional-locks", ...args], { encoding: "utf8", windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

// Async twin of git() — resolves to stdout on success, null on any failure. The render fires its
// git subprocesses CONCURRENTLY through this (a Windows process spawn is ~30-50ms; the old
// back-to-back spawnSync chain made git the single largest slice of every render).
function gitAsync(dir, args) {
  return new Promise((resolve) => {
    try {
      const child = spawn("git", ["-C", dir, "--no-optional-locks", ...args], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("error", () => resolve(null));
      child.on("close", (code) => resolve(code === 0 ? out : null));
    } catch {
      resolve(null);
    }
  });
}

function parseGitStatus(out) {
  if (out === null || out === undefined) return null;

  let branch = "";
  let oid = "";
  let ahead = 0;
  let behind = 0;
  let staged = 0;
  let modified = 0;
  let untracked = 0;
  let conflicts = 0;

  for (const line of out.split("\n")) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) branch = line.slice(14).trim();
    else if (line.startsWith("# branch.oid ")) oid = line.slice(13).trim();
    else if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) {
        ahead = Number(m[1]) || 0;
        behind = Number(m[2]) || 0;
      }
    } else if (line[0] === "1" || line[0] === "2") {
      const xy = line.split(" ")[1] || "..";
      if (xy[0] !== ".") staged++;
      if (xy[1] !== ".") modified++;
    } else if (line[0] === "u") conflicts++;
    else if (line[0] === "?") untracked++;
  }

  if (!branch || branch === "(detached)") {
    branch = oid && oid !== "(initial)" ? oid.slice(0, 7) : "detached";
  }

  return { branch, ahead, behind, staged, modified, untracked, conflicts };
}

// One long-form `git describe` replaces the old describe + rev-list pair (2 subprocesses → 1):
// `--long` always emits "<tag>-<count>-g<sha>", even sitting exactly on the tag. Tag names may
// themselves contain dashes (v1.2-rc1), so anchor the split on the trailing "-<N>-g<hex>".
function parseTagStatus(out) {
  const m = String(out || "").trim().match(/^(.+)-(\d+)-g[0-9a-f]+$/);
  if (!m) return null;
  return { tag: m[1], count: Number(m[2]) || 0 };
}

function basename(p) {
  if (!p) return "";
  return pathBasename(String(p).replace(/[\\/]+$/, "")) || p;
}

function displayRelative(root, currentDir) {
  if (!root || !currentDir || root === currentDir) return "";
  const rel = relative(root, currentDir);
  if (!rel || rel.startsWith("..") || /^[a-zA-Z]:/.test(rel)) return "";
  return rel.replace(/\\/g, "/");
}

// The Info. row's CWD: the LITERAL current dir, home-relativized to ~/… with forward slashes. Unlike
// the Repo headline (which is the project NAME), this always tracks exactly where you are.
function homeRelative(dir) {
  if (!dir) return "";
  const d = String(dir).replace(/\\/g, "/").replace(/\/+$/, "");
  const h = String(HOME).replace(/\\/g, "/").replace(/\/+$/, "");
  if (d.toLowerCase() === h.toLowerCase()) return "~";
  if (d.toLowerCase().startsWith(h.toLowerCase() + "/")) return "~/" + d.slice(h.length + 1);
  return d;
}

// Middle-ellipsize a path so the LEAF (where you actually are) survives long paths — keeps the head
// (~ or drive) and as many trailing segments as fit, dropping middle ones. We do this ourselves
// because packSection truncates from the RIGHT, which would otherwise eat the leaf.
function shortenPath(p, max = 40) {
  if (!p || p.length <= max) return p;
  const segs = p.split("/");
  if (segs.length <= 2) {
    const keep = Math.max(1, max - 1);
    return p.slice(0, Math.ceil(keep / 2)) + "…" + p.slice(p.length - Math.floor(keep / 2));
  }
  const first = segs[0];
  let tail = segs.slice(1);
  while (tail.length > 1 && `${first}/…/${tail.join("/")}`.length > max) tail = tail.slice(1);
  return `${first}/…/${tail.join("/")}`;
}

function countFiles(dir, pattern) {
  try {
    const files = readdirSync(dir);
    return pattern ? files.filter((f) => pattern.test(f)).length : files.length;
  } catch {
    return 0;
  }
}

// Entry names in a dir (filtered by `pattern`, with `strip` removed from each); [] if missing.
function listEntryNames(dir, { pattern, strip } = {}) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  if (pattern) names = names.filter((f) => pattern.test(f));
  return strip ? names.map((f) => f.replace(strip, "")) : names;
}

// Count *.md files recursively under a dir (0 if missing). Used for config dirs Claude Code
// discovers recursively (agents, rules) where nested subdirs are organizational, not separate.
function countMdRecursive(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let n = 0;
  for (const e of entries) {
    if (e.isDirectory()) n += countMdRecursive(join(dir, e.name));
    else if (/\.md$/i.test(e.name)) n++;
  }
  return n;
}

// Enterprise/managed config dir — cross-platform. Claude Code reads org-managed settings, MCP,
// and CLAUDE.md from here (docs: code.claude.com/docs/en/settings#settings-files).
//   win32: C:\Program Files\ClaudeCode   darwin: /Library/Application Support/ClaudeCode
//   linux/WSL/other: /etc/claude-code
// (We don't probe the Windows registry policy path HKLM/HKCU\SOFTWARE\Policies\ClaudeCode — that
// needs a `reg query` subprocess on every render; the file-based deployment is the common case.)
function managedDir() {
  if (process.env.CLAUDE_STATUSLINE_MANAGED_DIR) return process.env.CLAUDE_STATUSLINE_MANAGED_DIR; // test/relocate override
  if (process.platform === "win32") return "C:\\Program Files\\ClaudeCode";
  if (process.platform === "darwin") return "/Library/Application Support/ClaudeCode";
  return "/etc/claude-code";
}
// Windows registry managed policy: HKLM (admin) or HKCU (user) \SOFTWARE\Policies\ClaudeCode, a
// `Settings` value (REG_SZ/REG_EXPAND_SZ) holding a JSON blob with the SAME schema as
// managed-settings.json (hooks, mcpServers, claudeMd, …). One `reg query` per hive — only runs
// inside the cached configCounts compute, never on every render. Returns the parsed object or null.
function readRegManaged() {
  if (process.platform !== "win32") return null;
  for (const hive of ["HKLM", "HKCU"]) {
    try {
      const r = spawnSync("reg", ["query", `${hive}\\SOFTWARE\\Policies\\ClaudeCode`, "/v", "Settings"], {
        encoding: "utf8",
        windowsHide: true, // console child from a hidden process would flash a window
      });
      if (r.error || r.status !== 0 || !r.stdout) continue;
      const m = r.stdout.match(/\bSettings\b\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)/);
      if (m) {
        const obj = JSON.parse(m[1].trim());
        if (obj && typeof obj === "object") return obj; // HKLM wins over HKCU
      }
    } catch {}
  }
  return null;
}
// Enterprise/managed config, resolved to OBJECTS so hooks/mcp/claudeMd can be counted from either
// the file-based deployment (managedDir) or the Windows registry policy (registry wins, per docs).
function detectManaged() {
  const dir = managedDir();
  const settings = readRegManaged() || readJson(join(dir, "managed-settings.json")) || null;
  // `managedMcpServers` (managed-settings key, CC v2.1.259+): org-provided REMOTE servers layered
  // alongside the user's own. http/sse only — CC drops any entry without an https:// `url` (a
  // `command` entry is skipped), so mirror that filter or a rejected entry would inflate the count.
  const provided = Object.fromEntries(
    Object.entries(settings?.managedMcpServers || {}).filter(([, v]) => /^https:\/\//i.test(String(v?.url || "")) && !v?.command),
  );
  const mcpServers = { ...(readJson(join(dir, "managed-mcp.json"))?.mcpServers || {}), ...(settings?.mcpServers || {}), ...provided };
  const claudeMd = existsSync(join(dir, "CLAUDE.md")) || !!settings?.claudeMd;
  return { dir, settings, mcpServers, claudeMd };
}

function fileExists(filePath) {
  try {
    return existsSync(filePath);
  } catch {
    return false;
  }
}

// Config counts are broken down by Claude Code's ACTUAL config scopes (the docs renamed the old
// names: "global"→"user", old "project"→"local"). Order shown broad→narrow:
//   m = MANAGED  enterprise config under managedDir() — shown only when present on the machine
//   u = USER     ~/.claude/… (loads in every project)
//   p = PROJECT  committed/shared in the repo (.claude/…, .mcp.json, CLAUDE.md)
//   l = LOCAL    your uncommitted per-project overrides (.claude/settings.local.json,
//                ~/.claude.json projects[cwd], CLAUDE.local.md)
// Items return whichever of {m,u,p,l} they support; the render marks slots an item type CANNOT
// have "-" (truly N/A) and shows a count (0 if none) for the scopes it CAN.
//
// MCP servers (docs: code.claude.com/docs/en/mcp#mcp-installation-scopes), de-duped by precedence
// Local > Project > User so a server defined in several places is counted once:
//   u = ~/.claude.json top-level mcpServers · p = repo .mcp.json · l = ~/.claude.json projects[cwd]
//   m = managedDir()/managed-mcp.json
function mcpBreakdown(projectDir, currentDir, managed, state) {
  const cj = readJson(join(HOME, ".claude.json"));
  const user = new Set();
  const local = new Set();
  const project = new Set();
  const norm = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  // user/local servers are ON unless toggled off (disabledMcpServers) or pending auth (needsAuth).
  const addOn = (set, obj) => {
    if (obj && typeof obj === "object")
      for (const k of Object.keys(obj)) if (!state.disabled.has(k) && !state.needsAuth.has(k)) set.add(k);
  };
  addOn(user, cj?.mcpServers); // USER scope = ~/.claude.json top-level (all projects)
  addOn(user, readJson(join(HOME, ".config", "claude-code", "mcp.json"))?.mcpServers);
  if (cj?.projects && typeof cj.projects === "object") {
    const wanted = new Set([norm(projectDir), norm(currentDir)].filter(Boolean));
    for (const key of Object.keys(cj.projects)) {
      if (wanted.has(norm(key))) addOn(local, cj.projects[key]?.mcpServers); // LOCAL = this project's entry
    }
  }
  // PROJECT (.mcp.json) servers count only once APPROVED (enableAll or in enabledMcpjsonServers) and
  // not disabled/rejected — a "pending approval" server isn't running, so it doesn't affect the chat.
  if (projectDir) {
    const pj = readJson(join(projectDir, ".mcp.json"))?.mcpServers;
    if (pj && typeof pj === "object")
      for (const k of Object.keys(pj))
        if (
          (state.enableAll || state.approvedJson.has(k)) &&
          !state.disabled.has(k) &&
          !state.rejectedJson.has(k) &&
          !state.needsAuth.has(k)
        )
          project.add(k);
  }
  // precedence Local > Project > User: count each server once, at its highest-precedence source.
  for (const k of local) { project.delete(k); user.delete(k); }
  for (const k of project) user.delete(k);
  const m = Object.keys(managed?.mcpServers || {}).length; // managed-mcp.json + managed settings mcpServers/managedMcpServers
  return { m, u: user.size, p: project.size, l: local.size };
}

// Hooks are REGISTERED in a `hooks` event-map (settings.json, a plugin's hooks/hooks.json, or a
// managed/registry settings blob), NOT as files in a dir. Sum the hook commands in one such map.
function countHookMap(hooks) {
  if (!hooks || typeof hooks !== "object") return 0;
  let n = 0;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) n += Array.isArray(g?.hooks) ? g.hooks.length : 1;
  }
  return n;
}
function hookCountInFile(filePath) {
  return countHookMap(readJson(filePath)?.hooks);
}

// Hooks live in settings.json `hooks` maps, summed across the settings scopes (same precedence
// chain as settings): m = managedDir()/managed-settings.json · u = ~/.claude/settings.json ·
// p = repo .claude/settings.json · l = repo .claude/settings.local.json.
function hooksBreakdown(projectDir, managed) {
  return {
    m: countHookMap(managed?.settings?.hooks), // managed-settings.json or registry policy blob
    u: hookCountInFile(join(HOME, ".claude", "settings.json")),
    p: projectDir ? hookCountInFile(join(projectDir, ".claude", "settings.json")) : 0,
    l: projectDir ? hookCountInFile(join(projectDir, ".claude", "settings.local.json")) : 0,
  };
}

// Dir-based config (agents/commands/rules): u = USER ~/.claude/<sub> (loads everywhere); p =
// PROJECT repo .claude/<sub>. These have NO local or managed form, so the render marks those slots
// "-". `recursive` counts *.md down nested subdirs (agents & rules load that way per the docs);
// otherwise count immediate entries matching `pattern`. (Skills have their own merged helper below.)
function dirBreakdown(projectDir, sub, { pattern, recursive = false } = {}) {
  const count = recursive ? countMdRecursive : (d) => countFiles(d, pattern);
  return {
    u: count(join(HOME, ".claude", sub)),
    p: projectDir ? count(join(projectDir, ".claude", sub)) : 0,
    l: 0,
  };
}

// Skills now subsume output-styles (styles are migrating to skills:
// https://support.claude.com/en/articles/10181068-styles-are-moving-to-skills). Per scope, union
// skill-subdir names with output-style basenames so a style already reimplemented as a same-named
// skill is counted once. x (plugin) skills come from enabled plugins; styles have no plugin form,
// so x is just the plugin skill count.
function skillsBreakdown(projectDir, pluginSkills) {
  const namesAt = (root) =>
    new Set([
      ...listEntryNames(join(root, "skills")), // each skill = a subdir
      ...listEntryNames(join(root, "output-styles"), { pattern: /\.md$/i, strip: /\.md$/i }),
    ]);
  return {
    u: namesAt(join(HOME, ".claude")).size,
    p: projectDir ? namesAt(join(projectDir, ".claude")).size : 0,
    l: 0,
    x: pluginSkills,
  };
}

// Enabled plugin BASE names (`true` entries) in an enabledPlugins map, with the @marketplace
// suffix stripped so the same plugin enabled from two marketplaces counts once.
function enabledPluginNamesFromMap(ep) {
  if (!ep || typeof ep !== "object") return [];
  return Object.entries(ep)
    .filter(([, v]) => v === true)
    .map(([k]) => k.split("@")[0]);
}
// Same, read from one settings.json file on disk.
function pluginEnabledNames(settingsPath) {
  return enabledPluginNamesFromMap(readJson(settingsPath)?.enabledPlugins);
}

// Plugins enabled across the settings scopes, de-duped by base name (counted once, attributed to
// the broadest scope): m = MANAGED enabledPlugins (enterprise settings can force-enable plugins) ·
// u = USER ~/.claude/settings.json (not already managed) · p = PROJECT repo settings.json (not
// already managed/user) · l = LOCAL repo settings.local.json (not already managed/user/project).
function pluginsBreakdown(projectDir, trusted, managed) {
  const m = new Set(enabledPluginNamesFromMap(managed?.settings?.enabledPlugins));
  const u = new Set();
  for (const n of pluginEnabledNames(join(HOME, ".claude", "settings.json"))) if (!m.has(n)) u.add(n);
  const p = new Set();
  const l = new Set();
  if (projectDir && trusted) { // project/local enablement only takes effect once the workspace is trusted
    for (const n of pluginEnabledNames(join(projectDir, ".claude", "settings.json")))
      if (!m.has(n) && !u.has(n)) p.add(n);
    for (const n of pluginEnabledNames(join(projectDir, ".claude", "settings.local.json")))
      if (!m.has(n) && !u.has(n) && !p.has(n)) l.add(n);
  }
  return { m: m.size, u: u.size, p: p.size, l: l.size };
}

// Effective ENABLED plugin keys (`name@marketplace`), merged across settings scopes with
// precedence user < project < local (later layers override), keeping only finally-true entries.
// `trusted`: project/local enabledPlugins only TAKE EFFECT in a trusted workspace (settings from
// an untrusted project don't load), so when untrusted we consider ONLY user-scope enablement.
function pluginEnabledKeys(projectDir, trusted) {
  const merged = {};
  const layer = (path) => {
    const ep = readJson(path)?.enabledPlugins;
    if (ep && typeof ep === "object") Object.assign(merged, ep);
  };
  layer(join(HOME, ".claude", "settings.json")); // user (lowest precedence) — always loads
  if (projectDir && trusted) {
    layer(join(projectDir, ".claude", "settings.json")); // project
    layer(join(projectDir, ".claude", "settings.local.json")); // local (highest)
  }
  return Object.keys(merged).filter((k) => merged[k] === true);
}

// Resolve an enabled plugin key to its on-disk root via ~/.claude/plugins/installed_plugins.json
// (each record carries the exact installPath incl. the version dir). Prefer the copy flagged
// `.in_use`; else the most recently installed record. Cross-platform: paths come straight from CC.
function pluginInstallPath(key, installed) {
  const recs = installed?.plugins?.[key];
  if (!Array.isArray(recs) || !recs.length) return null;
  for (const r of recs) if (r?.installPath && existsSync(join(r.installPath, ".in_use"))) return r.installPath;
  return recs[recs.length - 1]?.installPath || recs[0]?.installPath || null;
}

// Component declarations can live INLINE in a plugin's MARKETPLACE entry (with `strict:false`)
// instead of the plugin's own files — the official LSP plugins (typescript-lsp, pyright-lsp, …) do
// exactly this: their installed dir is a LICENSE/README stub and `lspServers` lives in
// marketplace.json. Resolve a plugin key (`name@marketplace`) to that entry object ({} if none).
// `cache` memoizes the per-marketplace file read across the many plugins in one count pass.
function marketplaceEntry(key, cache) {
  const at = String(key).indexOf("@");
  if (at < 0) return {};
  const base = key.slice(0, at);
  const mp = key.slice(at + 1);
  if (!mp) return {};
  if (!cache.has(mp)) {
    const j = readJson(join(HOME, ".claude", "plugins", "marketplaces", mp, ".claude-plugin", "marketplace.json"));
    const list = Array.isArray(j?.plugins)
      ? j.plugins
      : j?.plugins && typeof j.plugins === "object"
        ? Object.values(j.plugins)
        : [];
    cache.set(mp, list);
  }
  return cache.get(mp).find((p) => p && p.name === base) || {};
}

// Components an ENABLED plugin bundles, summed across all enabled plugins (de-duped by base name so
// a plugin enabled from two marketplaces counts once). This is the "plugin" (x) scope — the lowest-
// precedence source for agents/commands/skills/hooks/MCP (docs: plugins-reference component dirs).
function pluginComponentCounts(projectDir, trusted, disabled, needsAuth) {
  const out = { agents: 0, commands: 0, skills: 0, hooks: 0, mcps: 0, workflows: 0, lsp: 0, monitors: 0, themes: 0, bin: 0, channels: 0 };
  const installed = readJson(join(HOME, ".claude", "plugins", "installed_plugins.json"));
  const seen = new Set();
  const channelNames = new Set(); // plugin-DECLARED channel names (de-duped across plugins)
  const mpCache = new Map(); // memoize marketplace.json reads across plugins
  for (const key of pluginEnabledKeys(projectDir, trusted)) {
    const base = key.split("@")[0];
    if (seen.has(base)) continue;
    const root = pluginInstallPath(key, installed);
    if (!root || !existsSync(root)) continue;
    seen.add(base);
    // Effective inline-component source: the plugin's own plugin.json merged OVER its marketplace
    // entry (plugin.json wins). For stub plugins the entry supplies lspServers/mcpServers/etc.; for
    // normal plugins the entry is empty and plugin.json/files provide everything. (File-based reads
    // below still come from the install dir `root`.)
    const eff = { ...marketplaceEntry(key, mpCache), ...(readJson(join(root, ".claude-plugin", "plugin.json")) || {}) };
    out.agents += countMdRecursive(join(root, "agents"));
    out.commands += countMdRecursive(join(root, "commands"));
    out.skills += countFiles(join(root, "skills")); // each skill = a subdir
    out.skills += countFiles(join(root, "output-styles"), /\.md$/i); // plugin styles fold into skills (styles→skills migration)
    out.hooks += countHookMap(readJson(join(root, "hooks", "hooks.json"))?.hooks) + countHookMap(eff.hooks);
    // plugin MCP servers are identified as "plugin:<base>:<server>" in disabledMcpServers — skip the off ones.
    // NOTE: a plugin .mcp.json declares servers at the TOP LEVEL ({ "<name>": {...} }), NOT wrapped in
    // `mcpServers` like a project .mcp.json. Accept either form (prefer the wrapper when present).
    const mcpFile = readJson(join(root, ".mcp.json")) || {};
    const fileServers = mcpFile.mcpServers && typeof mcpFile.mcpServers === "object" ? mcpFile.mcpServers : mcpFile;
    const servers = { ...fileServers, ...(eff.mcpServers || {}) };
    for (const s of Object.keys(servers))
      if (!disabled.has(`plugin:${base}:${s}`) && !needsAuth.has(`plugin:${base}:${s}`)) out.mcps++;

    // --- Plugin-exclusive component types (the "Exts." row). All x-scope only. ---
    // LSP: `.lsp.json` is a TOP-LEVEL lang→config map (NOT wrapped in `lspServers` like a project
    // file); inline form uses eff.lspServers as an object. Count distinct language keys.
    const lspFile = readJson(join(root, ".lsp.json"));
    const lspInline = eff.lspServers && typeof eff.lspServers === "object" && !Array.isArray(eff.lspServers) ? eff.lspServers : {};
    const lspMap = lspFile && typeof lspFile === "object" && !Array.isArray(lspFile) ? lspFile : {};
    out.lsp += new Set([...Object.keys(lspMap), ...Object.keys(lspInline)]).size;

    // Monitors: `monitors/monitors.json` is a JSON ARRAY; inline `experimental.monitors` (an array,
    // or a path string we don't resolve) REPLACES the default file per the path-behavior rules.
    const monInline = eff.experimental?.monitors ?? eff.monitors;
    if (Array.isArray(monInline)) out.monitors += monInline.length;
    else if (typeof monInline !== "string") {
      const monFile = readJson(join(root, "monitors", "monitors.json"));
      if (Array.isArray(monFile)) out.monitors += monFile.length;
    } // string = path form (replaces default), left uncounted

    // Themes: JSON files in themes/; an inline experimental.themes array of paths replaces the default.
    const themeInline = eff.experimental?.themes ?? eff.themes;
    if (Array.isArray(themeInline)) out.themes += themeInline.length;
    else if (typeof themeInline !== "string") out.themes += countFiles(join(root, "themes"), /\.json$/i);

    // Workflows: "workflows" is in CC's plugin component-type list alongside agents/commands/etc.
    // — count the plugin's workflows/ entries (scripts, so no .md filter).
    out.workflows += countFiles(join(root, "workflows"));
    // bin/: executables added to PATH (count all entries).
    out.bin += countFiles(join(root, "bin"));
    // channels[]: a plugin MAY declare message channels inline (string name, or {name|id}). In
    // practice the official channel plugins (e.g. discord) DON'T — they register at runtime and the
    // actual install is recorded under ~/.claude/channels/<name>/ (see userChannelNames), and CC's
    // plugin catalog doesn't model channels as a component at all. So this is a near-dead forward-
    // compat path; we collect names only so configCounts can de-dupe a declared channel against an
    // installed one and avoid double-counting.
    if (Array.isArray(eff.channels))
      for (const ch of eff.channels) {
        const name = typeof ch === "string" ? ch : ch && (ch.name || ch.id);
        if (name) channelNames.add(name);
      }
  }
  out.channels = channelNames.size; // numeric tally (kept for parity with the other component counts)
  out.channelNames = channelNames; // names, for de-dup against user-installed channels
  return out;
}

// claude.ai account connectors (Slack/Jira/etc.) — remote, account-level (tied to your login), not
// in any local/project config. Local trace: ~/.claude.json `claudeAiMcpEverConnected` (names that
// have ever connected); we drop any currently in mcp-needs-auth-cache.json. NO managed-vs-user
// provenance is exposed on disk (researched: oauthAccount carries your org role, not per-connector
// source), so this is a single flat count — no m/u/p/l/x breakdown is possible.
function connectorsBreakdown() {
  const arr = readJson(join(HOME, ".claude.json"))?.claudeAiMcpEverConnected;
  if (!Array.isArray(arr)) return { u: 0 };
  const needsAuth = readJson(join(HOME, ".claude", "mcp-needs-auth-cache.json")) || {};
  return { u: arr.filter((name) => !(name in needsAuth)).length };
}

// Message channels installed at USER scope. Each configured channel lives in its OWN directory under
// ~/.claude/channels/<name>/ — e.g. the discord plugin's setup (/discord:configure) writes a `.env`
// (bot token) + `access.json` (allowlist/policy) into ~/.claude/channels/discord/. This dir is the
// REAL "channel installed" signal: the official channel plugins don't declare a static `channels[]`
// in their manifest and CC's plugin catalog doesn't track channels as a component, so counting plugin
// manifests alone (plug.channels) misses every actually-installed channel. A non-empty subdir = one
// configured channel; an empty leftover dir is ignored. Returns the set of channel names.
function userChannelNames() {
  const dir = join(HOME, ".claude", "channels");
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return new Set();
  }
  const names = new Set();
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    let configured = false;
    try {
      configured = readdirSync(join(dir, e.name)).length > 0; // holds config (.env / access.json / …)
    } catch {}
    if (configured) names.add(e.name);
  }
  return names;
}

// A workspace's PROJECT/LOCAL executable config only loads once you've accepted its trust dialog;
// CC records that as `hasTrustDialogAccepted` on the project entry in ~/.claude.json. Pass several
// candidate dirs (cwd, project root, AND the MAIN repo root) — a linked worktree lives under
// `<main>/.claude/worktrees/<wt>` and isn't its own project entry, so it inherits the main repo's
// trust. Untrusted → executable project/local scopes are zeroed. (User/managed not trust-gated.)
function isWorkspaceTrusted(dirs) {
  const projects = readJson(join(HOME, ".claude.json"))?.projects;
  if (!projects || typeof projects !== "object") return false;
  const norm = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const wanted = new Set(dirs.filter(Boolean).map(norm));
  for (const [k, v] of Object.entries(projects)) {
    if (wanted.has(norm(k)) && v?.hasTrustDialogAccepted === true) return true;
  }
  return false;
}

// Per-server MCP enable/approval state from the active workspace's ~/.claude.json project entry
// (worktrees fall back to the main repo). Drives "only count MCP that's actually ON":
//   disabledMcpServers      — servers toggled OFF in /mcp (plain name, or "plugin:<plugin>:<srv>")
//   enabledMcpjsonServers   — project (.mcp.json) servers you APPROVED
//   disabledMcpjsonServers  — project servers you REJECTED
//   enableAllProjectMcpServers — approve every project server
// (Live connection failures aren't recorded on disk, so "configured+approved" is the best proxy
// for "running" we can read.)
function mcpServerState(dirs) {
  const projects = readJson(join(HOME, ".claude.json"))?.projects || {};
  const norm = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const want = dirs.filter(Boolean).map(norm);
  let entry = null;
  for (const w of want) {
    for (const [k, v] of Object.entries(projects)) if (norm(k) === w) { entry = v; break; }
    if (entry) break;
  }
  const arr = (x) => (Array.isArray(x) ? x : []);
  // Servers pending OAuth (401/403), keyed by name or "plugin:<plugin>:<srv>" — not usable, so
  // excluded from counts (same spirit as disabled). The only on-disk "currently broken" signal.
  const needsAuth = new Set(Object.keys(readJson(join(HOME, ".claude", "mcp-needs-auth-cache.json")) || {}));
  return {
    disabled: new Set(arr(entry?.disabledMcpServers)),
    needsAuth,
    approvedJson: new Set(arr(entry?.enabledMcpjsonServers)),
    rejectedJson: new Set(arr(entry?.disabledMcpjsonServers)),
    enableAll: entry?.enableAllProjectMcpServers === true,
  };
}

function statMtime(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function hashPath(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Memoize a slow, rarely-changing result to a temp file keyed by the mtimes of sigPaths
// (+ an extra signature). Avoids re-parsing big files (e.g. ~/.claude.json) on every render.
// THIS script's own mtime (Bun.main) is folded into the key so editing the statusline busts the
// cache — otherwise a newly-added computed field reads stale until a watched config file changes.
function cachedByMtime(key, sigPaths, extraSig, compute) {
  const sig = sigPaths.map(statMtime).join(":") + "|" + String(extraSig) + "|" + statMtime(Bun.main);
  const file = (process.env.TEMP || process.env.TMP || "/tmp").replace(/\\/g, "/") + "/sl-cache-" + key + ".json";
  const prev = readJson(file);
  if (prev && prev.sig === sig) return prev.val ?? null;
  const val = compute();
  try {
    require("node:fs").writeFileSync(file, JSON.stringify({ sig, val }));
  } catch {}
  return val;
}

// CC's project-dir path encoding (every non-alphanumeric char → "-", e.g. "C:\Users\a\repo" →
// "C--Users-a-repo") applied to a dir → its ~/.claude/projects/<slug>/memory path.
function memorySlugDir(dir) {
  return join(HOME, ".claude", "projects", String(dir).replace(/[^a-zA-Z0-9]/g, "-"), "memory");
}

// Auto-memory dir resolution (docs: memory#auto-memory; research from PR #1). Off (null) when
// CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 or autoMemoryEnabled:false in any settings scope (highest
// precedence wins). Location: an autoMemoryDirectory override (any scope, ~/ expanded, holds the
// memory files directly) else CC's per-project ~/.claude/projects/<slug>/memory. That project dir
// ALSO holds this session's transcript, so transcript_path is the authoritative anchor — CC's own
// encoding, no slug guessing. Fallback slugs: the MAIN repo root (a linked worktree keys memory by
// the main root while its transcript is keyed by cwd), then the launch dir. First dir that exists
// wins; none existing → null (no memory yet).
function memoryDir(transcriptPath, mainRoot, launchDir, scopeSettings) {
  if (process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === "1") return null;
  const pick = (key) => {
    for (const s of scopeSettings) if (s && s[key] !== undefined) return s[key]; // first defined wins (precedence)
    return undefined;
  };
  if (pick("autoMemoryEnabled") === false) return null;
  const dirs = [];
  const override = pick("autoMemoryDirectory");
  if (typeof override === "string" && override)
    dirs.push(override.startsWith("~/") ? join(HOME, override.slice(2)) : override);
  if (transcriptPath) dirs.push(join(dirname(transcriptPath), "memory")); // sibling of this session's transcript
  if (mainRoot) dirs.push(memorySlugDir(mainRoot)); // worktree → main-root keyed memory
  if (launchDir) dirs.push(memorySlugDir(launchDir));
  for (const d of dirs) if (existsSync(d)) return d;
  return null;
}

// Each entry is a per-scope {m,u,p,l} breakdown (see the scope helpers above for what each means).
function configCounts(projectDir, addedDirs, currentDir, mainRoot, launchDir, transcriptPath, ccVersion) {
  if (!projectDir) return null;
  const managed = detectManaged();
  // PROJECT/LOCAL scope reads from `projDir` (the project root). If that root IS the user's home
  // dir, its `.claude/` is literally `~/.claude/` — the USER scope — so reading it again as
  // project/local would DOUBLE-COUNT user config (happens when Claude is launched directly in ~,
  // outside any repo). Treat home as "no project": project/local then correctly resolve to 0.
  // We only ever read ONE project root (the git toplevel, or cwd if non-git) — never a parent
  // container's or sibling/child repos' `.claude/`, so a dir like ~/Repos can't pull in sub-repos.
  const norm = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const projDir = norm(projectDir) === norm(HOME) ? null : projectDir;
  // Trust gate (docs: untrusted workspace blocks all EXECUTABLE project/local config until you
  // accept its trust dialog). Untrusted → project/local hooks, MCP, agents, commands, skills, and
  // project/local-enabled plugins do NOT load. CONTENT config still loads (CLAUDE.md, rules) so
  // those are NOT gated. (Output-styles now count under skills, which IS gated.) User/managed
  // scopes are never trust-gated.
  const trusted = !projDir || isWorkspaceTrusted([currentDir, projDir, mainRoot]); // mainRoot → worktrees inherit trust
  const mcpState = mcpServerState([currentDir, projDir, mainRoot]); // per-server enable/approval (worktree → main)
  const plug = pluginComponentCounts(projDir, trusted, mcpState.disabled, mcpState.needsAuth); // ENABLED-plugin components (x scope)
  const withX = (b, x) => ({ ...b, x }); // attach the plugin-scope count to a breakdown
  // Whole-repo recursive count of a named doc via git (tracked + untracked-non-ignored, so
  // node_modules/.git/etc. are skipped). Root + any nested copy. 0 outside a repo. Project scope.
  const docCount = (name) => {
    if (!projDir) return 0;
    const out = git(projDir, ["ls-files", "--cached", "--others", "--exclude-standard", name, `*/${name}`]);
    if (out === null) return 0;
    return out.split("\n").filter((l) => l.trim() !== "").length;
  };
  // Instruction files (CLAUDE.md + natively-loaded AGENTS.md), counted per scope — each is a
  // distinct file that loads into context:
  // m = managed (<managedDir>/CLAUDE.md or the `claudeMd` key in managed settings/registry) ·
  // u = user (~/.claude/CLAUDE.md) · p = repo recursive committed count · l = CLAUDE.local.md.
  // AGENTS.md: CC v2.1.277+ reads it NATIVELY (before that it loaded only via a CLAUDE.md @-import,
  // which we can't see and never counted). Which files load is the built-in agents-md plugin's
  // `instructionFiles` option — read from managed > user settings ONLY (CC ignores it in project/
  // local files):
  //   claude-md-or-agents-md (default) — AGENTS.md ONLY when no CLAUDE.md, .claude/CLAUDE.md or
  //       CLAUDE.local.md sits in the project root or any dir above it (~/.claude/CLAUDE.md and
  //       the managed one don't count for that check, and keep loading alongside)
  //   claude-md-and-agents-md — both together · claude-md — never AGENTS.md
  //   managed-only — only the managed CLAUDE.md (+ auto memory); u/p/l all drop out
  // Off entirely under disableAllHooks / allowManagedHooksOnly (it's a plugin). NOT detectable
  // from here: the feature-flag gate (Bedrock/Vertex/telemetry-off sessions) and the first session
  // after an upgrade — there the count can read one high until a CLAUDE.md exists.
  const claudeMd = () => {
    const userSettings = readJson(join(HOME, ".claude", "settings.json"));
    const pickU = (key) => managed?.settings?.[key] ?? userSettings?.[key];
    const agentsNative =
      versionAtLeast(ccVersion, "2.1.277") &&
      pickU("disableAllHooks") !== true &&
      managed?.settings?.allowManagedHooksOnly !== true;
    const optOf = (st) => st?.pluginConfigs?.["agents-md@builtin"]?.options?.instructionFiles;
    const mode = agentsNative ? optOf(managed?.settings) || optOf(userSettings) || "claude-md-or-agents-md" : "claude-md";
    const c = {
      m: managed.claudeMd ? 1 : 0,
      u: existsSync(join(HOME, ".claude", "CLAUDE.md")) ? 1 : 0,
      p: docCount("CLAUDE.md"),
      l: projDir && existsSync(join(projDir, "CLAUDE.local.md")) ? 1 : 0,
    };
    if (mode === "managed-only") return { ...c, u: 0, p: 0, l: 0 };
    if (mode === "claude-md-and-agents-md") c.p += docCount("AGENTS.md");
    else if (mode === "claude-md-or-agents-md" && projDir) {
      // Walk root-ward from the project root looking for any CLAUDE.md that suppresses AGENTS.md.
      let shadowed = false;
      for (let d = projDir, prev = ""; d && d !== prev; prev = d, d = dirname(d)) {
        const isHome = norm(d) === norm(HOME); // ~/.claude/CLAUDE.md is USER scope — doesn't count
        if (
          existsSync(join(d, "CLAUDE.md")) ||
          existsSync(join(d, "CLAUDE.local.md")) ||
          (!isHome && existsSync(join(d, ".claude", "CLAUDE.md")))
        ) { shadowed = true; break; }
      }
      if (!shadowed) c.p += docCount("AGENTS.md");
    }
    return c;
  };
  // Build the EXECUTABLE project/local-bearing breakdowns, then zero their project/local slots when
  // untrusted (they don't load). CONTENT items (rules, styles, CLAUDE.md) are built un-gated below.
  const hooks = withX(hooksBreakdown(projDir, managed), plug.hooks);
  const mcps = withX(mcpBreakdown(projDir, currentDir, managed, mcpState), plug.mcps);
  const agents = withX(dirBreakdown(projDir, "agents", { recursive: true }), plug.agents); // recursive
  const commands = withX(dirBreakdown(projDir, "commands", { pattern: /\.md$/ }), plug.commands);
  const skills = skillsBreakdown(projDir, plug.skills); // skills + output-styles, deduped by name
  // Workflows (saved orchestration scripts) + routines (scheduled agents): both are dirs CC
  // discovers at user AND project scope (verified in the v2.1.226 binary's .claude subdir list —
  // `.claude/workflows` / `.claude/routines` are resolved per-project alongside agents/commands).
  // Workflow scripts aren't .md, so count all entries. Workflows also exist as a plugin component
  // type (x); routines don't.
  const workflows = withX(dirBreakdown(projDir, "workflows", {}), plug.workflows);
  const routines = dirBreakdown(projDir, "routines", {});
  if (!trusted) {
    hooks.p = hooks.l = 0; // hooks: project + local blocked
    mcps.p = mcps.l = 0; // MCP: project + local blocked
    agents.p = commands.p = skills.p = 0; // project agents/commands/skills not discovered (no local form)
    workflows.p = routines.p = 0; // executable project config — blocked untrusted, like the above
    // plugin (x) counts already exclude project/local-enabled plugins via plug (trust-aware);
    // the plugins-widget p/l are gated inside pluginsBreakdown(projDir, trusted) below.
  }
  // claude-in-chrome (built-in browser MCP) counts as "enabled" only when the extension is installed,
  // the feature toggle is on, AND onboarding is complete — all three readable locally. Live
  // "connected" status is session-only, so this reflects ENABLED, not connected.
  const cjr = readJson(join(HOME, ".claude.json")) || {};
  const chromeEnabled =
    cjr.cachedChromeExtensionInstalled === true &&
    cjr.claudeInChromeDefaultEnabled === true &&
    cjr.hasCompletedClaudeInChromeOnboarding === true;
  // Channels: USER-scope installs under ~/.claude/channels/ (the authoritative signal) + any plugin-
  // DECLARED channel not already installed (de-duped by name, so a configured channel that a plugin
  // also declares counts once, at user scope). In practice the plugin-declared set is empty.
  const userChans = userChannelNames();
  const xChannels = [...(plug.channelNames || [])].filter((n) => !userChans.has(n)).length;
  // Auto-memory count: individual memory .md files; MEMORY.md is the index, not a memory. The
  // enable/location settings follow the settings precedence chain (managed > local > project >
  // user); project & local settings only take effect once the workspace is trusted — same gate as
  // every other project/local read here.
  const memDir = memoryDir(transcriptPath, mainRoot, launchDir, [
    managed?.settings, // m (highest precedence)
    trusted && projDir ? readJson(join(projDir, ".claude", "settings.local.json")) : null, // l
    trusted && projDir ? readJson(join(projDir, ".claude", "settings.json")) : null, // p
    readJson(join(HOME, ".claude", "settings.json")), // u (lowest)
  ]);
  const memoryCount = memDir
    ? Math.max(0, countFiles(memDir, /\.md$/i) - (fileExists(join(memDir, "MEMORY.md")) ? 1 : 0))
    : 0;
  return {
    managed, // {dir, settings, mcpServers, claudeMd} — source objects the m-scope counts read from
    chrome: chromeEnabled, // claude-in-chrome enabled (extension installed + toggle on + onboarded)
    trusted, // false → executable project/local scopes zeroed (untrusted workspace)
    claude: claudeMd(), // CONTENT — loads untrusted, not gated
    memory: { u: memoryCount }, // auto-memory — per-project, user-level storage; flat count
    agents,
    commands,
    skills,
    workflows,
    routines,
    rules: dirBreakdown(projDir, "rules", { recursive: true }), // CONTENT — loads untrusted, not gated
    mcps,
    hooks,
    plugins: pluginsBreakdown(projDir, trusted, managed),
    connectors: connectorsBreakdown(),
    dirs: { l: Array.isArray(addedDirs) ? addedDirs.length : 0 }, // session-added dirs (local-ish)
    // Plugin-bundled component types → the "Exts." row. x-only except themes (also in
    // ~/.claude/themes/) and channels (also in ~/.claude/channels/) — both carry a u/x breakdown.
    lsp: { x: plug.lsp },
    monitors: { x: plug.monitors },
    themes: { u: countFiles(join(HOME, ".claude", "themes"), /\.json$/i), x: plug.themes },
    bin: { x: plug.bin },
    channels: { u: userChans.size, x: xChannels }, // user-installed (~/.claude/channels) + plugin-declared
  };
}

const SLASH_COMMAND_TAG_RE = /<command-name>([^<]+)<\/command-name>/;

function createTranscriptState() {
  return {
    toolUses: new Map(),
    completedToolCount: 0,
    totalToolCalls: 0,
    lastTool: null,
    runningToolIds: new Set(),
    lastTodoWriteInput: null,
    activeAgentIds: new Set(),
    completedAgentCount: 0,
    tasks: new Map(),
    nextTaskId: 1,
    pendingTaskCreates: new Map(),
    pendingTaskUpdates: new Map(),
    activeSlashCommand: null,
    sessionName: null,
    sessionStartTime: null,
  };
}

function normalizeTaskStatus(status) {
  switch (status) {
    case "not_started":
      return "pending";
    case "running":
      return "in_progress";
    case "complete":
    case "done":
      return "completed";
    default:
      return status;
  }
}

function processTranscriptEntry(entry, state) {
  if (!state.sessionStartTime && entry.timestamp) {
    const t = new Date(entry.timestamp).getTime();
    if (Number.isFinite(t)) state.sessionStartTime = t;
  }

  if (entry.customTitle) state.sessionName = String(entry.customTitle);

  if (entry.type === "assistant" && Array.isArray(entry.message?.content)) {
    for (const block of entry.message.content) {
      if (block.type !== "tool_use" || !block.id || !block.name) continue;

      state.toolUses.set(block.id, {
        name: block.name,
        timestamp: entry.timestamp,
        input: block.input,
      });
      state.runningToolIds.add(block.id);
      state.totalToolCalls++;
      state.lastTool = { name: block.name, input: block.input };

      // Sub-agent spawns: "Agent" is the current tool name; "Task" is the legacy name kept for
      // older transcripts. Both land here so the active/done agent widget tracks either.
      if (block.name === "Task" || block.name === "Agent") state.activeAgentIds.add(block.id);

      if (block.name === "TaskCreate") {
        const input = block.input || {};
        if (input.subject) {
          const seqId = String(state.nextTaskId++);
          state.pendingTaskCreates.set(block.id, {
            seqId,
            subject: input.subject,
            status: normalizeTaskStatus(input.status || "pending"),
          });
        }
      } else if (block.name === "TaskUpdate") {
        const input = block.input || {};
        if (input.taskId) {
          state.pendingTaskUpdates.set(block.id, {
            taskId: input.taskId,
            status: input.status,
            subject: input.subject,
          });
        }
      }
    }
  }

  if (entry.type === "user" && entry.message?.content !== undefined) {
    const content = entry.message.content;
    let matchedName = null;
    let hasText = false;

    if (typeof content === "string") {
      const m = content.match(SLASH_COMMAND_TAG_RE);
      if (m) {
        const name = m[1].trim();
        if (name.startsWith("/")) {
          matchedName = name;
          hasText = true;
        }
      } else {
        const trimmed = content.trim();
        if (trimmed.length > 0 && !trimmed.startsWith("<")) hasText = true;
      }
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type !== "text" || typeof block.text !== "string") continue;
        hasText = true;
        const m = block.text.match(SLASH_COMMAND_TAG_RE);
        if (m) {
          const name = m[1].trim();
          if (name.startsWith("/")) matchedName = name;
          break;
        }
      }
    }

    if (hasText) {
      state.activeSlashCommand = matchedName
        ? { name: matchedName, startTime: entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now() }
        : null;
    }
  }

  if (entry.type === "user" && Array.isArray(entry.message?.content)) {
    for (const block of entry.message.content) {
      if (block.type !== "tool_result" || !block.tool_use_id) continue;

      state.completedToolCount++;
      state.runningToolIds.delete(block.tool_use_id);

      if (state.activeAgentIds.delete(block.tool_use_id)) state.completedAgentCount++;

      const tool = state.toolUses.get(block.tool_use_id);
      if (tool?.name === "TodoWrite") state.lastTodoWriteInput = tool.input;

      const pendingCreate = state.pendingTaskCreates.get(block.tool_use_id);
      if (pendingCreate) {
        state.tasks.set(pendingCreate.seqId, {
          subject: pendingCreate.subject,
          status: pendingCreate.status,
        });
        state.pendingTaskCreates.delete(block.tool_use_id);
      }

      const pendingUpdate = state.pendingTaskUpdates.get(block.tool_use_id);
      if (pendingUpdate) {
        const task = state.tasks.get(pendingUpdate.taskId);
        if (task) {
          if (pendingUpdate.status) task.status = normalizeTaskStatus(pendingUpdate.status);
          if (pendingUpdate.subject) task.subject = pendingUpdate.subject;
        }
        state.pendingTaskUpdates.delete(block.tool_use_id);
      }

      state.toolUses.delete(block.tool_use_id);
    }
  }
}

function parseTranscript(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;

  const state = createTranscriptState();
  const content = readTail(transcriptPath, TRANSCRIPT_BYTES);
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      processTranscriptEntry(JSON.parse(line), state);
    } catch {
      // The first tail line can be partial; skip malformed JSONL.
    }
  }
  return state;
}

// Cumulative session output-tokens + tool-calls, accumulated INCREMENTALLY across renders:
// persist a byte offset + running totals and only parse NEW transcript bytes each render.
// (stdin's total_output_tokens is current-context only — useless as a tok/s numerator.)
function accumulateStats(transcriptPath, sessionId) {
  if (!transcriptPath || !existsSync(transcriptPath)) return { outputTokens: 0, toolCalls: 0 };

  let size;
  try {
    size = statSync(transcriptPath).size;
  } catch {
    return { outputTokens: 0, toolCalls: 0 };
  }

  const cacheFile =
    (process.env.TEMP || process.env.TMP || "/tmp").replace(/\\/g, "/") +
    "/sl-acc-" +
    hashPath(String(sessionId || transcriptPath)) +
    ".json";

  let acc = readJson(cacheFile);
  if (!acc || typeof acc.offset !== "number" || acc.offset > size) {
    acc = { offset: 0, outputTokens: 0, toolCalls: 0 }; // first run, or file truncated/rotated
  }
  if (size <= acc.offset) return { outputTokens: acc.outputTokens, toolCalls: acc.toolCalls };

  try {
    const fd = openSync(transcriptPath, "r");
    try {
      const buf = Buffer.alloc(size - acc.offset);
      readSync(fd, buf, 0, buf.length, acc.offset);
      const text = buf.toString("utf8");
      const lastNl = text.lastIndexOf("\n");
      if (lastNl < 0) return { outputTokens: acc.outputTokens, toolCalls: acc.toolCalls };

      const complete = text.slice(0, lastNl);
      for (const line of complete.split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e.type !== "assistant") continue;
          acc.outputTokens += Number(e.message?.usage?.output_tokens) || 0;
          if (Array.isArray(e.message?.content)) {
            for (const b of e.message.content) if (b.type === "tool_use") acc.toolCalls++;
          }
        } catch {}
      }
      acc.offset += Buffer.byteLength(complete, "utf8") + 1; // +1 for the consumed newline
      try {
        require("node:fs").writeFileSync(cacheFile, JSON.stringify(acc));
      } catch {}
    } finally {
      closeSync(fd);
    }
  } catch {}

  return { outputTokens: acc.outputTokens, toolCalls: acc.toolCalls };
}

function extractToolTarget(name, input) {
  if (!input || typeof input !== "object") return undefined;
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return typeof input.file_path === "string" ? basename(input.file_path) : undefined;
    case "Glob":
    case "Grep":
      return typeof input.pattern === "string" ? truncate(input.pattern, 20) : undefined;
    case "Bash":
      return typeof input.command === "string" ? truncate(input.command, 25) : undefined;
    default:
      return undefined;
  }
}

function todoProgress(transcript) {
  if (!transcript) return null;

  if (transcript.tasks.size > 0) {
    const tasks = [...transcript.tasks.values()];
    const completed = tasks.filter((t) => t.status === "completed").length;
    const current = tasks.find((t) => t.status === "in_progress" || t.status === "pending");
    return {
      current: current ? { content: current.subject, status: current.status } : undefined,
      completed,
      total: tasks.length,
    };
  }

  const input = transcript.lastTodoWriteInput;
  if (!input || typeof input !== "object" || !Array.isArray(input.todos)) return null;

  const todos = input.todos;
  const completed = todos.filter((t) => normalizeTaskStatus(t.status) === "completed").length;
  const current = todos.find((t) => {
    const s = normalizeTaskStatus(t.status);
    return s === "in_progress" || s === "pending";
  });

  return {
    current: current ? { content: current.content, status: normalizeTaskStatus(current.status) } : undefined,
    completed,
    total: todos.length,
  };
}

// Map a sub-agent's spawning tool_use id → its own transcript file. Sub-agent transcripts live in
// a documented sibling dir <transcript>/subagents/agent-<id>.jsonl, each paired with an
// agent-<id>.meta.json carrying the spawning `toolUseId`. Returns null if the dir doesn't exist
// (no sub-agents this session) so callers skip all extra I/O on the common idle path.
function subagentFilesByToolId(transcriptPath) {
  if (!transcriptPath) return null;
  const dir = transcriptPath.replace(/\.jsonl$/i, "") + "/subagents";
  let metas;
  try {
    metas = readdirSync(dir).filter((f) => f.endsWith(".meta.json"));
  } catch {
    return null;
  }
  const map = new Map();
  for (const m of metas) {
    const meta = readJson(join(dir, m));
    if (meta?.toolUseId) map.set(meta.toolUseId, join(dir, m.replace(/\.meta\.json$/i, ".jsonl")));
  }
  return map;
}

function agentStatus(transcript, transcriptPath) {
  if (!transcript) return null;
  const active = [];

  for (const id of transcript.activeAgentIds) {
    const tool = transcript.toolUses.get(id);
    if (!tool) continue;
    const input = tool.input || {};
    active.push({
      id,
      name: input.subagent_type || "Agent",
      description: input.description,
    });
  }

  // Attach each ACTIVE sub-agent's OWN task progress, read from its own transcript. Deliberately
  // per-agent (shown on that agent's line, never summed and never merged with the main session's
  // todo widget) so concurrent agents and a main-agent todo list stay distinct. Only runs while
  // agents are active, so idle renders do no extra I/O.
  if (active.length > 0) {
    const byTool = subagentFilesByToolId(transcriptPath);
    if (byTool) {
      for (const a of active) {
        const file = byTool.get(a.id);
        if (!file) continue;
        const tp = todoProgress(parseTranscript(file));
        if (tp && tp.total > 0) a.tasks = { completed: tp.completed, total: tp.total };
      }
    }
  }

  if (active.length === 0 && transcript.completedAgentCount === 0) return null;
  return { active, completed: transcript.completedAgentCount };
}

// Effort level, styled to echo Claude Code's /effort menu. The menu's xhigh shimmer and max rainbow
// are ANIMATED; a 60s-refresh status line can't animate, so the higher tiers get a smooth static
// TRUECOLOR (24-bit) gradient instead — the same kind of soft hue-blend CC uses for its own gradient
// text, far classier than flat 256-color jumps: high = solid violet, xhigh = a violet→lavender→violet
// sheen, max = a warm→cool coral→pink→violet→indigo sweep, ultra = a filled swatch chip.
const rgbFg = (r, g, b) => `${esc}[38;2;${r};${g};${b}m`;
const rgbBg = (r, g, b) => `${esc}[48;2;${r};${g};${b}m`;
// Smooth per-character gradient across RGB stops. Short words sample fewer stops but stay smooth
// because consecutive stops sit close in hue (no muddy midpoints). stops: array of [r,g,b].
function gradientText(text, stops) {
  const chars = [...text];
  const seg = Math.max(1, stops.length - 1);
  return (
    chars
      .map((ch, i) => {
        const t = chars.length <= 1 ? 0 : i / (chars.length - 1);
        const p = t * seg;
        const k = Math.min(seg - 1, Math.floor(p));
        const f = p - k;
        const a = stops[k];
        const b = stops[k + 1] || a;
        const lerp = (j) => Math.round(a[j] + (b[j] - a[j]) * f);
        return `${rgbFg(lerp(0), lerp(1), lerp(2))}${ch}`;
      })
      .join("") + RESET
  );
}
const EFFORT_AMBER = [240, 176, 80];
const EFFORT_GREEN = [122, 201, 132];
const EFFORT_VIOLET = [167, 139, 250]; // Claude-ish violet (#A78BFA)
const EFFORT_SHEEN = [EFFORT_VIOLET, [224, 208, 255], EFFORT_VIOLET]; // xhigh: violet→lavender→violet
const EFFORT_GRADIENT = [
  [240, 138, 110], // coral
  [236, 107, 160], // pink
  [214, 108, 190], // magenta
  [168, 130, 226], // violet
  [124, 142, 232], // indigo
];
function effortStyle(level) {
  const text = String(level || "");
  // Bolt stays a NEUTRAL gray anchor (never recolored per level) so the colored TEXT carries the
  // meaning and contrasts with it. (Tweak SILVER → 252/97 for a whiter bolt.)
  const bolt = `${SILVER}${gEffort}${RESET}`;
  switch (text.toLowerCase()) {
    case "low":
      return `${bolt} ${rgbFg(...EFFORT_AMBER)}${text}${RESET}`;
    case "medium":
      return `${bolt} ${rgbFg(...EFFORT_GREEN)}${text}${RESET}`;
    case "high":
      return `${bolt} ${rgbFg(...EFFORT_VIOLET)}${text}${RESET}`;
    case "xhigh": // violet sheen — the static nod to the menu's shimmer
      return `${bolt} ${gradientText(text, EFFORT_SHEEN)}`;
    case "max": // smooth warm→cool gradient — the static nod to the menu's rainbow cycle
      return `${bolt} ${gradientText(text, EFFORT_GRADIENT)}`;
    case "ultra":
    case "ultracode": // selected-swatch chip: light lavender on a deep-violet block
      return `${rgbBg(74, 58, 140)}${rgbFg(224, 208, 255)}${BOLD} ${gEffort} ${text} ${RESET}`;
    default:
      return `${bolt} ${VAL}${text}${RESET}`;
  }
}

// OS badge: platform icon (true-to-brand color) + the REAL version, all via cheap reads (no
// subprocess). win32: edition from build (os.release()) + the build number. darwin: ProductVersion
// from the system plist. linux: ID + VERSION_ID from /etc/os-release (e.g. "Debian 12").
function osBadge() {
  const p = process.platform;
  if (p === "win32") {
    const build = Number(release().split(".")[2]) || 0; // os.release() = "10.0.26200"
    return { icon: gWin, color: c256(39), label: `Win ${build >= 22000 ? "11" : "10"} (${build})` };
  }
  if (p === "darwin") {
    let ver = "";
    try {
      const m = readFileSync("/System/Library/CoreServices/SystemVersion.plist", "utf8")
        .match(/<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/);
      if (m) ver = m[1].trim();
    } catch {}
    if (!ver) ver = { 25: "26", 24: "15", 23: "14", 22: "13", 21: "12", 20: "11", 19: "10.15" }[Number(release().split(".")[0]) || 0] || "";
    return { icon: gApple, color: WHITE, label: ver ? `macOS ${ver}` : "macOS" };
  }
  // linux / other — short "Name Version" from /etc/os-release (Debian 12, Ubuntu 22.04, …)
  let label = "Linux";
  try {
    const txt = readFileSync("/etc/os-release", "utf8");
    const field = (k) => (txt.match(new RegExp(`^${k}="?([^"\n]+)`, "m")) || [])[1];
    const id = field("ID");
    const verId = field("VERSION_ID");
    if (id) {
      const name = id.charAt(0).toUpperCase() + id.slice(1);
      label = verId ? `${name} ${verId}` : name;
    } else {
      label = field("PRETTY_NAME") || "Linux";
    }
  } catch {}
  return { icon: gLinux, color: c256(208), label };
}

// `extra` is appended to both forms (e.g. the spend limit's "$used/$limit").
function rlBlock(node, label, fmt, windowMs, extra = "") {
  const pct = node?.used_percentage ?? node?.utilization;
  if (pct === null || pct === undefined || pct === "") return null;
  const p = Math.round(Number(pct));
  if (!Number.isFinite(p)) return null;

  const rt = formatResetTime(node.resets_at ?? node.reset_at, fmt);
  // Signed pace balance vs the even-consumption budget line ((elapsed/window)·100, window start =
  // resets_at − window length): + = quota in hand (green), − = burning ahead of it (yellow).
  // Shown as soon as any time has elapsed in the window (matches usage-buttons' PaceMetric, which
  // only skips a degenerate just-reset window); suppressed only when expected is NaN/non-positive.
  let pace = "";
  const resetMs = toEpochMs(node.resets_at ?? node.reset_at);
  const elapsed = Number.isFinite(resetMs) && windowMs ? Date.now() - (resetMs - windowMs) : NaN;
  const expected = elapsed > 0 ? Math.min(100, (elapsed / windowMs) * 100) : NaN;
  if (expected > 0 && cfg.pace) {
    const bal = Math.round(expected - p);
    pace = ` ${bal > 2 ? GREEN : bal < -2 ? YELLOW : SOFT}${bal >= 0 ? "+" : ""}${bal}%${RESET}`;
  }
  // full = with bar; compact = no bar (packer falls back to this when the bar won't fit,
  // so a gauge degrades gracefully instead of getting truncated with an ellipsis).
  const compact = `${SOFT}${label}${RESET} ${usageColor(p)}${p}%${RESET}${extra}${rt ? ` ${SOFT}(${rt})${RESET}` : ""}${pace}`;
  if (!cfg.bars) return [p, compact, compact];
  const full = `${SOFT}${label}${RESET} ${makeBar(p, 10, usageColor(p))} ${usageColor(p)}${p}%${RESET}${extra}${rt ? ` ${SOFT}${rt}${RESET}` : ""}${pace}`;
  return [p, full, compact];
}

// Per-model weekly limits + usage-credit spend live only behind the OAuth usage API (not in
// stdin — verified against the v2.1.226 payload builder, and still true per the v2.1.278 docs:
// rate_limits carries ONLY five_hour + seven_day, plus the gateway-only spend_limit). Read the
// OAuth token and fetch it, but cache the result with a TTL so we hit the API at most once per
// window.
function readOauthToken() {
  try {
    if (process.platform === "darwin") {
      const r = spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8", windowsHide: true });
      if (!r.error && r.status === 0 && r.stdout) {
        return JSON.parse(r.stdout.trim())?.claudeAiOauth?.accessToken ?? null;
      }
    }
    return readJson(join(HOME, ".claude", ".credentials.json"))?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

const USAGE_TTL_MS = 5 * 60 * 1000;
const usageCacheFile = () => (process.env.TEMP || process.env.TMP || "/tmp").replace(/\\/g, "/") + "/sl-usage.json";

// Synchronous, network-free read of the cached usage-API response — used by the render path so it
// never blocks. `fresh` = within the TTL (no refresh needed). The cache holds the FULL response
// object now (it used to hold just `seven_day_sonnet`, which the API retired to a permanent null
// in favor of the `limits` array — that's what silently killed the old 7dS gauge). A stale
// old-shape `data` simply lacks `limits`/`spend`, so it renders nothing until the first refresh.
function readUsageCache() {
  const prev = readJson(usageCacheFile());
  const fresh = !!(prev && typeof prev.ts === "number" && Date.now() - prev.ts < USAGE_TTL_MS);
  return { data: prev?.data ?? null, fresh };
}

// Fire-and-forget: relaunch THIS script with a flag so a DETACHED child does the (slow) network
// refresh and writes the cache, while the foreground render returns immediately. stdio is ignored so
// the child has no stdin (its fast path exits before the stdin read) and no terminal output.
function spawnUsageRefresh() {
  try {
    spawn(process.execPath, [Bun.main], {
      env: { ...process.env, CLAUDE_STATUSLINE_USAGE_REFRESH: "1" },
      detached: true,
      stdio: "ignore",
      // Windows: detached children get a fresh console that flashes visibly; hide it. The
      // child (and the curl it may spawn) inherit this hidden console — no terminal flash.
      windowsHide: true,
    }).unref();
  } catch {}
}

async function fetchUsage(ttlMs = USAGE_TTL_MS) {
  const cacheFile = usageCacheFile();
  const prev = readJson(cacheFile);
  if (prev && typeof prev.ts === "number" && Date.now() - prev.ts < ttlMs) return prev.data ?? null; // fresh

  const token = readOauthToken();
  if (!token) return prev?.data ?? null; // no token: nothing to fetch, keep any stale value

  const url = "https://api.anthropic.com/api/oauth/usage";
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "anthropic-beta": "oauth-2025-04-20",
    "User-Agent": "statusline-dashboard/1.1",
  };

  // Timeouts are GENEROUS (8s): this only ever runs in the detached refresh child, never on the
  // render path — and the endpoint routinely takes ~2s to answer, so the old 2s cutoffs lost the
  // race and left the cache permanently null.
  let usage = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) usage = await res.json();
  } catch {}
  if (!usage) {
    // Node/Bun TLS fingerprint sometimes draws a 403 from this endpoint; curl works.
    try {
      // Token via curl's stdin config (-K -), not a -H arg, so it stays out of the process command line.
      const r = spawnSync(
        "curl",
        ["-s", "--max-time", "8", url, "-H", "anthropic-beta: oauth-2025-04-20", "-H", "Accept: application/json", "-K", "-"],
        { encoding: "utf8", windowsHide: true, input: `header = "Authorization: Bearer ${token}"\n` },
      );
      if (!r.error && r.status === 0 && r.stdout) usage = JSON.parse(r.stdout);
    } catch {}
  }

  // Store the WHOLE response — the render picks out `limits` (scoped weekly gauges) and `spend`
  // (usage credits). Extracting single fields here is what rotted last time the API reshaped.
  const val = usage && typeof usage === "object" ? usage : prev?.data ?? null;
  // Always bump the timestamp (even on failure) so we don't re-hit the API before the TTL.
  try {
    require("node:fs").writeFileSync(cacheFile, JSON.stringify({ ts: Date.now(), data: val }));
  } catch {}
  return val;
}

// Detached usage-refresh fast path (see spawnUsageRefresh): a backgrounded copy lands here, updates
// the usage-API cache, and exits WITHOUT rendering — so the foreground never blocks on the network.
// Must run before the stdin read; the detached child has no stdin.
if (process.env.CLAUDE_STATUSLINE_USAGE_REFRESH === "1") {
  await fetchUsage();
  // Piggyback a temp sweep on this out-of-band run (never costs the render path anything):
  // sl-acc-* accumulators + sl-hwm-* height marks are one file PER SESSION and would pile up forever — TEMP isn't
  // auto-cleaned on Windows. >7 days since last write = dead session (live ones rewrite every
  // few renders). Stale sl-cache-* entries are caches; worst case is one recompute.
  try {
    const fs = require("node:fs");
    const tmp = (process.env.TEMP || process.env.TMP || "/tmp").replace(/\\/g, "/");
    const cutoff = Date.now() - 7 * 24 * 3600e3;
    for (const name of fs.readdirSync(tmp)) {
      if (!/^sl-(acc|cache|hwm)-.*\.json$/.test(name)) continue;
      const path = tmp + "/" + name;
      try {
        if (fs.statSync(path).mtimeMs < cutoff) fs.unlinkSync(path);
      } catch {}
    }
  } catch {}
  process.exit(0);
}

const raw = await Bun.stdin.text();
if (!raw) process.exit(0);

let data;
try {
  data = JSON.parse(raw);
} catch {
  process.exit(0);
}

// Launch ALL git subprocesses up front and CONCURRENTLY (gitAsync), before the sync transcript/
// settings file work — their ~30-50ms-per-process Windows spawn cost then overlaps both each other
// and the CPU-bound parsing below, instead of serializing after it (was the biggest render slice).
// Outside a repo all three fail fast in parallel; results are awaited down at the Repo-row build.
const currentDir = data.cwd || data.workspace?.current_dir || data.worktree?.original_cwd;
const gitJobs =
  currentDir && existsSync(currentDir)
    ? Promise.all([
        gitAsync(currentDir, ["status", "--porcelain=v2", "--branch"]),
        gitAsync(currentDir, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]),
        gitAsync(currentDir, ["describe", "--tags", "--long", "--match", "v*", "HEAD"]),
      ])
    : null;

const settings = readJson(join(HOME, ".claude", "settings.json")) || {};
const transcript = parseTranscript(data.transcript_path);
const acc = accumulateStats(data.transcript_path, data.session_id);

const model = data.model?.display_name || "Unknown Model";
// Effort comes ONLY from stdin: CC omits `effort` exactly when the model has no reasoning-effort
// parameter, so a guessed default (settings.effortLevel / a per-model table, as this used to do)
// showed a level on models that don't have one.
const effort = data.effort?.level ?? "";
const fastMode = (data.fast_mode ?? settings.fastMode) === true; // stdin is live session truth; settings is the pre-2.1.x fallback

const usage = data.context_window?.current_usage;
const contextSize = Number(data.context_window?.context_window_size) || 200000;
const inputTokens = usage
  ? (Number(usage.input_tokens) || 0) + (Number(usage.cache_creation_input_tokens) || 0) + (Number(usage.cache_read_input_tokens) || 0)
  : 0;
const outputTokens = usage ? Number(usage.output_tokens) || 0 : Number(data.context_window?.total_output_tokens) || 0;
const officialUsed = data.context_window?.used_percentage;
const usedInt = officialUsed !== null && officialUsed !== undefined && officialUsed !== ""
  ? Math.round(Number(officialUsed))
  : percent(inputTokens, contextSize);

const cost = Number(data.cost?.total_cost_usd) || 0;
const costStr = formatCost(cost);

const sid = String(data.session_id || "").trim(); // full UUID — usable with `claude --resume <id>`
const elapsedMs = typeof data.cost?.total_duration_ms === "number" && data.cost.total_duration_ms > 0
  ? data.cost.total_duration_ms
  : transcript?.sessionStartTime
    ? Date.now() - transcript.sessionStartTime
    : 0;
const elapsedMinutes = elapsedMs / 60000;

// rate_limits stdin exposes the subscription windows five_hour + seven_day (seven_day covers all
// models; verified in the v2.1.226 payload builder) and, since v2.1.251, `spend_limit` for users
// behind a Claude apps gateway. Per-model scoped weeklies + usage credits are API-only (below).
// Each window may be independently absent — CC drops one once its resets_at passes.
const rl5 = on("limits.5h") ? rlBlock(data.rate_limits?.five_hour, "5h", "auto", 5 * 3600e3) : null; // day abbrev only if it rolls to next day
const rl7 = on("limits.7d") ? rlBlock(data.rate_limits?.seven_day, "7d", "ddd HH:mm", 7 * 24 * 3600e3) : null;
// SPEND LIMIT (gateway): % of the spend cap that applies to you + when its period resets. The
// percentage runs PAST 100 once over the cap — shown verbatim in red; the bar clamps itself.
// CC v2.1.284+ adds `used_usd`/`limit_usd` (shown as "$used/$limit") and `period`
// (daily/weekly/monthly), which gives the window length the pace balance needs: the period
// started one day/week/calendar month before resets_at. No period (older CC/gateway) → windowMs 0
// → no pace suffix. Distinct from `Cr` below, which is claude.ai usage-credit overage.
let rlSp = null;
{
  const sl = data.rate_limits?.spend_limit;
  const resetMs = toEpochMs(sl?.resets_at);
  let spWindow = 0;
  if (sl?.period === "daily") spWindow = 24 * 3600e3;
  else if (sl?.period === "weekly") spWindow = 7 * 24 * 3600e3;
  else if (sl?.period === "monthly" && Number.isFinite(resetMs)) {
    const start = new Date(resetMs);
    start.setMonth(start.getMonth() - 1);
    spWindow = resetMs - start.getTime();
  }
  const usd = Number(sl?.used_usd);
  const lim = Number(sl?.limit_usd);
  const money = Number.isFinite(usd) && sl?.used_usd != null
    ? ` ${VAL}${formatCost(usd)}${RESET}${Number.isFinite(lim) && lim > 0 ? `${SOFT}/$${Math.round(lim)}${RESET}` : ""}`
    : "";
  if (on("limits.spend")) rlSp = rlBlock(sl, "Sp", "date", spWindow, money);
}
// The extra gauges are API-only — only bother for Pro/Max sessions (rate_limits present in stdin).
// A gateway session carries spend_limit ALONE and has no claude.ai OAuth usage to read — skip it
// (but an EMPTY rate_limits still counts as Pro/Max: CC drops both windows right after they reset).
// Serve the cached response INSTANTLY; refresh out-of-band when stale (never await the network here).
// usageApi:false (config) skips all of it — no token read, no network, no scoped/Cr gauges.
let usageData = null;
const rlIn = data.rate_limits;
if (cfg.usageApi && (on("limits.scoped") || on("limits.credits")) && rlIn && !(rlIn.spend_limit && !rlIn.five_hour && !rlIn.seven_day)) {
  const cached = readUsageCache();
  usageData = cached.data;
  if (!cached.fresh) spawnUsageRefresh();
}
// MODEL-SCOPED weekly gauges from the API's `limits` array (its modern shape — the old per-model
// `seven_day_<model>` buckets are retired to permanent nulls). Each `weekly_scoped` entry is a
// per-model cap normalized to its OWN 0-100% (e.g. Fable's cap is ~50% of the all-model weekly,
// but reads as a full 0-100 gauge here — so 7dF 15% means 15% of the FABLE allowance, not of 7d).
// `session`/`weekly_all` kinds duplicate stdin's 5h/7d, so only scoped entries are added. Labeled
// "7d" + first letter of the scope's model ("Fable" → 7dF), echoing the old 7dS convention.
const scopedBlocks = [];
for (const lim of on("limits.scoped") && Array.isArray(usageData?.limits) ? usageData.limits : []) {
  if (lim?.kind !== "weekly_scoped") continue;
  const name = String(lim.scope?.model?.display_name || lim.scope?.surface || "").trim();
  const block = rlBlock(
    { used_percentage: lim.percent, resets_at: lim.resets_at },
    `7d${(name.charAt(0) || "?").toUpperCase()}`,
    "ddd HH:mm",
    7 * 24 * 3600e3,
  );
  if (block) scopedBlocks.push(block);
}
if (!scopedBlocks.length && on("limits.scoped")) {
  // Legacy-shape fallback (pre-`limits` API): per-model weekly buckets as top-level objects.
  for (const [key, label] of [["seven_day_sonnet", "7dS"], ["seven_day_opus", "7dO"]]) {
    const block = rlBlock(usageData?.[key], label, "ddd HH:mm", 7 * 24 * 3600e3);
    if (block) scopedBlocks.push(block);
  }
}
// USAGE CREDITS (pay-per-use overage once a plan limit is hit) from the API `spend` block —
// amounts in minor currency units (amount_minor 5000 + exponent 2 = $50.00). Only shown once
// credits are enabled AND something has actually been spent this month: a standing $0 gauge is
// noise on this deliberately terse row, but the moment credits kick in it appears — which is
// exactly the event worth surfacing. No pace suffix (monthly spend has no even-burn budget line).
let crBlock = null;
{
  const sp = usageData?.spend;
  const minor = (m) => (Number(m?.amount_minor) || 0) / 10 ** (Number.isFinite(Number(m?.exponent)) ? Number(m.exponent) : 2);
  if (on("limits.credits") && sp?.enabled && Number(sp.used?.amount_minor) > 0) {
    const used = minor(sp.used);
    const limit = minor(sp.limit);
    const p = Math.round(Number(sp.percent) || (limit > 0 ? (used / limit) * 100 : 0));
    const money = `${VAL}${formatCost(used)}${RESET}${limit > 0 ? `${SOFT}/$${Math.round(limit)}${RESET}` : ""}`;
    const compact = `${SOFT}Cr${RESET} ${usageColor(p)}${p}%${RESET} ${money}`;
    const full = cfg.bars ? `${SOFT}Cr${RESET} ${makeBar(p, 10, usageColor(p))} ${usageColor(p)}${p}%${RESET} ${money}` : compact;
    crBlock = [p, full, compact];
  }
}
const rlBlocks = [rl5, rl7, ...scopedBlocks, rlSp, crBlock].filter(Boolean);

let gitStr = "no branch";
let repoRoot = currentDir; // working-tree root (the worktree's OWN dir when in a linked worktree)
let mainRoot = null; // MAIN repo root (parent of the shared git common dir) — drives the FOLDER name
let inRepo = false;
let tagInfo = null;
// Collect the concurrent git jobs launched up top (status / rev-parse / describe --long).
const [stOut, rpOut, descOut] = gitJobs ? await gitJobs : [null, null, null];
{
  const st = parseGitStatus(stOut);
  if (st) {
    inRepo = true;
    // One rev-parse, two outputs: line 1 = working-tree root (--show-toplevel); line 2 = the COMMON
    // git dir (--git-common-dir), shared by every worktree. The common dir's PARENT is the main repo
    // root — so a linked worktree shows its PARENT repo (e.g. "topside-events") as the folder instead
    // of echoing the worktree's own name (which the worktree segment already shows).
    let common = null;
    if (rpOut) {
      const lines = rpOut.split("\n").map((s) => s.trim()).filter(Boolean);
      if (lines[0]) repoRoot = lines[0];
      common = lines[1] || null;
    } else {
      const top = git(currentDir, ["rev-parse", "--show-toplevel"]); // fallback for git < 2.31 (--path-format unsupported)
      if (top && top.trim()) repoRoot = top.trim();
    }
    const stripped = common ? common.replace(/[\\/]\.git[\\/]*$/i, "") : ""; // drop trailing /.git
    mainRoot = stripped && stripped !== common ? stripped : repoRoot; // parent of common .git, else toplevel

    gitStr = st.branch || "no branch";
    if (st.ahead > 0) gitStr += ` ${GREEN}${gAhead}${st.ahead}${RESET}`;
    if (st.behind > 0) gitStr += ` ${YELLOW}${gBehind}${st.behind}${RESET}`;
    if (st.staged > 0) gitStr += ` ${GREEN}+${st.staged}${RESET}`;
    if (st.modified > 0) gitStr += ` ${YELLOW}~${st.modified}${RESET}`;
    if (st.untracked > 0) gitStr += ` ${BBLUE}?${st.untracked}${RESET}`;
    if (st.conflicts > 0) gitStr += ` ${RED}!${st.conflicts}${RESET}`;

    tagInfo = parseTagStatus(descOut);
  }
}

const normPath = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const isWorktree = inRepo && !!mainRoot && normPath(mainRoot) !== normPath(repoRoot);
// worktree label: CC's --worktree name, else any git-worktree name, else the worktree dir basename.
const worktree = data.worktree?.name || data.workspace?.git_worktree || (isWorktree ? basename(repoRoot) : "");

// displayRoot = the WORKING tree (config counts + git all read the worktree's own checkout).
const displayRoot = repoRoot || data.workspace?.project_dir || currentDir;
// …but the Repo headline NAME comes from the main repo root, so a worktree shows its parent repo.
// (Where you are WITHIN the tree is no longer folded in here — the Info. row's CWD shows the literal
// path now, so the Repo row is pure project identity + git state.)
const dirName = mainRoot || displayRoot ? basename(mainRoot || displayRoot) : "unknown";

const sessionSegs = [];
sessionSegs.push(`${CYAN}${gModel}${RESET} ${BOLD}${model}${fastMode ? ` ${YELLOW}${gSpeed}${RESET}` : ""}${RESET}`);
// Effort badge, with a thinking lamp tacked on (same packer item, no separator) when extended
// thinking is on — so AI-reasoning state reads as one unit, e.g. "xhigh 💡". Lamp alone if no effort.
const thinkMark = data.thinking?.enabled && on("model.thinking") ? ` ${c256(183)}${gThink}${RESET}` : "";
if (effort && on("model.effort")) sessionSegs.push(effortStyle(effort) + thinkMark);
else if (thinkMark && on("model.thinking")) sessionSegs.push(thinkMark.trimStart());
// Context gauge degrades like the rate-limit gauges: bar when the row fits, %-only when it wraps.
// exceeds_200k_tokens is a FIXED 200k threshold regardless of window size. On an extended-context
// (>200k) model that's the premium long-context pricing line, so flag it; on a plain 200k model it's
// just "full" (used% already says that), so suppress to avoid noise.
const over200k = data.exceeds_200k_tokens === true && contextSize > 200000 ? ` ${RED}200K+${RESET}` : "";
const ctxPct = `${contextColor(usedInt)}${usedInt}%${RESET} ${SOFT}${formatTokens(inputTokens)}/${formatTokens(contextSize)}${RESET}${over200k}`;
const ctxFull = `${PINK}${gCtx}${RESET} ${makeBar(usedInt, 10, contextColor(usedInt))} ${ctxPct}`;
const ctxCompact = `${PINK}${gCtx}${RESET} ${ctxPct}`;
if (on("model.context")) sessionSegs.push({ alts: [cfg.bars ? ctxFull : ctxCompact, ctxCompact] });
// cost + duration moved to the Usage row, session-id to Info. — Model row stays lean (AI state only).


// Each gauge (5h/7d/7dS) is its OWN packer item so they can wrap to a new line individually
// when the row runs out of width. A gauge glyph is the row "lead" (rendered once, before the first
// gauge) so wrapped gauges indent past it and line up TEXT-under-TEXT (7dS under 5h, not the icon).
// It's a quota meter (not a clock) — the real clock lives on the Host row; it tints toward the
// usage color as you near a limit. alts = [full-with-bar, compact-no-bar].
const quotaSegs = [];
let limitLead = "";
// The lead glyph renders as 1 cell + 1 trailing space in this terminal (vlen would guess 2),
// so pass its TRUE width to packSection or continuation lines indent one cell too far right.
let limitLeadW = 0;
if (rlBlocks.length) {
  const maxP = Math.max(...rlBlocks.map((b) => b[0]));
  const limitColor = maxP >= 70 ? usageColor(maxP) : WHITE;
  limitLead = `${limitColor}${gGauge}${RESET} `;
  limitLeadW = 2;
  rlBlocks.forEach((b) => quotaSegs.push({ alts: [b[1], b[2]] }));
}

// Usage — this session's consumption: total cost, $/h burn, throughput (tok/s), API time, wall-clock.
// (var stays `rateSegs`; rendered under the "Usage" label.)
const rateSegs = [];
if (on("usage.cost")) rateSegs.push(`${GREEN}${gCost}${RESET} ${VAL}${costStr}${RESET}`); // total $ spent
const apiDurationMs = Number(data.cost?.total_api_duration_ms) || 0;
if (cost > 0 && elapsedMinutes >= 1 && on("usage.burn")) {
  const hourlyCost = (cost / elapsedMinutes) * 60;
  const hourlyColor = hourlyCost > 10 ? RED : hourlyCost > 5 ? YELLOW : GREEN;
  rateSegs.push(`${ORANGE}${gCost}${RESET} ${hourlyColor}~${formatCost(hourlyCost)}/h${RESET}`); // burn rate
}
if (apiDurationMs > 0 && acc.outputTokens > 0 && on("usage.speed")) {
  const tps = acc.outputTokens / (apiDurationMs / 1000); // cumulative output ÷ cumulative API time
  if (Number.isFinite(tps) && tps > 0) {
    rateSegs.push(`${PENCIL}${gSpeed}${RESET} ${VAL}${Math.round(tps)}${RESET} ${SOFT}tok/s${RESET}`);
  }
}
// This is CC's cost.total_api_duration_ms shown VERBATIM (read above) — not computed/summed here.
// GOTCHA: it's meant to be cumulative *active* API time, but CC's timer doesn't subtract a laptop
// sleep/suspend, so if the machine sleeps mid-session this balloons to ~wall-clock (≈ elapsedMs).
// Tell: API ≈ duration paired with implausibly low tok/s + $/h (the inflated denominator drags both
// down). That's an upstream CC accounting artifact, NOT a bug here — don't "fix" it by clamping to
// elapsedMs; that would just mask CC's number. (diagnosed from a real 11.9h-sleep session, 2026-06)
if (apiDurationMs > 0 && elapsedMs > 0 && on("usage.api")) {
  const apiPct = Math.min(100, Math.round((apiDurationMs / elapsedMs) * 100));
  const apiColor = apiPct > 70 ? YELLOW : VAL;
  rateSegs.push(`${CYAN}${gApi}${RESET} ${apiColor}API ${formatDuration(apiDurationMs)}${RESET}`);
}
if (on("usage.duration")) rateSegs.push(`${SILVER}${gDuration}${RESET} ${VAL}${formatDuration(elapsedMs)}${RESET}`); // wall-clock

// turn — the last API call's token makeup (In/Out/W/R)
const turnSegs = [];
if (usage && on("turn.tokens")) {
  const fresh = Number(usage.input_tokens) || 0;
  const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;
  const cacheRead = Number(usage.cache_read_input_tokens) || 0;

  const tokenParts = [];
  if (fresh > 0) tokenParts.push(`${CYAN}${gIn}${RESET} ${VAL}${formatTokens(fresh)}${RESET}`);
  if (outputTokens > 0) tokenParts.push(`${PENCIL}${gOut}${RESET} ${VAL}${formatTokens(outputTokens)}${RESET}`);
  if (cacheWrite > 0) tokenParts.push(`${YELLOW}${gWrite}${RESET} ${VAL}${formatTokens(cacheWrite)}${RESET}`);
  if (cacheRead > 0) tokenParts.push(`${GREEN}${gRead}${RESET} ${VAL}${formatTokens(cacheRead)}${RESET}`);
  if (tokenParts.length) turnSegs.push(tokenParts.join(` ${SOFT}|${RESET} `));
}

// Prompt-cache health for the MAIN conversation (stdin `prompt_cache`, CC v2.1.251+; absent until
// the first API response, subagent requests excluded). Sits on Turn because it explains the W/R
// split beside it: R dominating = cache working, a fat W = something re-cached. Three terse facts:
//   hit%   — cache reads ÷ ALL input tokens this session (null while counts are zero). Green ≥80,
//            yellow <50: a long session stuck low is paying full price for its own history.
//   state  — warm + time left on the TTL (expires_at; CC itself re-runs us at expiry, so this flips
//            to cold on time without refreshInterval), or cold + what the next request re-caches
//            (recache_tokens_if_cold) — the cost of having walked away.
//   misses — requests that re-processed content the cache already held, with the likely cause of
//            the LAST one (last_miss_cause, v2.1.260+) in the wide form only. expected_rebuilds
//            (post-compaction) are deliberately not counted — those are CC working as designed.
// caching_observed:false = caching off or a gateway that doesn't report it → nothing worth showing.
const pc = data.prompt_cache;
if (pc && typeof pc === "object" && pc.caching_observed !== false && on("turn.cache")) {
  const bits = [];
  const hr = Number(pc.hit_ratio);
  if (pc.hit_ratio != null && Number.isFinite(hr)) {
    const hp = Math.round(hr * 100);
    bits.push(`${hp >= 80 ? GREEN : hp < 50 ? YELLOW : VAL}${hp}%${RESET}`);
  }
  if (pc.warm === true) {
    const left = toEpochMs(pc.expires_at) - Date.now();
    bits.push(`${VAL}warm${RESET}${left > 0 ? ` ${SOFT}${formatCountdown(left)}${RESET}` : ""}`);
  } else if (pc.warm === false) {
    const recache = Number(pc.recache_tokens_if_cold) || 0;
    bits.push(`${DIM}cold${RESET}${recache > 0 ? ` ${DIM}~${formatTokens(recache)}${RESET}` : ""}`);
  }
  if (bits.length) {
    const head = `${c256(45)}${gPromptCache}${RESET} ${bits.join(" ")}`;
    const misses = Number(pc.misses) || 0;
    if (misses > 0) {
      const miss = ` ${YELLOW}${misses} miss${RESET}`;
      const causes = Array.isArray(pc.last_miss_cause?.causes) ? pc.last_miss_cause.causes.filter((c) => typeof c === "string") : [];
      const why = causes.length ? ` ${DIM}(${truncate(causes.join(",").replace(/_/g, " "), 28)})${RESET}` : "";
      turnSegs.push(why ? { alts: [head + miss + why, head + miss] } : head + miss);
    } else {
      turnSegs.push(head);
    }
  }
}

const stateSegs = [];

// CWD — the literal current directory (home-relativized to ~/…, leaf preserved when long). Leads the
// Info. row so it's a stable "where am I" anchor right above the prompt, present in OR out of a repo.
// (The Repo row no longer carries your location — it's repo-only now.)
const cwdDisplay = shortenPath(homeRelative(currentDir));
if (cwdDisplay && on("info.cwd")) stateSegs.push(`${BBLUE}${gDir}${RESET} ${VAL}${cwdDisplay}${RESET}`);

// Host row — everything that comes from the MACHINE: local clock (time is host-derived), OS, user@host.
//   [clock] HH:mm | [os icon] os/version | [person icon] user@host
// Clock updates each minute via statusLine.refreshInterval (event triggers go quiet when idle).
// user@host: person icon + SSH-prompt style (no spaces around @); user from userInfo() w/ env fallback.
const hostSegs = [];
{
  if (on("host.clock")) {
    const now = new Date();
    const h = now.getHours();
    const mm = String(now.getMinutes()).padStart(2, "0");
    const time = cfg.clock12 ? `${h % 12 || 12}:${mm}${h < 12 ? "am" : "pm"}` : `${String(h).padStart(2, "0")}:${mm}`;
    hostSegs.push(`${WHITE}${gClock}${RESET} ${VAL}${time}${RESET}`);
  }

  if (on("host.os")) {
    const b = osBadge();
    hostSegs.push(`${b.color}${b.icon}${RESET} ${VAL}${b.label}${RESET}`);
  }

  const host = (hostname() || "").split(".")[0]; // drop .local / domain → short hostname
  let user = "";
  try { user = userInfo().username || ""; } catch {}
  if (!user) user = process.env.USERNAME || process.env.USER || "";
  if ((user || host) && on("host.user")) {
    const idStr = user && host ? `${VAL}${user}${DIM}@${VAL}${host}${RESET}` : `${VAL}${user || host}${RESET}`;
    hostSegs.push(`${c256(114)}${gPerson}${RESET} ${idStr}`);
  }

  // Fleet — OTHER live Claude Code sessions on this machine; the same population behind the
  // "← N agent" count in CC's own footer (which is other SESSIONS, not this session's subagents
  // and not agent-definition files — those are the Activity robot and the Config robot). CC
  // registers every running process in ~/.claude/sessions/<pid>.json (undocumented; observed in
  // v2.1.223: {pid, sessionId, cwd, name, status, ...}). Registry files can outlive a crashed
  // process, so an entry only counts after a signal-0 probe proves its pid is still alive.
  // Excluded by sessionId (not pid) so a respawned-in-place session can't count itself. Hidden
  // at 0 — an always-on "no other sessions" widget is noise.
  if (on("host.fleet")) {
    const others = [];
    let regFiles = [];
    try { regFiles = readdirSync(join(HOME, ".claude", "sessions")); } catch {}
    for (const f of regFiles) {
      if (!f.endsWith(".json")) continue;
      const s = readJson(join(HOME, ".claude", "sessions", f));
      if (!s?.pid || !s.sessionId || s.sessionId === sid) continue;
      try { process.kill(s.pid, 0); } catch { continue; } // stale registry file — process is gone
      others.push(s.name || String(s.pid));
    }
    if (others.length > 0) {
      const head = `${c256(110)}${gFleet}${RESET} ${VAL}${others.length}${RESET}`;
      const list = others.slice(0, 2).join(", ") + (others.length > 2 ? ", …" : "");
      hostSegs.push({ alts: [`${head} ${DIM}(${list})${RESET}`, head] });
    }
  }
}
const outputStyle = data.output_style?.name;
if (outputStyle && outputStyle !== "default" && on("info.style")) {
  stateSegs.push(`${PENCIL}${gStyle}${RESET} ${VAL}${outputStyle}${RESET}`);
}
// Claude Code version — a CLIENT/app version, not a machine attribute, so it belongs on the
// session/client Info. row (here), not the Host row.
if (data.version && on("info.version")) stateSegs.push(`${WHITE}${gVersion}${RESET} ${VAL}v${data.version}${RESET}`);
// Vim mode — we render it ourselves and suppress Claude's native "-- INSERT --" via the
// statusLine.hideVimModeIndicator setting (so the mode isn't shown twice). Modes per the docs:
// NORMAL, INSERT, VISUAL, VISUAL LINE. INSERT=green (editing), VISUAL*=magenta (selection),
// NORMAL/other=cyan.
if (data.vim?.mode && on("info.vim")) {
  const m = data.vim.mode;
  const vimColor = m === "INSERT" ? GREEN : m.startsWith("VISUAL") ? MAGENTA : CYAN;
  // Vim mode KEEPS italic (exception to the no-italic-in-content rule): it's all-caps, so the
  // cursive isn't distracting and helps it read as a mode indicator.
  stateSegs.push(`${vimColor}${gVim}${RESET} ${ITALIC}${vimColor}${m}${RESET}`);
}
// agent.name — shown when running under --agent / configured agent settings. (The docs also list an
// optional agent.type identifier; the name is the human-facing one, so type isn't shown.)
if (data.agent?.name && on("info.agent")) {
  stateSegs.push(`${SILVER}${gUser}${RESET} ${VAL}${data.agent.name}${RESET}`);
}
// remote — present when the session is attached to a remote/cloud workspace. In the v2.1.226
// payload builder (`...du()!==null&&{remote:{session_id:...}}`) but NOT yet in the docs schema,
// so gate defensively on a non-empty id. Cloud glyph reused from the connectors widget.
if (data.remote?.session_id && on("info.remote")) stateSegs.push(`${c256(117)}${gCfgConn}${RESET} ${VAL}remote${RESET}`);
// Session identity — the custom/AI-generated session title (stdin session_name, added ~2.1.x;
// transcript customTitle as the fallback for older CC) is the human-facing value, with the
// `claude --resume`-able id (first UUID segment) demoted to DIM parens. No name → the id stays
// the primary value as before. Default display names ("my-app-3f") never populate session_name.
const sessionName = truncate(data.session_name || transcript?.sessionName || "", 32);
if (!on("info.session")) {
  // hidden by config
} else if (sessionName) {
  stateSegs.push(`${SILVER}${gKey}${RESET} ${VAL}${sessionName}${RESET}${sid ? ` ${DIM}(${sid.split("-")[0]})${RESET}` : ""}`);
} else if (sid) {
  stateSegs.push(`${SILVER}${gKey}${RESET} ${VAL}${sid.split("-")[0]}${RESET}`);
}

const activitySegs = [];
if (transcript?.activeSlashCommand?.name && on("activity.command")) {
  activitySegs.push(`${YELLOW}${gCommand}${RESET} ${VAL}${transcript.activeSlashCommand.name}${RESET}`);
}

const todo = todoProgress(transcript);
if (todo && todo.total > 0 && on("activity.todo")) {
  const donePct = percent(todo.completed, todo.total);
  const todoColor = donePct === 100 ? GREEN : donePct >= 50 ? YELLOW : RED;
  if (todo.current) {
    activitySegs.push(`${todoColor}${gTodo}${RESET} ${truncate(todo.current.content, 26)} ${todoColor}[${todo.completed}/${todo.total}]${RESET}`);
  } else {
    activitySegs.push(`${todoColor}${gTodo}${RESET} ${todo.completed}/${todo.total}`);
  }
}

if (acc.toolCalls > 0 && on("activity.tool")) {
  const lt = transcript?.lastTool;
  const target = lt ? extractToolTarget(lt.name, lt.input) : null;
  const label = lt ? (target ? `${lt.name}(${target})` : lt.name) : "tool";
  const icon = transcript?.runningToolIds?.size > 0 ? YELLOW : SOFT; // yellow while a tool is mid-run
  activitySegs.push(`${icon}${gTools}${RESET} ${label} ${SOFT}(${acc.toolCalls} calls)${RESET}`);
}

const agents = agentStatus(transcript, data.transcript_path);
if (agents && on("activity.agents")) {
  // Counts-only roll-up — the subagent panel below the prompt already renders each agent's name +
  // description verbatim, so the dashboard deliberately does NOT repeat them. It surfaces only what
  // the panel can't: how many are running, their COMBINED [done/total] task progress (summed across
  // active agents that keep a task list), and a green ✔N tally of completed ones (which the panel
  // drops as its rows finish). Robot is cyan while anything runs, dimming to gray once all finish.
  const segs = [];
  if (agents.active.length > 0) {
    let done = 0;
    let total = 0;
    for (const a of agents.active) {
      if (a.tasks) {
        done += a.tasks.completed;
        total += a.tasks.total;
      }
    }
    const prog = total > 0 ? ` ${CYAN}[${done}/${total}]${RESET}` : "";
    segs.push(`${VAL}${agents.active.length} running${RESET}${prog}`);
  }
  if (agents.completed > 0) segs.push(`${GREEN}${gCheck} ${agents.completed}${RESET}`);
  if (segs.length > 0) {
    const robot = agents.active.length > 0 ? CYAN : SOFT;
    activitySegs.push(`${robot}${gAgent}${RESET} ${segs.join(` ${SOFT}·${RESET} `)}`);
  }
}

// Agent team (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1) — since CC v2.1.178 every session has ONE
// implicit team, `session-<first 8 of session id>`, recorded at ~/.claude/teams/<team>/config.json
// ({name, leadAgentId, leadSessionId, members:[{agentId, name, agentType, …}]}; the lead is a member
// too). Nothing about teams reaches stdin, so this one cheap read is the only way to see it. Shown
// only once a teammate exists — the file is created with the lead alone — and only when THIS session
// leads it (leadSessionId), so a stale file from a recycled id prefix can't masquerade. Teammate
// names in the wide form; their live running/idle state is the agent panel's job (see
// subagent-statusline.js), the same split as the sub-agent roll-up above.
if (sid && on("activity.team")) {
  const team = readJson(join(HOME, ".claude", "teams", `session-${sid.slice(0, 8)}`, "config.json"));
  if (team && team.leadSessionId === sid && Array.isArray(team.members)) {
    const mates = team.members.filter((m) => m && m.agentId !== team.leadAgentId).map((m) => String(m.name || "?"));
    if (mates.length > 0) {
      const head = `${c256(43)}${gTeam}${RESET} ${VAL}${mates.length}${RESET}`;
      const list = mates.slice(0, 3).join(", ") + (mates.length > 3 ? ", …" : "");
      activitySegs.push({ alts: [`${head} ${DIM}(${truncate(list, 40)})${RESET}`, head] });
    }
  }
}

// Session edit volume (+added/−removed lines) — repo-independent (you can edit files outside any
// repo), so it rides the always-present Activity row, NOT the now repo-only Repo row.
const linesAdded = Number(data.cost?.total_lines_added) || 0;
const linesRemoved = Number(data.cost?.total_lines_removed) || 0;
if ((linesAdded > 0 || linesRemoved > 0) && on("activity.lines")) {
  const diff = [];
  if (linesAdded > 0) diff.push(`${GREEN}+${linesAdded}${RESET}`);
  if (linesRemoved > 0) diff.push(`${RED}-${linesRemoved}${RESET}`);
  activitySegs.push(`${PENCIL}${gLines}${RESET} ${diff.join(" ")}`);
}

// Repo row — ONLY inside a git repo, and then pure repo identity + git state: headline project name
// (git-folder glyph, distinct from the Info. row's plain-folder CWD), worktree, branch, tag. Outside
// a repo locSegs stays empty → packSection emits nothing and the whole row disappears.
const locSegs = [];
if (inRepo) {
  // Headline project name is the folder basename (stable, matches your mental model).
  locSegs.push(`${BBLUE}${gTree}${RESET} ${VAL}${dirName}${RESET}`);
  // Remote identity from workspace.repo ({host, owner, name} parsed from the origin remote —
  // absent outside a repo or with no origin). Host-branded badge + owner; owner/name only when
  // the remote repo name DIFFERS from the folder headline (fork/rename) — when they match, the
  // name is already the headline and repeating it is noise.
  const repoId = data.workspace?.repo;
  if (repoId?.owner && on("repo.remote")) {
    const host = String(repoId.host || "").toLowerCase();
    const [hostIcon, hostColor] = host.includes("github")
      ? [gGithub, SILVER]
      : host.includes("gitlab")
        ? [gGitlab, ORANGE]
        : host.includes("bitbucket")
          ? [gBitbucket, BBLUE]
          : [gRepoHost, SOFT];
    const sameName = String(repoId.name || "").toLowerCase() === String(dirName).toLowerCase();
    const id = sameName ? `${VAL}${repoId.owner}${RESET}` : `${VAL}${repoId.owner}${SOFT}/${RESET}${VAL}${repoId.name}${RESET}`;
    locSegs.push(`${hostColor}${hostIcon}${RESET} ${id}`);
  }
  if (worktree && on("repo.worktree")) locSegs.push(`${MAGENTA}${gTree}${RESET} ${VAL}${worktree}${RESET}`);
  if (on("repo.branch")) locSegs.push(`${CYAN}${gBranch}${RESET} ${gitStr}`);
  // PR — the current branch's OPEN pull request, straight from Claude Code's native `pr` payload
  // (same source as CC's built-in footer PR badge, added ~v2.1.149): present only while a PR is
  // open, gone the moment it merges/closes — so this appears/disappears exactly like the native
  // badge, with NO `gh` call (zero cost, always fresh). Per the docs `pr` is a SINGLE object — CC
  // surfaces only ONE PR per branch and the payload carries no array/count, so multiple open PRs on
  // one branch can't be seen from here (only via `gh pr list --head`); we normalize defensively and
  // append "+N" if CC ever sends a list. #number is colored by review_state (enum: approved/pending/
  // changes_requested/draft): green ✓ · red ✗ · yellow ● · dim draft. (CI status isn't in the
  // native payload either — both CI and true multi-PR awareness would need an opt-in `gh` call.)
  const prList = Array.isArray(data.pr) ? data.pr.filter(Boolean) : data.pr ? [data.pr] : [];
  if (prList.length && on("repo.pr")) {
    const prData = prList[0];
    const rs = String(prData.review_state ?? prData.reviewDecision ?? "").toLowerCase();
    let prColor = VAL;
    let mark = "";
    if (rs.includes("approv")) { prColor = GREEN; mark = ` ${GREEN}${gCheck}${RESET}`; }
    else if (rs.includes("change")) { prColor = RED; mark = ` ${RED}${gX}${RESET}`; }
    else if (rs.includes("draft")) { prColor = DIM; mark = ` ${DIM}draft${RESET}`; }
    else if (rs.includes("pending") || rs.includes("review") || rs.includes("required")) { prColor = YELLOW; mark = ` ${YELLOW}●${RESET}`; }
    // GitLab (CC v2.1.234+): on a GitLab remote with an authed `glab`, CC fills `pr` from the
    // branch's open MERGE REQUEST and sets `kind: "mr"` (absent for GitHub PRs). GitLab writes MRs
    // as !N — match CC's own footer badge. review_state is already mapped onto the PR enum upstream
    // (mergeable → approved, other open → pending, draft → draft), so the coloring above holds.
    const isMr = String(prData.kind || "").toLowerCase() === "mr";
    const label = prData.number != null ? `${isMr ? "!" : "#"}${prData.number}` : isMr ? "MR" : "PR";
    const extra = prList.length > 1 ? ` ${SOFT}+${prList.length - 1}${RESET}` : "";
    // The number is an OSC 8 hyperlink to the PR (CC passes OSC 8 through, like its own footer
    // badge): click to open it in terminals that support links; others just show the text.
    const url = /^https?:\/\//i.test(String(prData.url || "")) ? String(prData.url) : "";
    const num = url ? `\x1b]8;;${url}\x07${label}\x1b]8;;\x07` : label;
    locSegs.push(`${MAGENTA}${gPR}${RESET} ${prColor}${num}${RESET}${mark}${extra}`);
  }
  if (tagInfo && on("repo.tag")) {
    const tagSuffix = tagInfo.count > 0 ? `${YELLOW}+${tagInfo.count}${RESET}` : "";
    locSegs.push(`${MAGENTA}${gTag}${RESET} ${VAL}${tagInfo.tag}${RESET}${tagSuffix}`);
  }
}

const addedDirCount = Array.isArray(data.workspace?.added_dirs) ? data.workspace.added_dirs.length : 0;
const launchDir = data.workspace?.project_dir || currentDir; // keys the auto-memory slug
const counts = displayRoot
  ? cachedByMtime(
      "cfg-" + hashPath(displayRoot),
      [
        displayRoot,
        join(displayRoot, ".git", "index"), // invalidate recursive doc counts on add/commit
        join(displayRoot, ".claude"),
        join(displayRoot, ".claude", "agents"),
        join(displayRoot, ".claude", "commands"),
        join(displayRoot, ".claude", "skills"),
        join(displayRoot, ".claude", "rules"),
        join(displayRoot, ".claude", "output-styles"),
        join(displayRoot, ".claude", "workflows"), // project workflows (saved orchestration scripts)
        join(displayRoot, ".claude", "routines"), // project routines (scheduled agents)
        join(displayRoot, ".mcp.json"), // project (shared) MCP servers
        join(displayRoot, "CLAUDE.md"),
        join(displayRoot, "AGENTS.md"),
        join(displayRoot, "CLAUDE.local.md"),
        join(displayRoot, "AGENTS.local.md"),
        join(HOME, ".claude.json"),
        join(HOME, ".config", "claude-code", "mcp.json"),
        join(HOME, ".claude", "settings.json"), // global hooks + enabledPlugins live here
        join(displayRoot, ".claude", "settings.json"), // project hooks
        join(displayRoot, ".claude", "settings.local.json"), // project-local hooks
        join(HOME, ".claude", "agents"), // global agents/commands/skills/rules/styles
        join(HOME, ".claude", "commands"),
        join(HOME, ".claude", "skills"),
        join(HOME, ".claude", "rules"),
        join(HOME, ".claude", "output-styles"),
        join(HOME, ".claude", "themes"), // user color themes (Config row — themes have a user scope, unlike Exts. items)
        join(HOME, ".claude", "channels"), // user-installed message channels (Exts. row)
        join(HOME, ".claude", "workflows"), // user workflows
        join(HOME, ".claude", "routines"), // user routines
        // Auto-memory candidate dirs — mtime bumps as memories are written mid-session. The
        // transcript-sibling dir is the authoritative location; the slug dirs are the fallbacks.
        // (Settings-override resolution lives in configCounts; the settings files are already
        // in this signature list.)
        data.transcript_path ? join(dirname(data.transcript_path), "memory") : "",
        mainRoot ? memorySlugDir(mainRoot) : "",
        launchDir ? memorySlugDir(launchDir) : "",
        join(HOME, ".claude", "CLAUDE.md"), // user-scope memory (doc)
        join(managedDir(), "managed-settings.json"), // enterprise/managed scope (hooks, claudeMd)
        join(managedDir(), "managed-mcp.json"), // enterprise/managed MCP
        join(managedDir(), "CLAUDE.md"), // enterprise/managed memory (doc)
        join(HOME, ".claude", "plugins", "installed_plugins.json"), // plugin-provided component counts
        join(HOME, ".claude", "plugins", "plugin-catalog-cache.json"), // marketplace-inline components (LSP etc.)
      ],
      // extraSig: added-dir count + the auto-memory kill switch — the env var isn't a watchable
      // file, so it must join the signature or a toggle would keep serving the cached counts.
      // data.version joins too: native AGENTS.md loading is version-gated (v2.1.277+), so a CC
      // upgrade must not keep serving counts computed under the old rules.
      addedDirCount + "|" + (process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY || "") + "|" + (data.version || ""),
      () => configCounts(displayRoot, data.workspace?.added_dirs, currentDir, mainRoot, launchDir, data.transcript_path, data.version)
    )
  : null;
// config gets its OWN row (own section). Numeric counts (no ✓/✗). Repo-relative docs
// (CLAUDE.md/AGENTS.md) only inside a repo; global items (hooks/plugins/global dirs) show
// whenever present — they're active regardless of whether the cwd is a git repo.
const configSegs = [];
const componentSegs = []; // the "Exts." row — plugin-exclusive component types, shown only when present
if (counts) {
  // "[icon] total (m/u/p/l/x)" — dim breakdown for every multi-scope item (breakdown:true) when
  // total>0. FIXED 5 columns, positions NEVER shift, broad→narrow: MANAGED / USER / PROJECT /
  // LOCAL / PLUGIN (CC renamed old "global"→"user", old "project"→"local"; PLUGIN = components
  // bundled by enabled plugins, lowest precedence). Each slot is ONE of two states:
  //   digit/0 — item is CAPABLE of that scope (`caps`), so show its count (0 = none from that
  //             scope; e.g. managed `m` reads 0 unless enterprise config defines some). Columns
  //             are FIXED, so you read the count directly.
  //   "-"     — scope is N/A: this item type CANNOT have it (`caps` lacks it) — e.g. agents/cmds/
  //             skills have no managed/local form, rules/styles no managed/local/plugin form.
  // (Now that capable-but-empty scopes read a true 0, "-" has a single unambiguous meaning: this
  // scope can NEVER apply to this item — not merely "absent right now".)
  const SCOPES = ["m", "u", "p", "l", "x"];
  const total = (c) => (c.m || 0) + (c.u || 0) + (c.p || 0) + (c.l || 0) + (c.x || 0);
  const seg = (head, c, { color = SOFT, breakdown = false, caps = "" } = {}) => {
    const base = `${color}${head}${RESET} ${total(c) > 0 ? GREEN : SOFT}${total(c)}${RESET}`;
    if (breakdown && total(c) > 0 && on("config.scopes")) {
      const tail = ` ${DIM}(${SCOPES.map((k) => (caps.includes(k) ? c[k] || 0 : "-")).join("/")})${RESET}`;
      // Two alts (widest-first), so packSection DROPS the (m/u/p/l/x) scope breakdown to reclaim
      // width before it has to wrap the row — every item's count stays visible; only the per-scope
      // detail goes, and only on rows that would otherwise overflow.
      return { alts: [base + tail, base] };
    }
    return base; // plain item (no breakdown): a single form, nothing to drop
  };
  // Every config widget renders its icon + count (0 included) so an empty category shows at a
  // glance; the breakdown parens appear only once total>0 (an all-0/"-" breakdown is just noise).
  const show = (id, head, c, opts) => on(`config.${id}`) && configSegs.push(seg(head, c, opts));
  // Instruction files — doc icon, NO letter: CLAUDE.md plus any AGENTS.md CC loads natively
  // (v2.1.277+, see configCounts) fold into ONE count — both are "project instructions in context",
  // and which flavor a repo uses isn't worth a second widget. Counted like every other widget: total across the scopes it CAN have,
  // breakdown showing where they live. caps "mupl" — managed/user/project/local; plugins don't
  // provide CLAUDE.md → "-".
  show("instructions", gCfgDoc, counts.claude, { color: c256(36), breakdown: true, caps: "mupl" }); // teal
  // Auto-memory — persistent per-project memory files (~/.claude/projects/<slug>/memory, minus
  // the MEMORY.md index). Sits by CLAUDE.md: both are content that loads into every session.
  // Flat count — one storage location, no scope spread.
  show("memory", gCfgMemory, counts.memory, { color: c256(177) }); // lilac
  // Agents/Cmds/Skills: User + Project + Plugin (no local/managed form) → caps "upx".
  // (Skills also subsumes output-styles — styles are migrating to skills, deduped by name:
  //  https://support.claude.com/en/articles/10181068-styles-are-moving-to-skills)
  show("agents", gCfgAgents, counts.agents, { color: c256(211), breakdown: true, caps: "upx" }); // pink
  show("commands", gCfgCmds, counts.commands, { color: c256(32), breakdown: true, caps: "upx" }); // green
  show("skills", gCfgSkills, counts.skills, { color: c256(141), breakdown: true, caps: "upx" }); // purple — incl. styles
  // Workflows (saved orchestration scripts): User + Project + Plugin → caps "upx".
  // Routines (scheduled agents): User + Project only → caps "up".
  show("workflows", gCfgWorkflows, counts.workflows, { color: c256(78), breakdown: true, caps: "upx" }); // spring green
  show("routines", gCfgRoutines, counts.routines, { color: c256(173), breakdown: true, caps: "up" }); // terracotta
  // Rules: User + Project only (plugins don't provide these) → caps "up".
  show("rules", gCfgRules, counts.rules, { color: c256(33), breakdown: true, caps: "up" }); // blue
  // MCP & Hooks support every scope (managed + user/project/local + plugin) → caps "muplx".
  show("mcp", gCfgMcp, counts.mcps, { color: c256(216), breakdown: true, caps: "muplx" }); // orange
  show("connectors", gCfgConn, counts.connectors, { color: c256(117) }); // sky — account-level, no breakdown
  // claude-in-chrome (built-in browser MCP): brand-colored Chrome glyph + uncolored ✓/✗ for ENABLED
  // (extension installed + toggle on + onboarded). Not a count → no breakdown. Live-connected is
  // session-only, so this is enabled, not connected.
  if (on("config.chrome")) configSegs.push(`${c256(75)}${gCfgChrome}${RESET} ${counts.chrome ? gOk : gNo}`);
  show("hooks", gCfgHooks, counts.hooks, { color: c256(220), breakdown: true, caps: "muplx" }); // gold
  show("plugins", gCfgPlugins, counts.plugins, { color: BRICK, breakdown: true, caps: "mupl" }); // LEGO red
  // Themes belong with the multi-scope Config items, not the plugin-only Exts. row: a theme can
  // come from a plugin (x) OR your own ~/.claude/themes/ (u), so it carries a u/x breakdown.
  show("themes", gCfgTheme, counts.themes, { color: c256(213), breakdown: true, caps: "ux" }); // orchid
  show("dirs", gCfgDirs, counts.dirs, { color: c256(250) }); // silver — session-added dirs

  // Exts. row — plugin-bundled component types that have no home on the Config row. Every widget
  // always renders (0 included), consistent with the Config row, so an empty category shows at a
  // glance. lsp/monitors/bin are x-only (no breakdown parens, like connectors/chrome/dirs); channels
  // is the exception — a channel can be installed at USER scope (~/.claude/channels/) OR declared by
  // a plugin, so it carries a u/x breakdown. (Themes is NOT here — it also has a user scope, so it
  // lives on the Config row.)
  const showC = (id, head, c, opts) => on(`exts.${id}`) && componentSegs.push(seg(head, c, opts));
  showC("lsp", gCfgLsp, counts.lsp, { color: c256(81) }); // light blue
  showC("monitors", gCfgMonitor, counts.monitors, { color: c256(209) }); // salmon
  showC("bin", gCfgBin, counts.bin, { color: c256(108) }); // sage
  showC("channels", gCfgChannel, counts.channels, { color: c256(116), breakdown: true, caps: "ux" }); // sky — user-installed + plugin
}

// Width-aware reflow. Claude Code sets COLUMNS in recent versions. statusLine.padding indents
// the whole line right by N chars (applied by CC's renderer, OUTSIDE our output), so it eats into
// usable width — subtract it. We also reserve a 2-cell cushion (not 1): glyph display-width is only
// ESTIMATED (vlen/isWide guesses Nerd-Font cell widths), so a font whose glyphs render wider than the
// guess can push a row past the real edge — the TERMINAL then hard-wraps it into an extra physical
// row Claude Code never counted → height desync (footer/input drawn in the wrong place). The cushion
// lets packSection wrap proactively (a line CC counts) before the terminal wraps one (which it doesn't).
const padding = readPositiveInt(settings.statusLine?.padding, 0);
// Width source, in order: COLUMNS env (set by recent Claude Code) → the TTY's own column count →
// 80. The finite 80 fallback is load-bearing for any host that DOESN'T export COLUMNS (e.g. when the
// statusline's stdout is piped rather than a TTY). The old `|| 1e9` made width ~1e9 there, so NOTHING
// wrapped or truncated — rows ran long, the real terminal hard-wrapped them back to col 0, and the
// overflow painted over the reply. A finite fallback keeps reflow conservative instead of overflowing.
const width = (parseInt(process.env.COLUMNS, 10) || process.stdout.columns || 80) - 2 - padding;
// Strip SGR color codes + OSC 8 hyperlink wrappers (the PR badge) so width math counts only visible glyphs.
const OSC8_RE = /\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(OSC8_RE, "");
const isWide = (codePoint) =>
  (codePoint >= 0xe000 && codePoint <= 0xf8ff) ||
  (codePoint >= 0xf0000 && codePoint <= 0xffffd) ||
  (codePoint >= 0x100000 && codePoint <= 0x10fffd);
const vlen = (s) => {
  let w = 0;
  for (const ch of stripAnsi(s)) w += isWide(ch.codePointAt(0)) ? 2 : 1;
  return w;
};

// Truncate to maxVisible cells while preserving ANSI escapes (so colors stay balanced),
// adding an ellipsis. Prevents a single over-long item from overflowing → terminal hard-wrap.
const truncateVisible = (s, maxVisible) => {
  if (maxVisible < 2 || vlen(s) <= maxVisible) return s;
  const limit = maxVisible - 1; // reserve 1 cell for the ellipsis
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
    const cp = s.codePointAt(i);
    const chLen = cp > 0xffff ? 2 : 1;
    const w = isWide(cp) ? 2 : 1;
    if (visible + w > limit) break;
    out += s.slice(i, i + chLen);
    visible += w;
    i += chLen;
  }
  // A cut inside a link would leave it open and turn the rest of the row into the link — close it.
  const opens = (out.match(OSC8_RE) || []).length;
  return `${out}${opens % 2 ? "\x1b]8;;\x07" : ""}…${RESET}`;
};

// An item carries one or more `alts` ordered WIDEST-first (e.g. a gauge is [full-with-bar,
// compact-no-bar]); plain strings become a single-alt item.
const toItems = (segments) =>
  segments.map((s) =>
    typeof s === "string" ? { alts: [s], sep: " | " } : { alts: s.alts, sep: " | " },
  );
const SECTION_WIDTH = 8;
const SEP = " | ";

// `lead` is rendered once after the label (e.g. the clock on the limits row). `leadWidth` is its
// TRUE rendered cell-width (icons here don't always match vlen's guess), used so continuation
// lines indent PAST it and wrapped items align text-under-text, not under the lead's icon.
//
// LAYOUT POLICY: two passes, with the second skipped for detail-preferring sections.
//   1. All-widest on one line — fast path, used by every section when there's room.
//   2. (compact-first sections only) All-narrowest on one line — gauge rows (Model/Limits/Usage)
//      prefer fitting compactly on a single row over wrapping with bars. Bars are decorative; the
//      numbers are the signal, so one tight row beats two with bar art.
//   3. GREEDY PER-ITEM wrap — each item tries widest, then narrowest on the current row, then wraps
//      to a fresh row with its widest form (an empty wrap row has room for detail). Used by Config
//      always, and by gauge rows when even all-narrowest won't fit one line.
// `preferDetail` (default false) flips off the all-narrowest one-line pass. The Config row passes
// true so its (m/u/p/l/x) breakdowns stay attached to items that wrap, instead of the whole row
// collapsing to bare counts.
// `maxRows` (default Infinity) caps how many lines the section may emit: when the greedy pass
// would wrap past the budget it CUTS instead — the finished row ends in " …" and the remaining
// items are dropped. Used by the total-height cap below (see HEIGHT), never passed directly.
// (NOTE: between fc7cbba and the 2026-06-12 revert, packSection was fixed-height / truncate-only to
// dodge a Claude Code resize-stacking under-clear; that bug was fixed upstream in CC v2.1.170, so
// wrapping is back. Multi-row sections still trigger the under-clear on PRE-2.1.170 CC versions.)
function packSection(label, segments, lead = "", leadWidth = null, preferDetail = false, maxRows = Infinity) {
  if (!segments.length) return [];

  const items = toItems(segments);
  // Capitalize the first char — labels render in italic, where title-case reads nicer.
  const labelCap = label.charAt(0).toUpperCase() + label.slice(1);
  const prefixPlain = labelCap.padEnd(SECTION_WIDTH);
  // labels:false (config) drops the label column entirely — rows start at their lead/first item.
  const prefix = cfg.labels ? `${BOLD}${ITALIC}${SOFT}${prefixPlain}${RESET} ${lead}` : lead;
  // U+2800 (Braille blank) renders blank but is NOT whitespace, so Claude Code's per-line
  // leading-whitespace strip leaves it intact — keeps wrapped rows aligned under the content.
  const indentWidth = (cfg.labels ? SECTION_WIDTH + 1 : 0) + (leadWidth ?? vlen(lead));
  const indent = cp(0x2800).repeat(indentWidth);
  const maxItemWidth = width - indentWidth; // widest an item can be on its own line

  // One-line fast-path probes. `forms` already chosen (all-widest or all-narrowest); just measure.
  const fitsOneLine = (forms) => {
    const total = vlen(prefix) + forms.reduce((w, f) => w + vlen(f), 0) + (forms.length - 1) * SEP.length;
    return total <= width ? prefix + forms.join(SEP) : null;
  };
  // SQUEEZE mode (the height cap re-packing us with a finite maxRows): every row we can't fit is
  // now CUT, not wrapped, so a cut item is lost outright. Under that budget the compact form wins
  // for everyone — bars and scope parens are decorative, a dropped gauge is data loss — so items
  // go narrow-first and the all-narrow one-line probe runs even for detail-preferring sections.
  const squeeze = Number.isFinite(maxRows);
  const wideLine = fitsOneLine(items.map((it) => it.alts[0]));
  if (wideLine !== null) return [wideLine];
  if (!preferDetail || squeeze) {
    const narrowLine = fitsOneLine(items.map((it) => it.alts[it.alts.length - 1]));
    if (narrowLine !== null) return [narrowLine];
  }

  // Greedy per-item: walk left-to-right, widest → narrowest on current row → wrap with widest
  // (or narrow-first throughout when squeezing).
  const rows = [];
  let cur = prefix;
  let curLen = vlen(prefix);
  let placed = 0;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const wide = it.alts[0];
    const narrow = it.alts[it.alts.length - 1];
    const wideLen = vlen(wide);
    const narrowLen = vlen(narrow);
    const sepLen = placed > 0 ? SEP.length : 0;
    const first = squeeze ? narrow : wide; // preferred form on the current row
    const firstLen = squeeze ? narrowLen : wideLen;

    if (curLen + sepLen + firstLen <= width) {
      cur += (placed > 0 ? SEP : "") + first;
      curLen += sepLen + firstLen;
    } else if (curLen + sepLen + narrowLen <= width) {
      // (Also the FIRST item's path: an empty row must try the compact form before it wraps or
      // cuts — otherwise a squeezed row could emit nothing but the label and an ellipsis.)
      cur += (placed > 0 ? SEP : "") + narrow;
      curLen += sepLen + narrowLen;
    } else if (placed === 0) {
      // The row is still empty and even the compact form overflows: nothing to wrap away from, so
      // truncate in place. Never wrap here — the wrap row would be identical to this one.
      const form = truncateVisible(narrow, width - curLen);
      cur += form;
      curLen += vlen(form);
    } else {
      // Row budget spent → CUT instead of wrapping: end the current row with an ellipsis (the
      // " |" continuation marker would promise a next line that isn't coming) and drop the rest.
      if (rows.length + 2 > maxRows) {
        if (curLen + 2 <= width) cur += ` ${SOFT}…${RESET}`;
        break;
      }
      // Wrap. Trailing " |" continuation marker on the finished line (dropping it silently reads
      // as confusing). Skip if even the marker won't fit.
      const marker = curLen + 2 <= width ? ` ${SOFT}|${RESET}` : "";
      rows.push(cur + marker);
      // Place the preferred form on the new row; only if it overflows do we degrade — to narrow
      // if that fits, else truncate the narrow form (whatever the alt count: an item wider than
      // the terminal must never go out unclipped — that's the hard-wrap that desyncs CC's repaint).
      let form = first;
      let formLen = firstLen;
      if (indentWidth + formLen > width) {
        if (indentWidth + narrowLen <= width) {
          form = narrow;
          formLen = narrowLen;
        } else {
          form = truncateVisible(narrow, maxItemWidth);
          formLen = vlen(form);
        }
      }
      cur = indent + form;
      curLen = indentWidth + formLen;
    }
    placed++;
  }

  rows.push(cur);
  return rows;
}

// One ENTRY PER SECTION; each packSection emits 0, 1, or (when the row is too wide even after
// dropping bars + scope-breakdown parens) multiple wrapped lines. Kept as [label, segs, ...args]
// SPECS (not packed results) so the height cap below can RE-pack an over-budget section with a
// tighter maxRows. The spec count is the fixed line budget (see HEIGHT below).
const sectionSpecs = [
  // Label ≠ var name for a few (renamed for clearer categories): session→Model, rate→Usage,
  // work→Repo. Vars kept to limit churn.
  ["model", sessionSegs],
  ["limits", quotaSegs, limitLead, limitLeadW],
  ["usage", rateSegs],
  ["turn", turnSegs],
  ["activity", activitySegs],
  ["repo", locSegs],
  ["config", configSegs, "", null, true], // preferDetail: keep (m/u/p/l/x) breakdowns attached to wrapped items instead of collapsing to bare counts
  ["exts.", componentSegs],
  ["host", hostSegs],
  // "Info." row LAST — nearest the prompt. Leads with the CWD (always-present location anchor — the
  // Repo row above is repo-only now), then vim mode (where CC's native "-- INSERT --" used to sit),
  // output-style, version, agent name, and session id.
  ["info.", stateSegs],
].filter(([label]) => cfg.rows.includes(label.replace(/\.$/, ""))) // config: row selection…
  .sort((a, b) => cfg.rows.indexOf(a[0].replace(/\.$/, "")) - cfg.rows.indexOf(b[0].replace(/\.$/, ""))); // …and order
const sections = sectionSpecs.map(([label, segs, lead, leadWidth, preferDetail]) =>
  packSection(label, segs, lead ?? "", leadWidth ?? null, preferDetail ?? false),
);

// HEIGHT BUDGET — how many CONTENT rows the dashboard may emit (total output is that + 1 gap
// row). Three failure modes drive this:
//   SHRINK between renders: CC reserves vertical space by the previous render's line count then
//   clears that many and repaints; if our count DROPS the old frame's extra rows aren't cleared
//   and STACK (worst offender was /clear wiping Turn + Activity at once → 2 ghost rows per
//   /clear; under-clear fixed upstream in CC v2.1.170 but kept defensive). Guarded two ways:
//   empty sections backfill with blank rows up to the slot floor, and a per-session HIGH-WATER
//   MARK (sl-hwm-*.json, keyed to the terminal geometry) pads renders up to the tallest height
//   already shown — so once a wrap grows the dashboard, later wrap-free renders keep the height
//   instead of shrinking. The mark resets when COLUMNS/LINES change (a resize forces CC into a
//   full repaint anyway).
//   SHORT TERMINAL: CC gives the statusline whatever remains AFTER the current turn's
//   transcript tail + prompt box + its own footer — and when that's less than our height it
//   hard-trims our tail AND the footer/mode line rather than scrolling (observed v2.1.223,
//   102×26 split pane: a 13-line dashboard got ~9 rows, cut stayed until the turn content
//   scrolled). The transcript share is unknowable per-render, so budget by proportion instead:
//   the dashboard takes at most a THIRD of LINES (CC's terminal-height belief, exported
//   alongside COLUMNS — trust it even when the real pane is bigger, because CC lays out and
//   trims by its belief). Over budget: wrapped rows are squeezed out (cut with a trailing
//   " …"), then whole sections drop in DROP_ORDER.
//   RUNAWAY GROWTH on tall terminals: wraps are welcome when LINES has room (that's the whole
//   point of a tall window — no "…" data loss), but bounded by WRAP_HEADROOM extra rows past the
//   section count so a pathological wrap can't produce a 20-line dashboard.
// SQUEEZE_ORDER (which section loses a WRAPPED line first): densest/most-redundant detail first,
// location + host anchors last. DROP_ORDER (which section vanishes ENTIRELY on short terminals):
// ends with the essentials — Info/Limits/Model survive longest.
const SQUEEZE_ORDER = ["config", "exts.", "activity", "turn", "usage", "limits", "model", "repo", "host", "info."];
const DROP_ORDER = ["exts.", "config", "host", "activity", "turn", "repo", "usage", "info.", "limits", "model"];
const WRAP_HEADROOM = 4; // max wrap rows past the section count, even on a very tall terminal
const termRows = parseInt(process.env.LINES, 10) || 0; // 0 → unknown (piped tests) → treat as roomy
const maxContent = Math.min(
  cfg.maxRows, // config can only LOWER the budget
  sectionSpecs.length + WRAP_HEADROOM,
  termRows > 0 ? Math.max(1, Math.floor(termRows / 3)) : Infinity, // ≤ a third of the terminal
);
{
  const specIdx = (label) => sectionSpecs.findIndex((s) => s[0] === label);
  let total = sections.reduce((n, s) => n + s.length, 0);
  // Pass 1 — squeeze: re-pack the tallest wrapped section one row shorter until we fit (or
  // every section is down to a single row).
  while (total > maxContent) {
    let idx = -1;
    let tallest = 1;
    for (const label of SQUEEZE_ORDER) {
      const i = specIdx(label);
      if (i >= 0 && sections[i].length > tallest) {
        tallest = sections[i].length;
        idx = i;
      }
    }
    if (idx < 0) break; // nothing multi-row left — pass 2 drops whole sections
    const [label, segs, lead, leadWidth, preferDetail] = sectionSpecs[idx];
    sections[idx] = packSection(label, segs, lead ?? "", leadWidth ?? null, preferDetail ?? false, tallest - 1);
    total = sections.reduce((n, s) => n + s.length, 0);
  }
  // Pass 2 — drop: on terminals too short for one row per section, whole sections vanish in
  // DROP_ORDER until the dashboard fits.
  for (const label of DROP_ORDER) {
    if (total <= maxContent) break;
    const i = specIdx(label);
    if (i >= 0 && sections[i].length > 0) {
      total -= sections[i].length;
      sections[i] = [];
    }
  }
}

const blank = cp(0x2800); // U+2800: non-whitespace, so CC's trailing-blank-row strip preserves it
const contentRows = sections.flat().filter(Boolean); // the non-empty section lines, in order
// Final height = max(content, slot floor, this session's high-water mark at this geometry) —
// see SHRINK above. The floor keeps /clear from dropping rows; the mark keeps a wrap-then-unwrap
// cycle from dropping them.
// The config file's mtime joins the key: hiding rows is a deliberate shrink, so a config edit resets
// the mark like a resize does instead of padding the new, shorter layout up to the old height.
const geom = `${process.env.COLUMNS || ""}x${process.env.LINES || ""}|${statMtime(CONFIG_PATH)}`;
const hwmFile =
  (process.env.TEMP || process.env.TMP || "/tmp").replace(/\\/g, "/") + "/sl-hwm-" + hashPath(sid || "nosid") + ".json";
const prevHwm = readJson(hwmFile);
const floor = Math.min(sectionSpecs.length, maxContent);
const carried = prevHwm && prevHwm.geom === geom ? Math.min(prevHwm.h || 0, maxContent) : 0;
const HEIGHT = Math.max(contentRows.length, floor, carried);
try {
  if (!prevHwm || prevHwm.geom !== geom || prevHwm.h !== HEIGHT)
    require("node:fs").writeFileSync(hwmFile, JSON.stringify({ geom, h: HEIGHT }));
} catch {}
// Content packs to the TOP; blank slots backfill to HEIGHT so the gap rides at the BOTTOM (above the
// prompt) instead of opening holes mid-dashboard. After /clear you briefly see that gap where Turn +
// Activity were; it heals as soon as you resume work and those rows return — height never changes.
const rows = contentRows.concat(Array(Math.max(0, HEIGHT - contentRows.length)).fill(blank));

// One trailing blank gap row above the prompt → total is ALWAYS HEIGHT + 1 lines. (It also guarantees
// a gap even when every slot is filled, i.e. there's nothing to backfill.)
process.stdout.write(rows.join("\n") + "\n" + blank);
