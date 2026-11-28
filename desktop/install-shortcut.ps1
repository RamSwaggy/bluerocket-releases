# =====================================================================
#  Run this ONCE to put a "Rocket Rumble" shortcut (with the logo) on
#  your Desktop. The shortcut runs launch.ps1, which updates the game
#  and starts it. Run it with:
#    powershell -ExecutionPolicy Bypass -File install-shortcut.ps1
# =====================================================================
$desktopDir = $PSScriptRoot
$shell      = New-Object -ComObject WScript.Shell
$lnkPath    = Join-Path ([Environment]::GetFolderPath("Desktop")) "Rocket Rumble.lnk"

$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath       = "powershell.exe"
# -WindowStyle Hidden: no black console window. Bypass: allow this one
# script to run without changing your PC's script policy.
$lnk.Arguments        = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$desktopDir\launch.ps1`""
$lnk.WorkingDirectory = $desktopDir
$lnk.IconLocation     = "$desktopDir\build\icon.ico"
$lnk.Description      = "Rocket Rumble (updates itself on launch)"
$lnk.Save()

# The old portable .exe on the Desktop is no longer needed.
Remove-Item (Join-Path ([Environment]::GetFolderPath("Desktop")) "RocketRumble-0.1.0-portable.exe") -ErrorAction SilentlyContinue

Write-Host "Done: 'Rocket Rumble' is on your Desktop. Double-click it to play; it updates itself each time."
