$ErrorActionPreference = "Stop"

try {
  $launcherExe = Join-Path $PSScriptRoot "TiendaNapolesOffline.exe"
  if (Test-Path -LiteralPath $launcherExe -PathType Leaf) {
    try {
      Start-Process -FilePath $launcherExe -WorkingDirectory $PSScriptRoot -ErrorAction Stop | Out-Null
      return
    } catch {
      # Si desaparecio entre la comprobacion y la apertura, usa el respaldo.
      # Otros errores del ejecutable se muestran y no se ocultan.
      if (Test-Path -LiteralPath $launcherExe -PathType Leaf) { throw }
    }
  }

  # Usa el mismo iniciador, sin depender del ejecutable que faltaba en el PC.
  # La carpeta procede del script instalado, nunca de Descargas ni del directorio actual.
  $launcherSource = Join-Path $PSScriptRoot "TiendaNapolesOffline.cs"
  Add-Type -TypeDefinition ([IO.File]::ReadAllText($launcherSource, [Text.Encoding]::UTF8)) `
    -ReferencedAssemblies System.Windows.Forms, System.Management
  [TiendaNapolesOffline]::Launch($PSScriptRoot)
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    "No fue posible iniciar Tienda Napoles. Reinstala la aplicacion con el instalador mas reciente. " + $_.Exception.Message,
    "Tienda Napoles Offline",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  ) | Out-Null
  exit 1
}
