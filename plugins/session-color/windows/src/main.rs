// No console window flash when spawned by Claude Code's hook system.
#![windows_subsystem = "windows"]

// CC Hooks — Windows session-color
//
// Tint the terminal background by Claude Code session status, via OSC 11.
// Pure hook: no launcher, no per-session theme files. Works in /tui fullscreen
// too — Claude inherits the terminal background rather than painting opaque
// cells, so an OSC 11 change to the pane's background shows through (on terminals
// that honor OSC 11 under the alternate screen).
//
// THE CATCH this solves: hooks run WITHOUT their stdout wired to the terminal —
// Claude Code captures the hook's stdout, so a naive `print!` never reaches the
// pane. There is no /dev/tty on Windows either. Instead we walk up the process
// tree to the Claude process, AttachConsole() to *its* console — which is the
// pane's pseudoconsole (ConPTY) — and write the escape to CONOUT$. ConPTY then
// relays it to the terminal. Because the ConPTY is per-pane, concurrent sessions
// never clobber each other.
//
// Subcommands (each invoked as a separate process by hook events):
//   working | needs | done | failed | idle | reset  — paint the pane (the hook itself)
//   install                          — register the status->color hooks
//   uninstall                        — remove them again
//
// States (wired into ~/.claude/settings.json by `install`):
//   working  amber   -> UserPromptSubmit, PostToolUse, PostToolUseFailure,
//                       ElicitationResult            (Claude is busy; you wait)
//   needs    red     -> PermissionRequest, Elicitation
//                                          (blocked: Claude needs a decision)
//   done     green   -> Stop               (turn finished; your move)
//   failed   orange  -> StopFailure        (turn ended on an API error; plugin only)
//   idle     blue    -> Notification/idle_prompt   (done, gone cold; plugin only —
//                                          the dispatcher lets it through only from done)
//   reset    default -> SessionStart, SessionEnd
//
// Note: of Notification's types only idle_prompt is wired, and only by the plugin's
// hooks.json (see README); the others repaint states the specific events cover.
//
// NOTE ON FEASIBILITY: this depends on ConPTY forwarding OSC 11 background
// changes through to Windows Terminal. Modern Windows 11 + Windows Terminal
// honor OSC 11; older builds may swallow it. Tweak the hex values below.

use std::collections::HashMap;
use std::env;
use std::fs;
use std::mem::size_of;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use windows::core::*;
use windows::Win32::Foundation::*;
use windows::Win32::Storage::FileSystem::*;
use windows::Win32::System::Console::*;
use windows::Win32::System::Diagnostics::ToolHelp::*;

// event -> status argument. Keep in sync with the macOS/Linux installers.
const MAPPING: &[(&str, &str)] = &[
    ("SessionStart", "reset"),
    ("UserPromptSubmit", "working"),
    ("PostToolUse", "working"),
    ("PostToolUseFailure", "working"),
    ("ElicitationResult", "working"),
    ("PermissionRequest", "needs"),
    ("Elicitation", "needs"),
    ("Stop", "done"),
    ("SessionEnd", "reset"),
];

fn main() -> ExitCode {
    let exe = env::current_exe().unwrap_or_default();
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: session-color <working|needs|done|failed|idle|reset|install|uninstall>");
        return ExitCode::from(1);
    }

    let code = match args[1].as_str() {
        "install" => install_hooks(&exe),
        "uninstall" => uninstall_hooks(),
        state => paint(state),
    };

    ExitCode::from(code as u8)
}

// ═══════════════════════════════════════
// paint — the hook itself
// ═══════════════════════════════════════

fn paint(state: &str) -> i32 {
    // Dim tints keep text readable across the whole pane.
    let seq: &[u8] = match state {
        "working" => b"\x1b]11;#574515\x07", // amber — working
        "needs" => b"\x1b]11;#501d22\x07",   // red   — needs you (blocking)
        "done" => b"\x1b]11;#233f20\x07",    // green — done, your move
        "failed" => b"\x1b]11;#5c2e0e\x07",  // orange — turn died on an API error
        "idle" => b"\x1b]11;#1d3150\x07",    // blue  — done, gone cold
        _ => b"\x1b]111\x07",                // reset bg to terminal default
    };

    unsafe {
        // Attach to the Claude process's console (the pane's ConPTY). If we can't
        // find Claude or can't attach (e.g. running under an IDE, not a terminal),
        // there's nothing to paint — bail quietly.
        if let Some(pid) = find_claude_pid() {
            let _ = FreeConsole();
            if AttachConsole(pid).is_err() {
                return 0;
            }
        }

        // CONOUT$ = the attached console's active screen buffer. Writing the VT
        // sequence here feeds it through ConPTY to the terminal.
        let handle = CreateFileW(
            w!("CONOUT$"),
            0xC000_0000, // GENERIC_READ | GENERIC_WRITE
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(0),
            None,
        );
        let Ok(handle) = handle else {
            let _ = FreeConsole();
            return 0;
        };

        let mut written = 0u32;
        let _ = WriteFile(handle, Some(seq), Some(&mut written), None);
        let _ = CloseHandle(handle);
        let _ = FreeConsole();
    }

    0
}

// ═══════════════════════════════════════
// Process tree walk — find the Claude ancestor
//
// Uses CreateToolhelp32Snapshot to walk from our PID upward through parents,
// stopping at the first process named "claude". That process owns the pane's
// ConPTY, which we attach to in paint().
// ═══════════════════════════════════════

fn find_claude_pid() -> Option<u32> {
    let procs = snapshot_processes();
    let mut pid = std::process::id();
    for _ in 0..32 {
        let (ppid, _) = procs.get(&pid)?;
        let ppid = *ppid;
        if ppid == 0 || ppid == pid {
            return None;
        }
        let (_, name) = procs.get(&ppid)?;
        let base = name.strip_suffix(".exe").unwrap_or(name);
        if base.eq_ignore_ascii_case("claude") {
            return Some(ppid);
        }
        pid = ppid;
    }
    None
}

fn snapshot_processes() -> HashMap<u32, (u32, String)> {
    let mut map = HashMap::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return map;
        };
        let mut pe = PROCESSENTRY32W {
            dwSize: size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };

        if Process32FirstW(snap, &mut pe).is_ok() {
            loop {
                let len = pe
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(pe.szExeFile.len());
                let name = String::from_utf16_lossy(&pe.szExeFile[..len]);
                map.insert(pe.th32ProcessID, (pe.th32ParentProcessID, name));
                if Process32NextW(snap, &mut pe).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    map
}

// ═══════════════════════════════════════
// install / uninstall — manages ~/.claude/settings.json
//
// Additive and idempotent: existing hooks (e.g. notifications) on the same
// events are preserved; re-running just refreshes the session-color entries.
// ═══════════════════════════════════════

fn settings_path() -> PathBuf {
    let home = env::var("USERPROFILE").unwrap_or_else(|_| env::var("HOME").unwrap_or_default());
    PathBuf::from(home).join(".claude").join("settings.json")
}

/// True if a hook entry's command is one of ours.
fn is_session_color(hook: &serde_json::Value) -> bool {
    hook.get("command")
        .and_then(|c| c.as_str())
        .map_or(false, |c| c.contains("session-color"))
}

fn install_hooks(exe: &Path) -> i32 {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let mut settings: serde_json::Value = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    if !settings.is_object() {
        settings = serde_json::json!({});
    }

    let cmd = exe.to_string_lossy().replace('\\', "/");

    let hooks = settings
        .as_object_mut()
        .unwrap()
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));

    for (event, arg) in MAPPING {
        let blocks = hooks
            .as_object_mut()
            .unwrap()
            .entry(*event)
            .or_insert_with(|| serde_json::json!([]));
        let blocks = blocks.as_array_mut().unwrap();

        if blocks.is_empty() {
            blocks.push(serde_json::json!({ "matcher": "", "hooks": [] }));
        }

        // Drop any prior session-color command on this event (across all blocks)...
        for b in blocks.iter_mut() {
            if let Some(list) = b.get_mut("hooks").and_then(|h| h.as_array_mut()) {
                list.retain(|h| !is_session_color(h));
            }
        }

        // ...then append the current one to the first block.
        if let Some(list) = blocks[0].get_mut("hooks").and_then(|h| h.as_array_mut()) {
            list.push(serde_json::json!({
                "type": "command",
                "command": format!("{cmd} {arg}")
            }));
        }
    }

    let Ok(json) = serde_json::to_string_pretty(&settings) else {
        return 1;
    };
    if fs::write(&path, format!("{json}\n")).is_err() {
        return 1;
    }

    eprintln!("Registered session-color on {} events in {}", MAPPING.len(), path.display());
    0
}

fn uninstall_hooks() -> i32 {
    let path = settings_path();
    let Ok(content) = fs::read_to_string(&path) else {
        eprintln!("No settings.json — nothing to uninstall");
        return 0;
    };
    let Ok(mut settings) = serde_json::from_str::<serde_json::Value>(&content) else {
        eprintln!("Uninstalled");
        return 0;
    };

    if let Some(hooks) = settings.get_mut("hooks").and_then(|h| h.as_object_mut()) {
        let events: Vec<String> = hooks.keys().cloned().collect();
        for event in events {
            if let Some(blocks) = hooks.get_mut(&event).and_then(|b| b.as_array_mut()) {
                for b in blocks.iter_mut() {
                    if let Some(list) = b.get_mut("hooks").and_then(|h| h.as_array_mut()) {
                        list.retain(|h| !is_session_color(h));
                    }
                }
                // Drop blocks left with no hooks.
                blocks.retain(|b| {
                    b.get("hooks")
                        .and_then(|h| h.as_array())
                        .map_or(false, |l| !l.is_empty())
                });
            }
            // Drop events left with no blocks.
            let empty = hooks
                .get(&event)
                .and_then(|b| b.as_array())
                .map_or(false, |b| b.is_empty());
            if empty {
                hooks.remove(&event);
            }
        }
        if hooks.is_empty() {
            settings.as_object_mut().unwrap().remove("hooks");
        }
    }

    if let Ok(json) = serde_json::to_string_pretty(&settings) {
        let _ = fs::write(&path, format!("{json}\n"));
    }

    eprintln!("Removed session-color hooks from {}", path.display());
    0
}
