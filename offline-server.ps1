param(
  [int]$Port = 8766
)

$ErrorActionPreference = "Stop"
$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$rootPrefix = $root.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")

function Get-ContentType([string]$path) {
  switch ([System.IO.Path]::GetExtension($path).ToLowerInvariant()) {
    ".html" { return "text/html; charset=utf-8" }
    ".css" { return "text/css; charset=utf-8" }
    ".js" { return "text/javascript; charset=utf-8" }
    ".cjs" { return "text/javascript; charset=utf-8" }
    ".json" { return "application/json; charset=utf-8" }
    ".webmanifest" { return "application/manifest+json; charset=utf-8" }
    ".svg" { return "image/svg+xml" }
    ".png" { return "image/png" }
    ".jpg" { return "image/jpeg" }
    ".jpeg" { return "image/jpeg" }
    ".webp" { return "image/webp" }
    ".mp3" { return "audio/mpeg" }
    default { return "application/octet-stream" }
  }
}

function Send-Text($response, [int]$statusCode, [string]$text) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
  $response.StatusCode = $statusCode
  $response.ContentType = "text/plain; charset=utf-8"
  $response.ContentLength64 = $bytes.Length
  $response.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Send-Json($response, [int]$statusCode, $value) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes(($value | ConvertTo-Json -Compress -Depth 4))
  $response.StatusCode = $statusCode
  $response.ContentType = "application/json; charset=utf-8"
  $response.ContentLength64 = $bytes.Length
  $response.OutputStream.Write($bytes, 0, $bytes.Length)
}

$drawerBridgeLoaded = $false
$loginVaultLoaded = $false
$drawerStatePath = Join-Path $env:LOCALAPPDATA "TiendaNapolesOffline\drawer-controller.json"
function Get-DrawerState {
  if (Test-Path -LiteralPath $drawerStatePath) {
    try { return Get-Content -LiteralPath $drawerStatePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
  }
  $state = @{ deviceId = [guid]::NewGuid().ToString(); secret = ([guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")); settings = $null }
  Save-DrawerState $state
  return $state
}
function Save-DrawerState($state) {
  $directory = Split-Path -Parent $drawerStatePath
  [System.IO.Directory]::CreateDirectory($directory) | Out-Null
  $temporary = $drawerStatePath + ".tmp"
  [System.IO.File]::WriteAllText($temporary, ($state | ConvertTo-Json -Compress -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temporary -Destination $drawerStatePath -Force
}

try {
  $listener.Start()
} catch {
  exit 2
}

try {
  while ($listener.IsListening) {
    $context = $null
    try {
      $context = $listener.GetContext()
      $request = $context.Request
      $response = $context.Response
      $response.Headers["Cache-Control"] = "no-cache"
      $response.KeepAlive = $false

      if ($request.Url.AbsolutePath -eq "/__tienda_napoles_health") {
        Send-Text $response 200 "OK"
        continue
      }

      if ($request.Url.AbsolutePath -eq "/__tienda_napoles_drawer_health") {
        Send-Text $response 200 "OK_DRAWER_V2"
        continue
      }

      if ($request.Url.AbsolutePath -eq "/__tienda_napoles_login_health") {
        Send-Text $response 200 "OK"
        continue
      }

      if ($request.Url.AbsolutePath -eq "/__tienda_napoles_login") {
        if ($request.HttpMethod -ne "POST" -or
            $request.Headers["Origin"] -ne "http://127.0.0.1:$Port" -or
            $request.Headers["X-Tienda-Napoles-Login"] -ne "1" -or
            -not [System.Net.IPAddress]::IsLoopback($request.RemoteEndPoint.Address)) {
          Send-Json $response 403 @{ error = "Solicitud local no autorizada." }
          continue
        }
        if ($request.ContentLength64 -lt 1 -or $request.ContentLength64 -gt 16000) {
          Send-Json $response 400 @{ error = "Credencial local no valida." }
          continue
        }
        try {
          if (-not $loginVaultLoaded) {
            Add-Type -Path (Join-Path $root "offline-login-vault.cs") -ReferencedAssemblies "System.Security.dll" -ErrorAction Stop
            $loginVaultLoaded = $true
          }
          $reader = New-Object System.IO.StreamReader($request.InputStream, [System.Text.Encoding]::UTF8)
          $payload = $reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop
          switch ([string]$payload.action) {
            "enroll" {
              $userJson = $payload.user | ConvertTo-Json -Compress -Depth 8
              [OfflineLoginVault]::Enroll([string]$payload.username, [string]$payload.pin, [string]$payload.token, $userJson)
              Send-Json $response 200 @{ ok = $true }
            }
            "verify" {
              $result = [OfflineLoginVault]::Verify([string]$payload.username, [string]$payload.pin)
              if ($result.Status -eq "ok") {
                Send-Json $response 200 @{ status = "ok"; token = $result.Token; user = ($result.UserJson | ConvertFrom-Json) }
              } else {
                Send-Json $response 200 @{ status = $result.Status }
              }
            }
            "forget" {
              [OfflineLoginVault]::Forget([string]$payload.username)
              Send-Json $response 200 @{ ok = $true }
            }
            default { Send-Json $response 400 @{ error = "Operacion local no valida." } }
          }
        } catch {
          Send-Json $response 503 @{ error = "No se pudo validar el acceso local en este equipo." }
        }
        continue
      }

      if ($request.Url.AbsolutePath -eq "/__tienda_napoles_drawer") {
        $bcaOrigin = $request.Headers["Origin"] -eq "https://devnnex.github.io"
        if ($bcaOrigin -and [System.Net.IPAddress]::IsLoopback($request.RemoteEndPoint.Address)) {
          $response.Headers["Access-Control-Allow-Origin"] = "https://devnnex.github.io"
          $response.Headers["Vary"] = "Origin"
          if ($request.HttpMethod -eq "OPTIONS") {
            $response.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
            $response.Headers["Access-Control-Allow-Headers"] = "Content-Type, X-Tienda-Napoles-Drawer"
            $response.Headers["Access-Control-Allow-Private-Network"] = "true"
            $response.StatusCode = 204
            continue
          }
        }
        $sameOrigin = $request.Headers["Origin"] -eq "http://127.0.0.1:$Port" -or
          ($request.HttpMethod -eq "GET" -and (
            $request.Headers["Sec-Fetch-Site"] -eq "same-origin" -or
            ($request.UrlReferrer -and $request.UrlReferrer.GetLeftPart([System.UriPartial]::Authority) -eq "http://127.0.0.1:$Port")
          ))
        $fromApp = $request.Headers["X-Tienda-Napoles-Drawer"] -eq "1"
        if ((-not $sameOrigin -and -not $bcaOrigin) -or -not $fromApp -or -not [System.Net.IPAddress]::IsLoopback($request.RemoteEndPoint.Address)) {
          Send-Json $response 403 @{ error = "Solicitud local no autorizada." }
          continue
        }
        if ($request.HttpMethod -ne "GET" -and $request.HttpMethod -ne "POST") {
          Send-Json $response 405 @{ error = "Metodo no permitido." }
          continue
        }
        try {
          if (-not $drawerBridgeLoaded) {
            Add-Type -Path (Join-Path $root "cash-drawer-printer.cs") -ReferencedAssemblies "System.Drawing.dll" -ErrorAction Stop
            $drawerBridgeLoaded = $true
          }
          if ($request.HttpMethod -eq "GET") {
            $drawerState = Get-DrawerState
            Send-Json $response 200 @{ printers = @([CashDrawerPrinter]::InstalledPrinters()); settings = $drawerState.settings; deviceId = $drawerState.deviceId; secret = $drawerState.secret }
          } else {
            if ($request.ContentLength64 -lt 1 -or $request.ContentLength64 -gt 1024) {
              Send-Json $response 400 @{ error = "Configuracion de impresora no valida." }
              continue
            }
            $reader = New-Object System.IO.StreamReader($request.InputStream, [System.Text.Encoding]::UTF8)
            $settings = $reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop
            $name = [string]$settings.printer
            $pin = [int]$settings.pin
            if ([string]::IsNullOrWhiteSpace($name) -or $null -eq $settings.pin -or ($pin -ne 0 -and $pin -ne 1)) {
              Send-Json $response 400 @{ error = "Selecciona una impresora y el pin del cajon." }
              continue
            }
            [CashDrawerPrinter]::Open($name, $pin)
            $drawerState = Get-DrawerState
            $drawerState.settings = @{ printer = $name; pin = $pin }
            Save-DrawerState $drawerState
            Send-Json $response 200 @{ accepted = $true; printer = $name }
          }
        } catch {
          Send-Json $response 503 @{ error = "No se pudo enviar la orden al cajon. Verifica la impresora POS, su conexion y el pin seleccionado." }
        }
        continue
      }

      if ($request.HttpMethod -ne "GET" -and $request.HttpMethod -ne "HEAD") {
        Send-Text $response 405 "Metodo no permitido"
        continue
      }

      $relativePath = [System.Uri]::UnescapeDataString($request.Url.AbsolutePath).TrimStart("/")
      if ([string]::IsNullOrWhiteSpace($relativePath)) {
        $relativePath = "index.html"
      }
      $relativePath = $relativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
      $filePath = [System.IO.Path]::GetFullPath((Join-Path $root $relativePath))

      if (-not $filePath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        Send-Text $response 403 "Acceso no permitido"
        continue
      }
      if ([System.IO.Directory]::Exists($filePath)) {
        $filePath = Join-Path $filePath "index.html"
      }
      if (-not [System.IO.File]::Exists($filePath)) {
        Send-Text $response 404 "Archivo no encontrado"
        continue
      }

      $bytes = [System.IO.File]::ReadAllBytes($filePath)
      $response.StatusCode = 200
      $response.ContentType = Get-ContentType $filePath
      $response.ContentLength64 = $bytes.Length
      if ($request.HttpMethod -ne "HEAD") {
        $response.OutputStream.Write($bytes, 0, $bytes.Length)
      }
    } catch {
      if ($null -ne $context) {
        try { Send-Text $context.Response 500 "Error local" } catch {}
      }
    } finally {
      if ($null -ne $context) {
        try { $context.Response.OutputStream.Close() } catch {}
        try { $context.Response.Close() } catch {}
      }
    }
  }
} finally {
  try { $listener.Stop() } catch {}
  try { $listener.Close() } catch {}
}
