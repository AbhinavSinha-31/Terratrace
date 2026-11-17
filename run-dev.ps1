# Start the whole dev stack: backend (127.0.0.1:8001, in a new window) + frontend (127.0.0.1:5173, here).
#   .\run-dev.ps1        (or: powershell -ExecutionPolicy Bypass -File run-dev.ps1)
# Ctrl+C stops the frontend; close the backend window (or Ctrl+C in it) to stop the backend.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Test-Listening([int]$port) {
    [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
}

if (Test-Listening 8001) {
    Write-Host 'Backend: something is already listening on 8001, not starting another.' -ForegroundColor Yellow
} else {
    $runBackend = Join-Path $root 'backend\run.ps1'
    Start-Process powershell -ArgumentList @('-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "`"$runBackend`"")
    Write-Host 'Backend: starting in a new window on http://127.0.0.1:8001'
}

if (Test-Listening 5173) {
    Write-Host 'Frontend: already running on http://localhost:5173' -ForegroundColor Yellow
    exit 0
}
$frontend = Join-Path $root 'frontend'
if (-not (Test-Path (Join-Path $frontend 'node_modules'))) {
    Write-Host 'Frontend: installing dependencies (npm ci)...'
    Push-Location $frontend
    try { npm ci } finally { Pop-Location }
}
Push-Location $frontend
try { npm run dev } finally { Pop-Location }
