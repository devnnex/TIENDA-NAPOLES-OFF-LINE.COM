param(
  [string]$DesktopPath = [Environment]::GetFolderPath("Desktop")
)

$ErrorActionPreference = "Stop"

$launcherPath = Join-Path $PSScriptRoot "Iniciar-Tienda-Napoles-Offline.cmd"
$iconPath = Join-Path $PSScriptRoot "tienda-napoles.ico"
if (-not (Test-Path -LiteralPath $launcherPath) -or -not (Test-Path -LiteralPath $iconPath)) {
  exit 1
}

$shortcutName = "Tienda N" + [char]0x00E1 + "poles.lnk"
$shortcutPath = Join-Path $desktopPath $shortcutName
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $launcherPath
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.IconLocation = $iconPath + ",0"
$shortcut.Description = "Abrir Tienda N" + [char]0x00E1 + "poles Offline"
$shortcut.WindowStyle = 7
$shortcut.Save()
