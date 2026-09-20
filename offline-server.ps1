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
