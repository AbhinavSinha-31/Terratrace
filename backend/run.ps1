# Start the TERRATRACE backend at http://127.0.0.1:8001 with auto-reload.
# Works from any directory:  backend\run.ps1   (or: powershell -ExecutionPolicy Bypass -File backend\run.ps1)
#
# Uses backend\.venv's Python directly (same effect as activating the venv, without changing the
# calling terminal's PATH) and passes --app-dir, so `import app` resolves no matter where the
# command is started from. Started from the repo root, plain `uvicorn app.main:app` fails with
# "ModuleNotFoundError: No module named 'app'".
param(
    [int]$Port = 8001,      # frontend/vite.config.ts proxies /api to 127.0.0.1:8001
    [switch]$NoReload
)
$ErrorActionPreference = 'Stop'

$backend = $PSScriptRoot
$python = Join-Path $backend '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) {
    Write-Host "No virtual environment at $backend\.venv. Create it first:" -ForegroundColor Red
    Write-Host "  python -m venv `"$backend\.venv`""
    Write-Host "  & `"$python`" -m pip install -r `"$backend\requirements.txt`""
    exit 1
}
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
    Write-Host "Port $Port is already in use (an earlier backend is probably still running)." -ForegroundColor Yellow
    Write-Host "Find it with: Get-NetTCPConnection -LocalPort $Port -State Listen"
    exit 1
}

$uvicornArgs = @('-m', 'uvicorn', 'app.main:app', '--app-dir', $backend, '--host', '127.0.0.1', '--port', $Port)
# Watch only the source package: .venv and .cache live under backend\ too.
if (-not $NoReload) { $uvicornArgs += @('--reload', '--reload-dir', (Join-Path $backend 'app')) }

Push-Location $backend
try { & $python @uvicornArgs } finally { Pop-Location }
