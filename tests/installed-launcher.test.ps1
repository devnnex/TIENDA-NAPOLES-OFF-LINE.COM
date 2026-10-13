$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path $env:TEMP ("napoles-launcher-check-" + [guid]::NewGuid().ToString("N"))
$installedDirectory = Join-Path $testRoot "Instalacion con espacios"
New-Item -ItemType Directory -Path $installedDirectory -Force | Out-Null

function Assert($condition, [string]$message) {
  if (-not $condition) { throw $message }
}

# Compila el iniciador real como lo hace el respaldo, sin abrir el navegador real.
$source = [IO.File]::ReadAllText((Join-Path $projectRoot "packaging\TiendaNapolesOffline.cs"))
Add-Type -TypeDefinition $source -ReferencedAssemblies System.Windows.Forms,System.Management
Assert ($null -ne [TiendaNapolesOffline].GetMethod("Launch")) "No existe la entrada del respaldo."
$taskbarType = [TiendaNapolesOffline].Assembly.GetType("TaskbarIdentity")
$command = $taskbarType.GetMethod("RelaunchCommand", [Reflection.BindingFlags]"Static,NonPublic").Invoke($null, @([string]$installedDirectory))
Assert ($command.Contains('"' + (Join-Path $installedDirectory "Iniciar-Tienda-Napoles-Instalada.ps1") + '"')) "El anclaje no conserva la ruta con espacios."
Assert (-not $command.Contains("TiendaNapolesOffline.exe")) "El anclaje depende del ejecutable faltante."
Write-Output "PASS: compilacion real del respaldo y ruta de relanzamiento de la barra."

# Ejecuta el script real con dobles de prueba en sus dos limites externos.
# No inicia procesos, no abre la app ni usa el perfil del navegador.
$scriptPath = Join-Path $installedDirectory "Iniciar-Tienda-Napoles-Instalada.ps1"
Copy-Item -LiteralPath (Join-Path $projectRoot "packaging\Iniciar-Tienda-Napoles-Instalada.ps1") -Destination $scriptPath
Copy-Item -LiteralPath (Join-Path $projectRoot "packaging\TiendaNapolesOffline.cs") -Destination $installedDirectory
Copy-Item -LiteralPath (Join-Path $projectRoot "packaging\build\TiendaNapolesOffline.exe") -Destination $installedDirectory
$script:startedPath = $null
$script:startedDirectory = $null
$script:compiledSource = $null
function Start-Process {
  param([string]$FilePath, [string]$WorkingDirectory, [string]$ErrorAction)
  $script:startedPath = $FilePath
  $script:startedDirectory = $WorkingDirectory
}
function Add-Type {
  param([string]$TypeDefinition, [string[]]$ReferencedAssemblies)
  $script:compiledSource = $TypeDefinition
}

Push-Location $env:WINDIR
try {
  . $scriptPath
  Assert ($script:startedPath -eq (Join-Path $installedDirectory "TiendaNapolesOffline.exe")) "No se abrio el ejecutable instalado."
  Assert ($script:startedDirectory -eq $installedDirectory) "El iniciador uso el directorio de trabajo en vez de la instalacion."
  Assert ($null -eq $script:compiledSource) "Se compilo el respaldo aunque habia ejecutable."
  Write-Output "PASS: usa el ejecutable instalado desde otro directorio de trabajo."
} finally {
  Pop-Location
  Remove-Item Function:\Start-Process
  Remove-Item Function:\Add-Type
}

# El respaldo se prueba en un proceso nuevo, sin exe, con una entrada de prueba
# que registra la carpeta recibida. La compilacion del codigo real se verifico arriba.
$fallbackDirectory = Join-Path $testRoot "Respaldo sin ejecutable"
New-Item -ItemType Directory -Path $fallbackDirectory | Out-Null
Copy-Item -LiteralPath $scriptPath -Destination $fallbackDirectory
$probe = 'public static class TiendaNapolesOffline { public static void Launch(string directory) { System.Console.WriteLine("FALLBACK_DIRECTORY=" + directory); } }'
[IO.File]::WriteAllText((Join-Path $fallbackDirectory "TiendaNapolesOffline.cs"), $probe)
$powershell = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
$result = & $powershell -NoProfile -STA -ExecutionPolicy Bypass -File (Join-Path $fallbackDirectory "Iniciar-Tienda-Napoles-Instalada.ps1")
Assert ($LASTEXITCODE -eq 0) "Fallo la ejecucion del respaldo."
Assert ($result -contains ("FALLBACK_DIRECTORY=" + $fallbackDirectory)) "El respaldo no recibio la carpeta instalada."
Assert (-not (Test-Path -LiteralPath (Join-Path $fallbackDirectory "TiendaNapolesOffline.exe"))) "El respaldo recreo el ejecutable."
Write-Output "PASS: sin exe carga el respaldo y conserva la carpeta instalada sin recrear exe."
Write-Output ("Artefactos de prueba: " + $testRoot)
