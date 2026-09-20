@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if exist "%~dp0crear-acceso-directo.ps1" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0crear-acceso-directo.ps1" >nul 2>&1
)

set "APP_URL=http://127.0.0.1:8766/admin.html"
set "HEALTH_URL=http://127.0.0.1:8766/__tienda_napoles_health"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $response=Invoke-WebRequest -UseBasicParsing -Uri '%HEALTH_URL%' -TimeoutSec 2; if ($response.StatusCode -ne 200) { exit 1 }" >nul 2>&1
if errorlevel 1 (
  start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0offline-server.ps1"
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$limit=(Get-Date).AddSeconds(15); do { try { $response=Invoke-WebRequest -UseBasicParsing -Uri '%HEALTH_URL%' -TimeoutSec 2; if ($response.StatusCode -eq 200) { exit 0 } } catch {}; Start-Sleep -Milliseconds 250 } while ((Get-Date) -lt $limit); exit 1" >nul 2>&1
if errorlevel 1 (
  echo No fue posible iniciar Tienda Napoles Offline.
  echo Cierra esta ventana, espera unos segundos e intenta nuevamente.
  pause
  exit /b 1
)

set "BROWSER_EXE="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER_EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER_EXE if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER_EXE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER_EXE if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "BROWSER_EXE=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER_EXE if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER_EXE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER_EXE if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER_EXE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

if defined BROWSER_EXE (
  start "Tienda Napoles" "%BROWSER_EXE%" --app="%APP_URL%"
) else (
  start "" "%APP_URL%"
)
endlocal
