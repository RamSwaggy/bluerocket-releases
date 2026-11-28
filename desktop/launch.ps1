# =====================================================================
#  Rocket Rumble launcher (Windows). The Desktop shortcut runs this.
#
#  What it does, every time you open the game:
#    1. Pulls the latest version of the game from GitHub (git pull).
#       If you're offline or anything goes wrong, it just skips this
#       and plays the version you already have.
#    2. If the app's own packages changed, re-installs them (rare).
#    3. Starts the game straight from this folder, so updates need no
#       rebuild: the next launch simply has the new files.
#
#  It runs hidden (no black window). To set up the Desktop shortcut,
#  run install-shortcut.ps1 once (see the README).
# =====================================================================
$ErrorActionPreference = "SilentlyContinue"
$desktopDir = $PSScriptRoot                       # ...\bluerocket-releases\desktop
$repoDir    = Split-Path $desktopDir -Parent      # ...\bluerocket-releases
$log        = Join-Path $desktopDir "launch.log"  # last launch's notes, for troubleshooting

"Launch $(Get-Date)" | Out-File $log

# --- 1. Update (quietly; never blocks playing) ---
# --ff-only means "only take new commits, never try to merge anything",
# so it can't make a mess. A 20-second cap stops a slow network from
# holding up the game.
$lockBefore = (Get-FileHash (Join-Path $desktopDir "package-lock.json")).Hash
$pull = Start-Process git -ArgumentList "-C `"$repoDir`" pull --ff-only" -WindowStyle Hidden -PassThru `
          -RedirectStandardOutput "$log.git" -RedirectStandardError "$log.giterr"
if (-not $pull.WaitForExit(20000)) { $pull.Kill(); "git pull timed out; playing current version" | Out-File $log -Append }
Get-Content "$log.git", "$log.giterr" | Out-File $log -Append
Remove-Item "$log.git", "$log.giterr"

# --- 2. Re-install packages only if they changed (or were never installed) ---
$lockAfter = (Get-FileHash (Join-Path $desktopDir "package-lock.json")).Hash
$electron  = Join-Path $desktopDir "node_modules\electron\dist\electron.exe"
if ($lockBefore -ne $lockAfter -or -not (Test-Path $electron)) {
  "Installing packages..." | Out-File $log -Append
  Start-Process npm.cmd -ArgumentList "install --no-audit --no-fund" -WorkingDirectory $desktopDir `
    -WindowStyle Hidden -Wait
}

# --- 3. Play ---
if (Test-Path $electron) {
  Start-Process $electron -ArgumentList "`"$desktopDir`"" -WorkingDirectory $desktopDir
} else {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("Rocket Rumble couldn't start: the app's packages aren't installed.`n`nOpen PowerShell in $desktopDir and run:  npm install", "Rocket Rumble") | Out-Null
}
