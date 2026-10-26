# notifications — Windows setup (run by the /notifications:setup skill)
#
#   pwsh -NoProfile -File setup.ps1 -Data <CLAUDE_PLUGIN_DATA>             build, stage, register
#   pwsh -NoProfile -File setup.ps1 -Data <CLAUDE_PLUGIN_DATA> -Uninstall  unregister, unstage
#
# Two directories, split by who owns what:
#   <Data>   ${CLAUDE_PLUGIN_DATA} — rebuildable artifacts only: notifications.exe and build\.
#            `claude plugin uninstall` deletes it, so nothing the user wrote may live here.
#   <Config> %CLAUDE_CONFIG_DIR%\notifications, else %USERPROFILE%\.claude\notifications — the
#            user's config.json, icons\ and webhook templates. Never deleted by this script (not
#            even by -Uninstall): plugin uninstall leaves it alone and so do we. The exe looks
#            here first (find_base_dir in main.rs); relative paths in config resolve against it.
#
# What it does (install):
#   1. cargo build --release, into <Data>\build so nothing lands in the per-version plugin root.
#   2. Stage notifications.exe in <Data> (stable across plugin updates — the registry below points
#      at it). Move any user files a pre-1.1 setup left in <Data> (config.json, icons\, webhook
#      templates) into <Config>, then seed <Config>\config.json from config.json.example and copy
#      the webhook templates if they aren't there yet.
#   3. Register the claude-focus:// and claude-editor:// protocol handlers (HKCU) at the staged exe —
#      the toast's "Focus Terminal" / "Open in Editor" buttons go through them.
#   4. Register the AUMID (HKLM, needs elevation → UAC prompt) with the display name + the icon in
#      <Config>\icons. Declining still works — just no icon on toasts.
#
# -Uninstall undoes everything this script put OUTSIDE <Config>: the protocol handlers, the AUMID
# (HKLM + the HKCU fallback), the per-app notification settings key Windows creates the first time
# the AUMID shows a toast, this app's toasts in Action Center, the %TEMP% state files, and the exe
# + build dir. Claude Code runs no hook at plugin uninstall, so this has to run BEFORE
# `/plugin uninstall` — afterwards the registry entries are orphaned (pointing at a deleted exe).
#
# It never touches ~/.claude/settings.json: the hooks come from the plugin's hooks.json (and go
# away with `/plugin uninstall`). This replaces the old `notifications.exe install` step.

param(
    [Parameter(Mandatory = $true)][string]$Data,
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$srcDir = $PSScriptRoot                       # <plugin root>/windows
$exe = Join-Path $Data "notifications.exe"
$aumid = "ClaudeCode.Hooks"
$configRoot = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME ".claude" }
$confDir = Join-Path $configRoot "notifications"
# What <Data> may hold; everything else in it is the user's and belongs in <Config>.
$artifacts = @("notifications.exe", "build")

function Test-Admin {
    ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-Elevated([string]$cmd, [string]$skippedMsg) {
    if (Test-Admin) { Invoke-Expression $cmd; return $true }
    try { Start-Process pwsh -Verb RunAs -ArgumentList "-NoProfile -Command $cmd" -Wait; return $true }
    catch { Write-Host $skippedMsg; return $false }
}

# Only OUR exe: a checkout build or anything else named notifications.exe is none of our business.
# GetFullPath on both sides: -Data may arrive with forward slashes from the skill's shell, while
# Process.Path is always backslashed — a raw compare would miss the watcher that locks the exe.
function Stop-Staged {
    $target = [IO.Path]::GetFullPath($exe)
    Get-Process -Name "notifications" -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and ([IO.Path]::GetFullPath($_.Path) -eq $target) } | Stop-Process -Force
}

# Move a user file/dir from <Data> to <Config> unless <Config> already has it. Directories merge
# entry by entry; an identical duplicate (a re-seeded example template) is just dropped; a real
# conflict is left in place and reported — <Config> wins, and the <Data> copy dies with the data dir.
function Move-UserEntry([string]$src, [string]$dst) {
    if (-not (Test-Path -LiteralPath $dst)) {
        New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
        Move-Item -LiteralPath $src -Destination $dst
        Write-Host "Moved $src -> $dst"
    } elseif ((Test-Path -LiteralPath $src -PathType Container) -and (Test-Path -LiteralPath $dst -PathType Container)) {
        foreach ($child in Get-ChildItem -LiteralPath $src -Force) {
            Move-UserEntry $child.FullName (Join-Path $dst $child.Name)
        }
        if (-not (Get-ChildItem -LiteralPath $src -Force)) { Remove-Item -LiteralPath $src -Force }
    } elseif ((Test-Path -LiteralPath $src -PathType Leaf) -and (Test-Path -LiteralPath $dst -PathType Leaf) -and
              ((Get-FileHash -LiteralPath $src).Hash -eq (Get-FileHash -LiteralPath $dst).Hash)) {
        Remove-Item -LiteralPath $src -Force
    } else {
        Write-Host "Kept $dst; left the data-dir copy $src in place (it is deleted on plugin uninstall — merge it by hand if you need it)"
    }
}

function Move-UserFiles {
    if (-not (Test-Path -LiteralPath $Data)) { return }
    foreach ($item in Get-ChildItem -LiteralPath $Data -Force) {
        if ($artifacts -contains $item.Name) { continue }
        Move-UserEntry $item.FullName (Join-Path $confDir $item.Name)
    }
}

if ($Uninstall) {
    # Rescue config/icons a pre-1.1 setup left in the data dir before plugin uninstall deletes it.
    Move-UserFiles

    # Clear this app's toasts from Action Center while the exe and AUMID still exist. It's a GUI-
    # subsystem exe, so `&` wouldn't wait for it.
    if (Test-Path $exe) {
        try { Start-Process -FilePath $exe -ArgumentList "clear-history" -Wait -WindowStyle Hidden } catch {}
    }
    # The focus watcher (on-submit) may be running — stop it before touching the exe.
    Stop-Staged

    foreach ($proto in @("claude-focus", "claude-editor")) {
        $key = "HKCU:\Software\Classes\$proto"
        if (Test-Path $key) { Remove-Item $key -Recurse -Force; Write-Host "Unregistered ${proto}://" }
    }
    $hkcuKey = "HKCU:\Software\Classes\AppUserModelId\$aumid"
    if (Test-Path $hkcuKey) { Remove-Item $hkcuKey -Recurse -Force; Write-Host "Removed $hkcuKey" }
    # Windows' own per-app notification settings (banner/sound toggles), created on first toast.
    $ncKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\$aumid"
    if (Test-Path $ncKey) { Remove-Item $ncKey -Recurse -Force; Write-Host "Removed $ncKey" }
    # Reading HKLM needs no elevation — only prompt for UAC when there's actually a key to delete.
    $hklmKey = "HKLM:\Software\Classes\AppUserModelId\$aumid"
    if (Test-Path $hklmKey) {
        if (Invoke-Elevated "Remove-Item '$hklmKey' -Recurse -Force" `
                "Skipped HKLM removal (admin declined). Remove manually: HKLM\Software\Classes\AppUserModelId\$aumid") {
            Write-Host "Removed $hklmKey"
        }
    }

    # Per-session state files the hooks leave in %TEMP%.
    Get-ChildItem $env:TEMP -Filter "claude-*" -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^claude-(timer|watcher|focus-trigger)-' } |
        Remove-Item -Force -ErrorAction SilentlyContinue

    if (Test-Path $exe) { Remove-Item $exe -Force; Write-Host "Removed $exe" }
    $build = Join-Path $Data "build"
    if (Test-Path $build) { Remove-Item $build -Recurse -Force; Write-Host "Removed $build" }
    Write-Host "Done. Your config and icons in $confDir are kept on purpose (delete that folder yourself if you don't want them)."
    Write-Host "Now run /plugin uninstall notifications@cc-plugins to remove the hooks and the data dir."
    exit 0
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Host "cargo not found — install Rust from https://rustup.rs/ and re-run."
    exit 1
}

# 1. Build
Write-Host "Building notifications..."
$target = Join-Path $Data "build\notifications"
cargo build --release --manifest-path (Join-Path $srcDir "Cargo.toml") --target-dir $target 2>&1 | Select-Object -Last 3
if ($LASTEXITCODE -ne 0) { Write-Host "Build failed."; exit 1 }

# 2. Stage
New-Item -ItemType Directory -Force -Path $Data | Out-Null
Stop-Staged  # a live watcher locks the exe
Copy-Item (Join-Path $target "release\notifications.exe") $exe -Force
Write-Host "Staged $exe"

# User files: migrate from the data dir (pre-1.1 layout), then seed what's missing (never overwrite).
New-Item -ItemType Directory -Force -Path $confDir, (Join-Path $confDir "icons") | Out-Null
Move-UserFiles
$configPath = Join-Path $confDir "config.json"
if (-not (Test-Path $configPath)) {
    Copy-Item (Join-Path $srcDir "config.json.example") $configPath
    Write-Host "Created $configPath from the example — edit it to set title/editor/webhook"
}
foreach ($tpl in Get-ChildItem $srcDir -Filter "webhook.*.json.example") {
    $dst = Join-Path $confDir $tpl.Name
    if (-not (Test-Path $dst)) { Copy-Item $tpl.FullName $dst }
}

# 3. Protocol handlers (HKCU, no elevation needed) → the staged exe
foreach ($proto in @(
    @{ name = "claude-focus"; cmd = "trigger" },
    @{ name = "claude-editor"; cmd = "editor" }
)) {
    $base = "HKCU:\Software\Classes\$($proto.name)"
    New-Item -Path $base -Force | Out-Null
    Set-ItemProperty -Path $base -Name "(Default)" -Value "URL:$($proto.name) Protocol"
    New-ItemProperty -Path $base -Name "URL Protocol" -Value "" -Force | Out-Null
    New-Item -Path "$base\shell\open\command" -Force | Out-Null
    Set-ItemProperty -Path "$base\shell\open\command" -Name "(Default)" -Value "`"$exe`" $($proto.cmd) `"%1`""
    Write-Host "Registered $($proto.name):// → $exe"
}

# 4. AUMID (HKLM, needs elevation for icon support)
$config = Get-Content $configPath -Raw | ConvertFrom-Json
$title = if ($config -and $config.title) { $config.title } else { "CC Notification" }
$iconFile = if ($config -and $config.icons -and $config.icons.title) { $config.icons.title } else { "icons\title.ico" }
$iconPath = if ([IO.Path]::IsPathRooted($iconFile)) { $iconFile } else { Join-Path $confDir $iconFile }
$aumidKey = "HKLM:\Software\Classes\AppUserModelId\$aumid"
$regCmd = "New-Item -Path '$aumidKey' -Force | Out-Null; " +
    "New-ItemProperty -Path '$aumidKey' -Name 'DisplayName' -Value '$title' -PropertyType ExpandString -Force | Out-Null; " +
    "New-ItemProperty -Path '$aumidKey' -Name 'IconUri' -Value '$iconPath' -PropertyType ExpandString -Force | Out-Null"
if (Invoke-Elevated $regCmd "Registered AUMID without icon (admin declined). Re-run as admin to add the icon.") {
    Write-Host "Registered AUMID: $aumid ($title) [HKLM]"
} else {
    $fallbackKey = "HKCU:\Software\Classes\AppUserModelId\$aumid"
    New-Item -Path $fallbackKey -Force | Out-Null
    New-ItemProperty -Path $fallbackKey -Name "DisplayName" -Value $title -PropertyType ExpandString -Force | Out-Null
}
if (-not (Test-Path $iconPath)) { Write-Host "Note: no icon at $iconPath — drop one there (see config icons.title) for a titled toast." }

Write-Host "Config: $configPath (icons in $(Join-Path $confDir 'icons'))"
Write-Host "Done! Restart Claude Code to activate (the hooks are already registered by the plugin)."
