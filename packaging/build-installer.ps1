param(
  [string]$InnoCompilerPath = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$buildDirectory = Join-Path $PSScriptRoot "build"
$installerScript = Join-Path $PSScriptRoot "TiendaNapolesOffline.iss"
$launcherSource = Join-Path $PSScriptRoot "TiendaNapolesOffline.cs"
$launcherExe = Join-Path $buildDirectory "TiendaNapolesOffline.exe"
$appIcon = Join-Path $projectRoot "tienda-napoles.ico"
$compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path -LiteralPath $compiler)) {
  $compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe"
}
if (-not (Test-Path -LiteralPath $compiler)) {
  throw "No se encontro el compilador de .NET Framework 4."
}

New-Item -ItemType Directory -Path $buildDirectory -Force | Out-Null
& $compiler /nologo /target:winexe /platform:anycpu /optimize+ /codepage:65001 "/out:$launcherExe" "/win32icon:$appIcon" /reference:System.Windows.Forms.dll /reference:System.Management.dll $launcherSource
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $launcherExe)) {
  throw "No se pudo compilar el iniciador sin consola."
}

if (-not $InnoCompilerPath) {
  $candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"),
    (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe")
  )
  $InnoCompilerPath = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $InnoCompilerPath -or -not (Test-Path -LiteralPath $InnoCompilerPath)) {
  throw "No se encontro ISCC.exe de Inno Setup 6. Indica su ruta con -InnoCompilerPath."
}

Push-Location $PSScriptRoot
try {
  & $InnoCompilerPath $installerScript
  if ($LASTEXITCODE -ne 0) { throw "No se pudo compilar el instalador." }
} finally {
  Pop-Location
}

$installer = Join-Path (Join-Path $projectRoot "dist") "Tienda-Napoles-Offline-Setup-1.0.6.exe"
if (-not (Test-Path -LiteralPath $installer)) { throw "El instalador no aparecio en dist." }
Get-Item -LiteralPath $installer | Select-Object FullName, Length
Get-FileHash -LiteralPath $installer -Algorithm SHA256 | Select-Object Algorithm, Hash
