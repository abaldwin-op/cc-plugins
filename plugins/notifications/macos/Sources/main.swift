// CC Hooks — macOS notification system
//
// Single binary with subcommands, called by Claude Code hooks (settings.json):
//   on-submit  — UserPromptSubmit hook. Captures session state (timestamp, cwd,
//                terminal, editor, tty) to a temp file for notify to read later.
//   notify     — Notification/Stop hook (async: true). Shows a native notification
//                via UserNotifications framework. Blocks until click/dismiss, then
//                dispatches to focus or editor-open. Replaces by session ID.
//                Falls back to terminal-notifier, then osascript.
//   focus      — Focuses the correct terminal window/tab/pane using AppleScript.
//                Supports Ghostty (by terminal id), iTerm2 (by session id), Terminal.app (by tty).
//   on-end     — SessionEnd hook. Cleans up temp files and the session's notification.
//   (no args)  — LaunchServices relaunching the bundle for a click on a notification whose
//                poster has exited: handles that click from the notification's userInfo.
//   install    — Merges hook config into ~/.claude/settings.json.
//   uninstall  — Removes hooks from settings.json, cleans up temp files.
//
// Config: ~/.claude/notifications/config.json (see baseDir below; falls back to walking up from
//         the binary). See config.json.example.
//   terminal: "ghostty" | "iterm2" | "terminal" (app to focus on click)
//   editor:   "zed" | "code" | "cursor" (app to open project in)
//
// State: /tmp/claude-timer-{session_id}.txt (pipe-delimited session data, incl. Claude's PID)
//        /tmp/claude-notifier-{session_id}.txt (PID of notification process)
// Both are swept once their session's Claude process is gone, as are its notifications.

import Foundation
import CoreGraphics
import UserNotifications
import AppKit

// MARK: - Config

struct Config: Decodable {
    var title: String?
    var terminal: String?
    var editor: String?
    var desktop: Bool?       // false = skip desktop notification (webhook-only mode)
    var sound: String?       // "default", sound name, or "" to disable
    var messages: Messages?
    var icons: Icons?
    var webhook: Webhook?

    struct Messages: Decodable {
        var notification: String?
        var permission: String?
        var elicitation: String?
        var idle: String?
        var stop: String?
    }

    struct Icons: Decodable {
        var app: String?
        var notification: String?
        var permission: String?
        var elicitation: String?
        var idle: String?
        var stop: String?
    }

    struct Webhook: Decodable {
        var enabled: Bool?    // false = disable webhook without removing config
        var url: String?
        var idle_minutes: Int?
        var payload: String?  // Path to JSON template file
    }
}

func loadConfig(baseDir: String) -> Config {
    let path = (baseDir as NSString).appendingPathComponent("config.json")
    guard let data = FileManager.default.contents(atPath: path),
          let config = try? JSONDecoder().decode(Config.self, from: data)
    else { return Config() }
    return config
}

// MARK: - Helpers

func readStdin() -> [String: Any]? {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard !data.isEmpty,
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    return json
}

func nowMs() -> UInt64 {
    UInt64(Date().timeIntervalSince1970 * 1000)
}

func formatElapsed(_ ms: UInt64) -> String {
    let s = ms / 1000
    if s < 1 { return "(<1s)" }
    if s < 60 { return "(\(s)s)" }
    if s < 3600 { return "(\(s/60)m \(s%60)s)" }
    return "(\(s/3600)h \(s/60%60)m)"
}

/// Escapes a string for safe interpolation into AppleScript
func escapeAppleScript(_ s: String) -> String {
    s.replacingOccurrences(of: "\\", with: "\\\\")
     .replacingOccurrences(of: "\"", with: "\\\"")
     .replacingOccurrences(of: "\n", with: "\\n")
     .replacingOccurrences(of: "\r", with: "\\r")
     .replacingOccurrences(of: "\t", with: "\\t")
}

/// Escapes a string for safe use inside a single-quoted shell argument.
/// Single quotes can't be escaped inside single quotes, so we end the quote,
/// add an escaped single quote, and re-open the quote: 'foo'\''bar'
func escapeForShellSingleQuote(_ s: String) -> String {
    s.replacingOccurrences(of: "'", with: "'\\''")
}

// MARK: - AFK detection

func getIdleSeconds() -> Double {
    CGEventSource.secondsSinceLastEventType(
        .combinedSessionState,
        eventType: CGEventType(rawValue: ~0)!  // kCGAnyInputEventType
    )
}

func isScreenLocked() -> Bool {
    guard let dict = CGSessionCopyCurrentDictionary() as? [String: Any] else {
        return true // No GUI session (e.g. SSH) — treat as AFK
    }
    return (dict["CGSSessionScreenIsLocked"] as? Int ?? 0) == 1
}

func isAFK(idleMinutes: Int) -> Bool {
    if isScreenLocked() { return true }
    return getIdleSeconds() >= Double(idleMinutes * 60)
}

// MARK: - Webhook

/// Sends a webhook by reading a JSON template file and substituting variables.
/// Variables: {{title}}, {{message}}, {{elapsed}}, {{project}}, {{event}}, {{notification_type}},
/// {{session}} (the /rename title, else the short session id)
func sendWebhook(url: String, templatePath: String, vars: [String: String]) {
    guard let requestUrl = URL(string: url) else { return }
    guard var template = try? String(contentsOfFile: templatePath, encoding: .utf8) else { return }

    for (key, value) in vars {
        template = template.replacingOccurrences(of: "{{\(key)}}", with: value)
    }

    var request = URLRequest(url: requestUrl)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = template.data(using: .utf8)

    let sem = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: request) { _, _, _ in
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 10) // 10s timeout
}

/// Maps config terminal name to macOS app name
func terminalAppName(_ terminal: String) -> String {
    switch terminal.lowercased() {
    case "ghostty": return "Ghostty"
    case "iterm", "iterm2": return "iTerm2"
    case "terminal": return "Terminal"
    case "wezterm": return "WezTerm"
    default: return terminal
    }
}

/// Maps config editor name to macOS app name
func editorAppName(_ editor: String) -> String {
    switch editor.lowercased() {
    case "zed": return "Zed"
    case "code", "vscode": return "Visual Studio Code"
    case "cursor": return "Cursor"
    default: return editor
    }
}

/// Runs a shell command and returns stdout
@discardableResult
func shell(_ command: String) -> String {
    let process = Process()
    let pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: "/bin/bash")
    process.arguments = ["-c", command]
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    try? process.run()
    process.waitUntilExit()
    return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
}

/// Runs an AppleScript via osascript stdin (avoids shell quoting issues)
@discardableResult
func osascript(_ script: String) -> String {
    let process = Process()
    let outPipe = Pipe()
    let inPipe = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    process.arguments = ["-"]
    process.standardInput = inPipe
    process.standardOutput = outPipe
    process.standardError = FileHandle.nullDevice
    try? process.run()
    inPipe.fileHandleForWriting.write(script.data(using: .utf8) ?? Data())
    inPipe.fileHandleForWriting.closeFile()
    process.waitUntilExit()
    return String(data: outPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
}

/// Walks the process tree to check if a known terminal emulator is an ancestor.
/// Returns false if running inside an IDE (Zed, VS Code, Cursor, etc.).
func isRunningInTerminal(_ terminal: String) -> Bool {
    let knownTerminals = ["ghostty", "iterm2", "terminal", "wezterm"]
    var pid = ProcessInfo.processInfo.processIdentifier
    for _ in 0..<20 {
        let output = shell("ps -o ppid=,comm= -p \(pid)")
        let trimmed = output.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { break }
        // ppid is first, comm is the rest
        let parts = trimmed.split(separator: " ", maxSplits: 1)
        guard parts.count >= 2 else { break }
        let ppid = Int32(parts[0]) ?? 0
        let comm = String(parts[1])
        let name = (comm as NSString).lastPathComponent.lowercased()
        // Check if this ancestor is the configured terminal or a known one
        if name == terminal.lowercased() || knownTerminals.contains(name) {
            return true
        }
        if ppid <= 1 { break }
        pid = ppid
    }
    return false
}

/// Finds the tty device by walking up the process tree
func findTty() -> String {
    var pid = ProcessInfo.processInfo.processIdentifier
    for _ in 0..<10 {
        let output = shell("ps -o tty=,ppid= -p \(pid)")
        let parts = output.split(separator: " ", maxSplits: 1)
        guard parts.count >= 2 else { break }
        let tty = String(parts[0])
        if tty != "??" && !tty.isEmpty && tty != "-" {
            return tty.hasPrefix("/dev/") ? tty : "/dev/\(tty)"
        }
        pid = Int32(parts[1].trimmingCharacters(in: .whitespaces)) ?? 0
        if pid <= 1 { break }
    }
    return ""
}

/// Claude Code's own process: the native build's executable, or node/bun running the npm CLI.
/// Same test as session-color's is_claude — a shell whose command line merely mentions a claude
/// path (a hook command) is not Claude.
func isClaude(_ pid: Int32) -> Bool {
    if (shell("ps -o comm= -p \(pid)") as NSString).lastPathComponent == "claude" { return true }
    let argv = shell("ps -o args= -p \(pid)").split(separator: " ").map(String.init)
    guard let first = argv.first else { return false }
    switch (first as NSString).lastPathComponent {
    case "claude": return true
    case "node", "bun": return argv.count > 1 && argv[1].contains("claude")
    default: return false
    }
}

/// PID of the nearest Claude Code ancestor — the session this hook belongs to — or 0.
func findClaudePid() -> Int32 {
    var pid = getppid()
    for _ in 0..<20 {
        guard pid > 1 else { break }
        if isClaude(pid) { return pid }
        pid = Int32(shell("ps -o ppid= -p \(pid)")) ?? 0
    }
    return 0
}

/// A session lives as long as its Claude process. Closing the pane kills Claude without a
/// SessionEnd, so this — not the hook — is what says a session is gone. The identity check guards
/// against PID reuse. 0 (unknown: state from an older build) counts as alive: no evidence either way.
func isSessionAlive(_ pid: Int32) -> Bool {
    pid <= 0 || (kill(pid, 0) == 0 && isClaude(pid))
}

/// The session's name as the user knows it: its /rename title, else the short id Claude Code shows
/// (first 8 hex digits). The title isn't in the hook input; the transcript appends a
/// `custom-title` entry on rename and again as the session goes on, so the last one is current.
/// Searched from the end, without decoding the (possibly many-MB) transcript.
func sessionLabel(sid: String, transcriptPath: String) -> String {
    let short = String(sid.prefix(8))
    guard !transcriptPath.isEmpty,
          let data = FileManager.default.contents(atPath: transcriptPath),
          let hit = data.range(of: Data("\"type\":\"custom-title\"".utf8), options: .backwards)
    else { return short }
    let newline = UInt8(ascii: "\n")
    let start = data[..<hit.lowerBound].lastIndex(of: newline).map { $0 + 1 } ?? data.startIndex
    let end = data[hit.upperBound...].firstIndex(of: newline) ?? data.endIndex
    guard let entry = try? JSONSerialization.jsonObject(with: data[start..<end]) as? [String: Any],
          let title = entry["customTitle"] as? String, !title.isEmpty
    else { return short }
    return title
}

/// Writes raw bytes to a tty device without making it our controlling terminal (hooks have none).
func writeTty(_ tty: String, _ s: String) {
    let fd = open(tty, O_WRONLY | O_NOCTTY | O_NONBLOCK)
    guard fd >= 0 else { return }
    s.withCString { _ = write(fd, $0, strlen($0)) }
    close(fd)
}

// MARK: - Temp files

func timerPath(_ sid: String) -> String { "/tmp/claude-timer-\(sid).txt" }
func notifierPidPath(_ sid: String) -> String { "/tmp/claude-notifier-\(sid).txt" }

func timerWrite(_ sid: String, _ data: String) {
    try? data.write(toFile: timerPath(sid), atomically: true, encoding: .utf8)
}

func timerRead(_ sid: String) -> [String]? {
    guard let content = try? String(contentsOfFile: timerPath(sid), encoding: .utf8)
    else { return nil }
    return content.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "|")
}

func timerDelete(_ sid: String) {
    try? FileManager.default.removeItem(atPath: timerPath(sid))
}

func notifierPidDelete(_ sid: String) {
    try? FileManager.default.removeItem(atPath: notifierPidPath(sid))
}

/// Kills the previous notification process for this session and waits for it to exit
func killPreviousNotifier(_ sid: String) {
    let path = notifierPidPath(sid)
    guard let content = try? String(contentsOfFile: path, encoding: .utf8),
          let pid = Int32(content.trimmingCharacters(in: .whitespaces)),
          pid > 0
    else { return }
    kill(pid, SIGTERM)
    // Wait briefly for the old process to die so it releases the notification
    for _ in 0..<10 {
        if kill(pid, 0) != 0 { break } // Process is gone
        usleep(50_000) // 50ms
    }
    // Force kill if still alive
    if kill(pid, 0) == 0 { kill(pid, SIGKILL) }
    try? FileManager.default.removeItem(atPath: path)
}

/// Removes the session's notification from Notification Center. Spawned as a short-lived child
/// (UNUserNotificationCenter wants an NSApplication) so the calling hook never waits on it.
func spawnClearNotification(_ sid: String) {
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: ProcessInfo.processInfo.arguments[0])
    proc.arguments = ["clear-notification", sid]
    try? proc.run()
}

/// Drops temp files of sessions whose Claude is gone (pane closed, crash: no SessionEnd ran).
/// Files from older builds carry no PID; those go once they're a day old.
func sweepTempFiles() {
    let fm = FileManager.default
    guard let files = try? fm.contentsOfDirectory(atPath: "/tmp") else { return }
    let dayAgo = Date().addingTimeInterval(-86_400)
    for file in files where file.hasPrefix("claude-timer-") && file.hasSuffix(".txt") {
        let sid = String(file.dropFirst("claude-timer-".count).dropLast(".txt".count))
        let timer = timerRead(sid) ?? []
        let stale: Bool
        if timer.count > 7, let pid = Int32(timer[7]), pid > 0 {
            stale = !isSessionAlive(pid)
        } else {
            let mtime = (try? fm.attributesOfItem(atPath: timerPath(sid)))?[.modificationDate] as? Date
            stale = (mtime ?? .distantPast) < dayAgo
        }
        if stale {
            timerDelete(sid)
            notifierPidDelete(sid)
        }
    }
    for file in files where file.hasPrefix("claude-notifier-") && file.hasSuffix(".txt") {
        let path = "/tmp/\(file)"
        let pid = Int32((try? String(contentsOfFile: path, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? "") ?? 0
        if pid <= 0 || kill(pid, 0) != 0 { try? fm.removeItem(atPath: path) }
    }
}

/// Identifies the Ghostty pane on `tty` by its terminal id.
///
/// Ghostty's AppleScript exposes no tty or pid per terminal, and working directories collide (every
/// pane opened in one repo reports the same one; Claude's own cd's don't change it either), so the
/// pane is asked to name itself: an OSC 2 title carrying a nonce goes to Claude's tty, and the
/// terminal whose title is the nonce is ours. Its id is a UUID that lives as long as the pane,
/// wherever the pane moves — window and tab ids don't survive a tab being dragged to another window.
/// Claude retitles itself while working (the spinner), which can overwrite the nonce before Ghostty
/// is asked, hence the retries. The old title is written back afterwards.
/// Returns "" when Ghostty never shows the nonce (a `title` set in Ghostty's config pins it; inside
/// tmux the OSC goes to tmux) — focus then falls back to a working-directory match.
func captureGhosttyId(tty: String) -> String {
    guard !tty.isEmpty else { return "" }
    let titles = osascript("""
        tell application "Ghostty"
            set out to ""
            repeat with t in terminals
                set out to out & (id of t) & "\t" & (name of t) & linefeed
            end repeat
            return out
        end tell
        """)
    let nonce = "cc-notifications-\(UUID().uuidString)"
    var found = ""
    for _ in 0..<5 {
        writeTty(tty, "\u{1b}]2;\(nonce)\u{07}")
        usleep(30_000)
        found = osascript("""
            tell application "Ghostty"
                try
                    return id of (first terminal whose name is "\(nonce)")
                end try
                return ""
            end tell
            """)
        if !found.isEmpty { break }
    }
    guard !found.isEmpty else { return "" }
    let old = titles.components(separatedBy: "\n")
        .first { $0.hasPrefix(found + "\t") }
        .map { String($0.dropFirst(found.count + 1)) } ?? ""
    // Control characters would end the OSC early or start another sequence.
    let clean = String(old.unicodeScalars.filter { $0.value >= 0x20 && $0.value != 0x7f })
    if !clean.isEmpty { writeTty(tty, "\u{1b}]2;\(clean)\u{07}") }
    return found
}

/// Captures terminal identifiers for pane-level focus restoration.
/// Returns the terminal id for Ghostty, session ID for iTerm2, pane ID for WezTerm.
func captureTerminalId(_ terminal: String, tty: String) -> String {
    switch terminal.lowercased() {
    case "ghostty":
        return captureGhosttyId(tty: tty)
    case "iterm", "iterm2":
        return osascript("""
            tell application "iTerm2" to return id of current session of current tab of current window
            """)
    case "wezterm":
        // $WEZTERM_PANE is set by WezTerm in each pane's environment
        return ProcessInfo.processInfo.environment["WEZTERM_PANE"] ?? ""
    case "terminal":
        // Terminal.app doesn't have split panes — tty is sufficient
        return ""
    default:
        return ""
    }
}

// MARK: - Native notifications (UNUserNotificationCenter)

class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    var onResponse: ((UNNotificationResponse) -> Void)?

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler handler: @escaping () -> Void) {
        onResponse?(response)
        handler()
    }

    // Show banner even when our process is considered "foreground"
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler handler: @escaping (UNNotificationPresentationOptions) -> Void) {
        handler([.banner, .sound, .badge])
    }
}

/// Stops NSApplication.run(). The dummy event makes the run loop notice immediately.
func stopApp() {
    let app = NSApplication.shared
    app.stop(nil)
    let event = NSEvent.otherEvent(with: .applicationDefined, location: .zero,
                                   modifierFlags: [], timestamp: 0, windowNumber: 0,
                                   context: nil, subtype: 0, data1: 0, data2: 0)
    if let event = event { app.postEvent(event, atStart: true) }
}

/// Acts on a notification response using the session state the notification itself carries
/// (userInfo), not the state of whichever process receives it: with several sessions' notifiers
/// alive, the click can reach any instance of the app, and once the poster has exited macOS
/// relaunches the bundle to deliver it.
func handleResponse(_ response: UNNotificationResponse) {
    let info = response.notification.request.content.userInfo
    func s(_ key: String) -> String { info[key] as? String ?? "" }
    switch response.actionIdentifier {
    case UNNotificationDefaultActionIdentifier:
        // Session gone (pane closed, Claude killed): there is no pane to focus, and any match by
        // working directory would land on some other session's pane.
        guard isSessionAlive(Int32(s("pid")) ?? 0) else { return }
        focusTerminal(terminal: s("terminal"), cwd: s("cwd"), tty: s("tty"), terminalId: s("terminalId"))
    case "OPEN_EDITOR":
        openEditor(editor: s("editor"), cwd: s("editorCwd"))
    default:
        break // Dismissed
    }
}

/// Removes delivered notifications whose session's Claude is gone. Ones from older builds carry no
/// PID and are left alone.
func sweepDeliveredNotifications(_ center: UNUserNotificationCenter) {
    let sem = DispatchSemaphore(value: 0)
    center.getDeliveredNotifications { list in
        let dead = list.filter {
            guard let pid = Int32($0.request.content.userInfo["pid"] as? String ?? "") else { return false }
            return !isSessionAlive(pid)
        }.map { $0.request.identifier }
        if !dead.isEmpty { center.removeDeliveredNotifications(withIdentifiers: dead) }
        sem.signal()
    }
    _ = sem.wait(timeout: .now() + 5)
}

/// Posts a native macOS notification with an action button.
/// Click notification body = focus terminal, action button = open editor; both act on `userInfo`.
/// Blocks until this notification is acted on or gone, the session's Claude (`claudePid`) exits,
/// or this process is killed.
/// Returns true if the notification was posted successfully.
func showNativeNotification(title: String, subtitle: String, body: String, groupId: String,
                            editorButtonTitle: String, iconPath: String?,
                            soundName: String?, userInfo: [String: String],
                            claudePid: Int32) -> Bool {
    // NSApplication is required for UNUserNotificationCenter delegate callbacks.
    // Without it, the notification posts but click handlers never fire.
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory) // No Dock icon, no menu bar

    let center = UNUserNotificationCenter.current()
    let delegate = NotificationDelegate()
    delegate.onResponse = { response in
        handleResponse(response)
        // Another session's notification (see handleResponse): ours is still up, keep waiting.
        if response.notification.request.identifier == groupId { stopApp() }
    }
    center.delegate = delegate

    // Register action category — single button for editor, click body for focus
    let editorAction = UNNotificationAction(
        identifier: "OPEN_EDITOR", title: editorButtonTitle, options: .foreground)
    let category = UNNotificationCategory(
        identifier: "CC_HOOKS", actions: [editorAction],
        intentIdentifiers: [], options: .customDismissAction)
    center.setNotificationCategories([category])

    // Request authorization (shows system prompt on first run)
    var authorized = false
    let authSem = DispatchSemaphore(value: 0)
    DispatchQueue.global().async {
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if !granted { fputs("notifications: not authorized \(error.map { "\($0)" } ?? "")\n", stderr) }
            authorized = granted
            authSem.signal()
        }
    }
    authSem.wait()
    guard authorized else { return false }

    // Replace previous notification for this session; drop those of sessions that are gone
    center.removeDeliveredNotifications(withIdentifiers: [groupId])
    center.removePendingNotificationRequests(withIdentifiers: [groupId])
    sweepDeliveredNotifications(center)

    // Build notification content
    let content = UNMutableNotificationContent()
    content.title = title
    content.subtitle = subtitle
    content.body = body
    content.categoryIdentifier = "CC_HOOKS"
    content.threadIdentifier = groupId
    content.userInfo = userInfo
    if let soundName = soundName {
        if soundName.isEmpty {
            content.sound = nil
        } else if soundName == "default" {
            content.sound = .default
        } else {
            content.sound = UNNotificationSound(named: UNNotificationSoundName(soundName))
        }
    } else {
        content.sound = .default
    }

    // Attach custom icon if available
    // UNNotificationAttachment moves the file, so copy to a temp location first
    if let iconPath = iconPath, FileManager.default.fileExists(atPath: iconPath) {
        let ext = (iconPath as NSString).pathExtension
        let tmpIcon = NSTemporaryDirectory() + "claude-icon-\(UUID().uuidString).\(ext)"
        if (try? FileManager.default.copyItem(atPath: iconPath, toPath: tmpIcon)) != nil,
           let attachment = try? UNNotificationAttachment(
            identifier: "icon", url: URL(fileURLWithPath: tmpIcon)) {
            content.attachments = [attachment]
        }
    }

    // Post notification
    let request = UNNotificationRequest(identifier: groupId, content: content, trigger: nil)
    var postOk = true
    let postSem = DispatchSemaphore(value: 0)
    DispatchQueue.global().async {
        center.add(request) { error in
            if let error = error {
                fputs("notifications: post failed: \(error)\n", stderr)
                postOk = false
            }
            postSem.signal()
        }
    }
    postSem.wait()
    guard postOk else { return false }

    // The session ending without SessionEnd (pane closed, crash, kill) would otherwise leave this
    // process waiting and its notification pointing at a pane that no longer exists.
    let sessionWatch: DispatchSourceProcess? = claudePid > 0
        ? DispatchSource.makeProcessSource(identifier: pid_t(claudePid), eventMask: .exit, queue: .main)
        : nil
    sessionWatch?.setEventHandler {
        center.removeDeliveredNotifications(withIdentifiers: [groupId])
        stopApp()
    }
    sessionWatch?.resume()
    // Exited before the watch was armed: kqueue never reports it.
    if !isSessionAlive(claudePid) {
        center.removeDeliveredNotifications(withIdentifiers: [groupId])
        return true
    }

    // Dismissed from Notification Center (no response is delivered for that), or clicked and
    // handled by another instance: nothing left to wait for.
    let gone = Timer(timeInterval: 30, repeats: true) { _ in
        center.getDeliveredNotifications { list in
            guard !list.contains(where: { $0.request.identifier == groupId }) else { return }
            DispatchQueue.main.async { stopApp() }
        }
    }
    RunLoop.main.add(gone, forMode: .common)

    // Block on NSApplication run loop — callbacks fire here
    withExtendedLifetime((delegate, sessionWatch)) { app.run() }
    gone.invalidate()
    sessionWatch?.cancel()

    return true
}

// MARK: - on-submit

func onSubmit(baseDir: String) -> Int32 {
    guard let json = readStdin(),
          let sid = json["session_id"] as? String
    else { return 1 }

    let config = loadConfig(baseDir: baseDir)
    let terminal = config.terminal ?? "ghostty"

    let inTerminal = isRunningInTerminal(terminal)

    let jsonCwd = json["cwd"] as? String ?? FileManager.default.currentDirectoryPath

    // Extract project root from transcript_path:
    // ~/.claude/projects/-Users-abaldwin-Repos-cc-hooks/session.jsonl
    // The directory name after "projects/" encodes / as - but directory names
    // can also contain dashes, so we greedily resolve against the filesystem.
    let transcriptPath = json["transcript_path"] as? String ?? ""
    let projectRoot: String = {
        let parts = transcriptPath.components(separatedBy: "/projects/")
        guard parts.count > 1 else { return jsonCwd }
        let encoded = parts[1].components(separatedBy: "/").first ?? ""
        guard !encoded.isEmpty, encoded.hasPrefix("-") else { return jsonCwd }

        // Greedily decode: try longest possible path segments first
        let segments = encoded.dropFirst().components(separatedBy: "-")
        var path = "/"
        var i = 0
        while i < segments.count {
            // Try joining successive segments with "-" to handle dashes in names
            var best = ""
            for j in stride(from: segments.count - 1, through: i, by: -1) {
                let candidate = segments[i...j].joined(separator: "-")
                let testPath = (path as NSString).appendingPathComponent(candidate)
                if FileManager.default.fileExists(atPath: testPath) {
                    best = candidate
                    i = j + 1
                    break
                }
            }
            if best.isEmpty {
                // No match — use single segment
                best = segments[i]
                i += 1
            }
            path = (path as NSString).appendingPathComponent(best)
        }
        return FileManager.default.fileExists(atPath: path) ? path : jsonCwd
    }()

    // CWD relative to project root for display, project root for editor
    let cwd = jsonCwd
    // Skip if running inside an IDE (not a known terminal emulator)
    if !inTerminal { return 0 }
    let ts = nowMs()
    let editor = config.editor ?? "zed"
    let tty = findTty()
    let claudePid = findClaudePid()

    // A pty belongs to one pane for its whole life, so the same Claude on the same tty is still in
    // the pane captured last time — skip re-capturing (for Ghostty that's a title flicker per prompt).
    let terminalId: String = {
        if let prev = timerRead(sid), prev.count > 7, prev[2] == terminal, prev[4] == tty,
           prev[7] == "\(claudePid)", !prev[5].isEmpty, !prev[5].contains("::") {
            return prev[5]
        }
        return captureTerminalId(terminal, tty: tty)
    }()

    // Clear any displayed notification for this session — user is actively engaged.
    spawnClearNotification(sid)

    // Format: timestamp|cwd|terminal|editor|tty|terminalId|projectRoot|claudePid
    timerWrite(sid, "\(ts)|\(cwd)|\(terminal)|\(editor)|\(tty)|\(terminalId)|\(projectRoot)|\(claudePid)")

    sweepTempFiles()
    return 0
}

// MARK: - notify (async: true — blocks until notification click/dismiss)

func notify(hookEvent: String, baseDir: String) -> Int32 {
    guard let json = readStdin(),
          let sid = json["session_id"] as? String
    else { return 1 }

    let jsonCwd = json["cwd"] as? String
    let notificationType = json["notification_type"] as? String ?? ""

    // Skip auth_success — redundant, user just authenticated
    if notificationType == "auth_success" { return 0 }

    guard let timer = timerRead(sid), timer.count >= 4
    else { return 0 }

    let startMs = UInt64(timer[0]) ?? 0
    let timerCwd = timer[1]
    let terminal = timer[2]
    let editor = timer[3]
    let tty = timer.count > 4 ? timer[4] : ""
    let terminalId = timer.count > 5 ? timer[5] : ""
    let projectRoot = timer.count > 6 ? timer[6] : ""
    let claudePid = timer.count > 7 ? Int32(timer[7]) ?? 0 : 0

    // Use jsonCwd for title (shows where Claude is NOW), timer CWD for focus
    let displayCwd = jsonCwd ?? timerCwd
    let focusCwd = timerCwd.isEmpty ? (jsonCwd ?? "") : timerCwd

    // Title: show relative path from project root, e.g. "cc-hooks/macos/notifications"
    let dir: String = {
        if !projectRoot.isEmpty && displayCwd.hasPrefix(projectRoot) {
            let rootName = (projectRoot as NSString).lastPathComponent
            let relative = String(displayCwd.dropFirst(projectRoot.count))
            if relative.isEmpty || relative == "/" {
                return rootName
            }
            let trimmed = relative.hasPrefix("/") ? String(relative.dropFirst()) : relative
            return "\(rootName)/\(trimmed)"
        }
        return (displayCwd as NSString).lastPathComponent
    }()
    // Editor always opens at project root
    let editorCwd = projectRoot.isEmpty ? focusCwd : projectRoot

    let config = loadConfig(baseDir: baseDir)
    let elapsed = formatElapsed(nowMs() - startMs)
    let session = sessionLabel(sid: sid, transcriptPath: json["transcript_path"] as? String ?? "")

    let message: String
    if hookEvent == "stop" {
        message = config.messages?.stop ?? "Task completed"
    } else {
        switch notificationType {
        case "permission_prompt":
            message = config.messages?.permission ?? "Claude needs permission"
        case "elicitation_dialog":
            message = config.messages?.elicitation ?? "Action required"
        case "idle_prompt":
            message = config.messages?.idle ?? "Claude is waiting"
        default:
            message = config.messages?.notification ?? "Claude needs your input"
        }
    }

    // Kill previous notification process for this session
    killPreviousNotifier(sid)

    // Icon: per-type from config, falls back to notification icon
    let iconFile: String? = {
        if hookEvent == "stop" { return config.icons?.stop }
        switch notificationType {
        case "permission_prompt": return config.icons?.permission ?? config.icons?.notification
        case "elicitation_dialog": return config.icons?.elicitation ?? config.icons?.notification
        case "idle_prompt": return config.icons?.idle ?? config.icons?.notification
        default: return config.icons?.notification
        }
    }()
    let iconPath = iconFile.map { (baseDir as NSString).appendingPathComponent($0) } ?? ""

    let groupId = "claude-\(sid)"
    let editorButton = "Open in \(editorAppName(editor))"
    let body = "\(message) \(elapsed)"

    // Send webhook after notification (only when AFK, or always if idle_minutes == 0)
    // auth_success is already skipped above
    let elapsedSecs = (nowMs() - startMs) / 1000
    if let webhook = config.webhook, webhook.enabled ?? true,
       let webhookUrl = webhook.url, !webhookUrl.isEmpty,
       let payloadFile = webhook.payload, !payloadFile.isEmpty {
        let idleMinutes = webhook.idle_minutes ?? 15
        let send = idleMinutes == 0
            || (elapsedSecs >= UInt64(idleMinutes) * 60 && isAFK(idleMinutes: idleMinutes))
        if send {
            let templatePath = (baseDir as NSString).appendingPathComponent(payloadFile)
            let vars: [String: String] = [
                "title": config.title ?? dir,
                "message": message,
                "elapsed": elapsed,
                "project": dir,
                "event": hookEvent,
                "notification_type": notificationType,
                "session": session,
            ]
            DispatchQueue.global().async {
                sendWebhook(url: webhookUrl, templatePath: templatePath, vars: vars)
            }
        }
    }

    // Skip desktop notification if disabled
    if config.desktop == false {
        notifierPidDelete(sid)
        return 0
    }

    // Save our PID so next notification can kill this process
    try? "\(ProcessInfo.processInfo.processIdentifier)".write(
        toFile: notifierPidPath(sid), atomically: true, encoding: .utf8)

    // Try native macOS notification first
    // Click body = focus terminal, action button = open editor
    let nativeOk = showNativeNotification(
        title: dir, subtitle: session, body: body, groupId: groupId,
        editorButtonTitle: editorButton,
        iconPath: FileManager.default.fileExists(atPath: iconPath) ? iconPath : nil,
        soundName: config.sound,
        userInfo: [
            "sid": sid, "pid": "\(claudePid)", "terminal": terminal, "cwd": focusCwd, "tty": tty,
            "terminalId": terminalId, "editor": editor, "editorCwd": editorCwd,
        ],
        claudePid: claudePid
    )

    if !nativeOk {
        // Fallback: terminal-notifier
        let hasTerminalNotifier = !shell("which terminal-notifier").isEmpty

        if hasTerminalNotifier {
            let senderBundleId: String
            switch terminal.lowercased() {
            case "ghostty": senderBundleId = "com.mitchellh.ghostty"
            case "iterm", "iterm2": senderBundleId = "com.googlecode.iterm2"
            case "terminal": senderBundleId = "com.apple.Terminal"
            default: senderBundleId = "com.mitchellh.ghostty"
            }

            var args = [
                "-title", dir,
                "-subtitle", session,
                "-message", body,
                "-group", groupId,
                "-sender", senderBundleId,
                "-actions", editorButton,
            ]

            if FileManager.default.fileExists(atPath: iconPath) {
                args += ["-appIcon", iconPath]
            }

            let process = Process()
            let pipe = Pipe()
            process.executableURL = URL(fileURLWithPath: shell("which terminal-notifier"))
            process.arguments = args
            process.standardOutput = pipe
            try? process.run()

            // Update PID to terminal-notifier's PID
            try? "\(process.processIdentifier)".write(
                toFile: notifierPidPath(sid), atomically: true, encoding: .utf8)

            process.waitUntilExit()

            let result = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

            switch result {
            case "@CONTENTCLICKED":
                guard isSessionAlive(claudePid) else { break }
                focusTerminal(terminal: terminal, cwd: focusCwd, tty: tty, terminalId: terminalId)
            case let action where action.hasPrefix("Open in"):
                openEditor(editor: editor, cwd: editorCwd)
            default:
                break
            }
        } else {
            // Last resort: osascript (no click actions)
            let eMsg = escapeAppleScript("\(message) \(elapsed)")
            let eDir = escapeAppleScript(dir)
            shell("osascript -e 'display notification \"\(eMsg)\" with title \"\(eDir)\"'")
        }
    }

    notifierPidDelete(sid)
    return 0
}

// MARK: - focus (called directly or after notification click)
//
// Uses terminal-specific AppleScript to find and focus the exact tab/pane.
// Primary match: session ID captured during on-submit.
// Fallback: tty (iTerm2, Terminal.app) or working directory (Ghostty).

/// Bundle ids of the terminals we focus, for handing activation over to them.
func terminalBundleId(_ terminal: String) -> String? {
    switch terminal.lowercased() {
    case "ghostty": return "com.mitchellh.ghostty"
    case "iterm", "iterm2": return "com.googlecode.iterm2"
    case "terminal": return "com.apple.Terminal"
    case "wezterm": return "com.github.wez.wezterm"
    default: return nil
    }
}

func focusTerminal(terminal: String, cwd: String, tty: String, terminalId: String) {
    let eCwd = escapeAppleScript(cwd)
    let eTty = escapeAppleScript(tty)
    let eTermId = escapeAppleScript(terminalId)

    // macOS 14+ activation is cooperative: an app activating itself (which is what the terminal does
    // on `activate`) is refused unless the active app yields to it. A notification click makes us the
    // active app, so yield — otherwise the terminal can come up behind the current app, or not switch
    // to the fullscreen Space / Stage Manager stage that holds the pane.
    if #available(macOS 14.0, *), let bundleId = terminalBundleId(terminal) {
        NSApplication.shared.yieldActivation(toApplicationWithBundleIdentifier: bundleId)
    }

    switch terminal.lowercased() {
    case "ghostty":
        // terminalId: the pane's terminal id (captureGhosttyId). State from older builds holds
        // "termId::tabId::windowId"; only the terminal id is used — window and tab ids change when a
        // tab is dragged to another window, which sent clicks to the wrong place.
        // Order matters for fullscreen Spaces and Stage Manager: make the pane's window key FIRST
        // (`activate window` deminiaturizes and orders it front), then activate the app, so macOS
        // switches to the Space/stage of that window rather than of whichever Ghostty window was
        // last active. System Events can't see Ghostty windows (GPU/Metal rendering), so this all
        // goes through Ghostty's own dictionary.
        let termId = escapeAppleScript(terminalId.components(separatedBy: "::")[0])
        osascript("""
            tell application "Ghostty"
                if "\(termId)" is not "" then
                    repeat with w in windows
                        repeat with tb in tabs of w
                            repeat with t in terminals of tb
                                if (id of t) is "\(termId)" then
                                    activate window w
                                    try
                                        select tab tb
                                    end try
                                    focus t
                                    activate
                                    return
                                end if
                            end repeat
                        end repeat
                    end repeat
                    -- The pane is gone. Don't guess another one.
                    activate
                    return
                end if
                -- No terminal id captured (Ghostty ignoring OSC titles, tmux): working directory,
                -- only when exactly one pane has it — several panes in one repo is the norm.
                set hitW to missing value
                set hitT to missing value
                set n to 0
                if "\(eCwd)" is not "" then
                    repeat with w in windows
                        repeat with tb in tabs of w
                            repeat with t in terminals of tb
                                if (working directory of t) is "\(eCwd)" then
                                    set n to n + 1
                                    set hitW to contents of w
                                    set hitT to contents of t
                                end if
                            end repeat
                        end repeat
                    end repeat
                end if
                if n is 1 then
                    activate window hitW
                    focus hitT
                end if
                activate
            end tell
            """)
    case "iterm", "iterm2":
        osascript("""
            tell application "iTerm2" to activate
            tell application "iTerm2"
                -- Pass 1: session ID match
                if "\(eTermId)" is not "" then
                    repeat with w in windows
                        repeat with tb in tabs of w
                            repeat with sess in sessions of tb
                                if id of sess is "\(eTermId)" then
                                    set index of w to 1
                                    select tb
                                    select sess
                                    return
                                end if
                            end repeat
                        end repeat
                    end repeat
                end if
                -- Pass 2: CWD + "Claude" in name
                repeat with w in windows
                    repeat with tb in tabs of w
                        repeat with sess in sessions of tb
                            set sessDir to variable named "path" in sess
                            if name of sess contains "Claude" and sessDir is "\(eCwd)" then
                                set index of w to 1
                                select tb
                                select sess
                                return
                            end if
                        end repeat
                    end repeat
                end repeat
                -- Pass 3: prefix CWD match
                repeat with w in windows
                    repeat with tb in tabs of w
                        repeat with sess in sessions of tb
                            set sessDir to variable named "path" in sess
                            if ("\(eCwd)" starts with sessDir or sessDir starts with "\(eCwd)") then
                                set index of w to 1
                                select tb
                                select sess
                                return
                            end if
                        end repeat
                    end repeat
                end repeat
            end tell
            """)

    case "terminal":
        osascript("""
            tell application "Terminal" to activate
            tell application "Terminal"
                -- Pass 1: tty match
                if "\(eTty)" is not "" then
                    repeat with w in windows
                        repeat with tb in tabs of w
                            if tty of tb is "\(eTty)" then
                                set selected tab of w to tb
                                set index of w to 1
                                return
                            end if
                        end repeat
                    end repeat
                end if
                -- Pass 2: Claude process match
                repeat with w in windows
                    repeat with tb in tabs of w
                        if custom title of tb contains "Claude" or processes of tb contains "claude" then
                            set selected tab of w to tb
                            set index of w to 1
                            return
                        end if
                    end repeat
                end repeat
            end tell
            """)

    case "wezterm":
        if !terminalId.isEmpty {
            let sTermId = escapeForShellSingleQuote(terminalId)
            shell("wezterm cli activate-pane --pane-id '\(sTermId)'")
        }
        osascript("tell application \"WezTerm\" to activate")

    default:
        let appName = terminalAppName(terminal)
        osascript("tell application \"\(appName)\" to activate")
    }
}

func openEditor(editor: String, cwd: String) {
    let appName = editorAppName(editor)
    let sCwd = escapeForShellSingleQuote(cwd)
    let sApp = escapeForShellSingleQuote(appName)
    let eApp = escapeAppleScript(appName)
    // Use the project directory basename to find the matching window title.
    // Editors typically show the project folder name in the window title.
    // AXRaise + set frontmost brings only that window to front, even from Stage Manager.
    // Returns "raised" if successful so we can skip the open command.
    let dirName = escapeAppleScript((cwd as NSString).lastPathComponent)
    let raised = osascript("""
        tell application "System Events"
            set appProc to first process whose name is "\(eApp)"
            repeat with w in windows of appProc
                if name of w contains "\(dirName)" then
                    perform action "AXRaise" of w
                    return "raised"
                end if
            end repeat
        end tell
        """)
    if raised == "raised" { return }
    switch editor.lowercased() {
    case "zed":
        shell("open -a '\(sApp)' '\(sCwd)'")
    case "code", "vscode":
        shell("code '\(sCwd)'")
    case "cursor":
        shell("cursor '\(sCwd)'")
    default:
        shell("open -a '\(sApp)' '\(sCwd)'")
    }
}

// MARK: - on-end

func onEnd() -> Int32 {
    guard let json = readStdin(),
          let sid = json["session_id"] as? String
    else { return 1 }

    killPreviousNotifier(sid)
    // The killed notifier can't take its notification with it; a click on it would relaunch the
    // app for a session that no longer exists.
    spawnClearNotification(sid)
    timerDelete(sid)
    notifierPidDelete(sid)
    return 0
}

// MARK: - Launched by a notification click

/// LaunchServices launched the bundle (no subcommand): a notification was clicked after the process
/// that posted it exited. The response arrives through the delegate once the app finishes launching.
func onLaunch() -> Int32 {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let center = UNUserNotificationCenter.current()
    let delegate = NotificationDelegate()
    delegate.onResponse = { response in
        handleResponse(response)
        stopApp()
    }
    center.delegate = delegate
    sweepDeliveredNotifications(center)
    // Opened some other way (Finder, `open`): no response is coming.
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { stopApp() }
    withExtendedLifetime(delegate) { app.run() }
    return 0
}

// MARK: - Install / Uninstall

func settingsPath() -> String {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    return (home as NSString).appendingPathComponent(".claude/settings.json")
}

func installHooks(exePath: String) -> Int32 {
    let path = settingsPath()
    let dir = (path as NSString).deletingLastPathComponent
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)

    var settings: [String: Any] = [:]
    if let data = FileManager.default.contents(atPath: path),
       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
        settings = json
    }

    // Notification and Stop hooks are async because the notification handler
    // blocks until the user clicks/dismisses.
    let quotedExe = "'\(escapeForShellSingleQuote(exePath))'"
    let hookEntries: [(String, String, Bool)] = [
        ("UserPromptSubmit", "\(quotedExe) on-submit", false),
        ("Notification", "\(quotedExe) notify notification", true),
        ("Stop", "\(quotedExe) notify stop", true),
        ("SessionEnd", "\(quotedExe) on-end", false),
    ]

    var hooks = settings["hooks"] as? [String: Any] ?? [:]
    for (event, command, isAsync) in hookEntries {
        var hookDef: [String: Any] = ["type": "command", "command": command]
        if isAsync { hookDef["async"] = true }
        hooks[event] = [["matcher": "", "hooks": [hookDef]]]
    }
    settings["hooks"] = hooks

    guard let data = try? JSONSerialization.data(
        withJSONObject: settings, options: [.prettyPrinted, .sortedKeys]),
          let json = String(data: data, encoding: .utf8)
    else { return 1 }

    try? json.write(toFile: path, atomically: true, encoding: .utf8)
    print("Updated \(path)")

    print("Note: Notifications use native macOS APIs. On first run, you may need")
    print("to grant notification permissions when prompted.")
    print("Optional: `brew install terminal-notifier` as a fallback.")

    return 0
}

func uninstallHooks() -> Int32 {
    // Clean temp files
    let fm = FileManager.default
    if let files = try? fm.contentsOfDirectory(atPath: "/tmp") {
        for file in files where file.hasPrefix("claude-timer-") || file.hasPrefix("claude-notifier-") {
            try? fm.removeItem(atPath: "/tmp/\(file)")
        }
    }

    // Remove hooks from settings.json
    let path = settingsPath()
    guard let data = fm.contents(atPath: path),
          var settings = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          var hooks = settings["hooks"] as? [String: Any]
    else {
        print("Uninstalled")
        return 0
    }

    for event in ["UserPromptSubmit", "Notification", "Stop", "SessionEnd"] {
        guard let entries = hooks[event] as? [[String: Any]] else { continue }
        let filtered = entries.filter { entry in
            guard let hookList = entry["hooks"] as? [[String: Any]] else { return true }
            return !hookList.contains { ($0["command"] as? String ?? "").contains("notifications") }
        }
        if filtered.isEmpty { hooks.removeValue(forKey: event) }
        else { hooks[event] = filtered }
    }

    if hooks.isEmpty { settings.removeValue(forKey: "hooks") }
    else { settings["hooks"] = hooks }

    if let data = try? JSONSerialization.data(
        withJSONObject: settings, options: [.prettyPrinted, .sortedKeys]),
       let json = String(data: data, encoding: .utf8) {
        try? json.write(toFile: path, atomically: true, encoding: .utf8)
    }

    print("Uninstalled")
    return 0
}

// MARK: - Entry point

let args = CommandLine.arguments
// LaunchServices passes no subcommand (older macOS: a -psn_ process serial number).
if args.count < 2 || args[1].hasPrefix("-psn") {
    exit(onLaunch())
}

// baseDir = where config.json lives; icons/ and webhook templates resolve against it.
//
// 1. The user config dir: $CLAUDE_CONFIG_DIR/notifications if Claude Code's CLAUDE_CONFIG_DIR is
//    set, else ~/.claude/notifications. It sits OUTSIDE the plugin data dir on purpose:
//    `claude plugin uninstall` deletes ${CLAUDE_PLUGIN_DATA}, and the user's config and icons must
//    survive that. setup.sh seeds/migrates it.
// 2. Walk up from the binary. At each level <dir>/config.json (legacy layouts: bin/, .build/, or a
//    pre-1.1 data dir that still holds config.json), and on passing a `plugins` dir,
//    <its parent>/notifications/config.json — the user config dir for a bundle staged at
//    <config dir>/plugins/data/<id>/<Title>.app, for a process that didn't inherit
//    CLAUDE_CONFIG_DIR (the Windows protocol handlers are the case that motivated it; kept
//    symmetric here).
// 3. Nothing found: the binary's own dir (every field has a default).
let exePath = (args[0] as NSString).resolvingSymlinksInPath
let baseDir: String = {
    let fm = FileManager.default
    func hasConfig(_ dir: String) -> Bool {
        fm.fileExists(atPath: (dir as NSString).appendingPathComponent("config.json"))
    }
    let env = ProcessInfo.processInfo.environment
    let configRoot: String
    if let d = env["CLAUDE_CONFIG_DIR"], !d.isEmpty {
        configRoot = (d as NSString).expandingTildeInPath
    } else {
        configRoot = (fm.homeDirectoryForCurrentUser.path as NSString).appendingPathComponent(".claude")
    }
    let userDir = (configRoot as NSString).appendingPathComponent("notifications")
    if hasConfig(userDir) { return userDir }

    var dir = (exePath as NSString).deletingLastPathComponent
    while !dir.isEmpty && dir != "/" {
        if hasConfig(dir) { return dir }
        let parent = (dir as NSString).deletingLastPathComponent
        if (dir as NSString).lastPathComponent == "plugins" {
            let candidate = (parent as NSString).appendingPathComponent("notifications")
            if hasConfig(candidate) { return candidate }
        }
        dir = parent
    }
    return (exePath as NSString).deletingLastPathComponent
}()

let code: Int32
switch args[1] {
case "on-submit":
    code = onSubmit(baseDir: baseDir)
case "notify":
    let event = args.count > 2 ? args[2] : "notification"
    code = notify(hookEvent: event, baseDir: baseDir)
case "focus":
    // Direct focus by session ID
    if let timer = timerRead(args.count > 2 ? args[2] : ""),
       timer.count >= 4 {
        focusTerminal(
            terminal: timer[2], cwd: timer[1],
            tty: timer.count > 4 ? timer[4] : "",
            terminalId: timer.count > 5 ? timer[5] : "")
    }
    code = 0
case "on-end":
    code = onEnd()
case "clear-notification":
    // Spawned by on-submit to clear displayed notifications without blocking.
    // Needs NSApplication for UNUserNotificationCenter to work.
    let sid = args.count > 2 ? args[2] : ""
    if !sid.isEmpty {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let center = UNUserNotificationCenter.current()
        let groupId = "claude-\(sid)"
        center.removeDeliveredNotifications(withIdentifiers: [groupId])
        center.removePendingNotificationRequests(withIdentifiers: [groupId])
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.1))
    }
    code = 0
case "install":
    code = installHooks(exePath: exePath)
case "uninstall":
    code = uninstallHooks()
default:
    fputs("Unknown: \(args[1])\n", stderr)
    code = 1
}

exit(code)
