# Starts the TABLY server on this PC and makes it reachable at your permanent public address.
#
#   powershell -ExecutionPolicy Bypass -File scripts\start-server.ps1
#
# Your address never changes (Tailscale Funnel): https://<this-pc>.<tailnet>.ts.net
# Keep this window open while people use the app. Close it (or press Ctrl+C) to stop the server.
# The PC must stay on and awake for links to work.
#
# Options:
#   -Database neon    use the cloud database from .env.local instead of the file on this PC (slower from far away)
#
# Why the database is local by default: a cloud database on another continent adds ~0.2 s to every query
# (a tap makes ~16), which feels like seconds of lag. The local database is the file data\tably.db.
# Back it up if you care about old bills.

param([ValidateSet('local', 'neon')][string]$Database = 'local')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$api = Join-Path $root 'apps\api'
$python = Join-Path $api '.venv\Scripts\python.exe'
$dist = Join-Path $root 'apps\web\dist'
$tailscale = 'C:\Program Files\Tailscale\tailscale.exe'

if (-not (Test-Path $python)) { throw "Python environment not found at $python. See README.md." }
if (-not (Test-Path $tailscale)) {
    throw "Tailscale is not installed. Install it with: winget install Tailscale.Tailscale, sign in, then enable Funnel (see docs/deploy.md)."
}

if ($Database -eq 'neon') {
    # Read the two Neon connection strings from .env.local. Only these two names are loaded; nothing is printed.
    $envFile = Join-Path $root '.env.local'
    if (-not (Test-Path $envFile)) { throw ".env.local not found. Run 'neon env pull' in the project folder first." }
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*(DATABASE_URL|DATABASE_URL_UNPOOLED)\s*=\s*(.*)$') {
            [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim().Trim('"'), 'Process')
        }
    }
    if (-not $env:DATABASE_URL) { throw "DATABASE_URL is missing from .env.local." }
    Write-Host 'Database: Neon (cloud). Taps will be slower if it is far away.'
}
else {
    # A SQLite file next to the project. Make sure no cloud settings from the environment leak in.
    Remove-Item Env:DATABASE_URL, Env:DATABASE_URL_UNPOOLED, Env:TABLY_MIGRATION_DATABASE_URL -ErrorAction SilentlyContinue
    $dataDir = Join-Path $root 'data'
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    $dbFile = Join-Path $dataDir 'tably.db'
    $env:TABLY_DATABASE_URL = 'sqlite:///' + $dbFile.Replace('\', '/')
    Write-Host "Database: this PC ($dbFile)"
}

# The shared bill page is part of the same server; build it once.
if (-not (Test-Path (Join-Path $dist 'index.html'))) {
    Write-Host 'Building the shared bill page (first run only)...'
    Push-Location $root
    npm run build -w '@tably/web'
    Pop-Location
}
$env:TABLY_WEB_DIST = $dist

Push-Location $api
Write-Host 'Updating the database tables if needed...'
& $python -m alembic upgrade head
if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'Database migration failed.' }

Write-Host 'Starting the TABLY server...'
$server = Start-Process -FilePath $python -PassThru -WindowStyle Hidden -ArgumentList @(
    '-m', 'uvicorn', 'tably_api.main:app', '--host', '127.0.0.1', '--port', '8000',
    '--proxy-headers', '--forwarded-allow-ips', '127.0.0.1')
Pop-Location

try {
    $up = $false
    for ($i = 0; $i -lt 30 -and -not $up; $i++) {
        Start-Sleep -Seconds 1
        try { $up = (Invoke-RestMethod 'http://127.0.0.1:8000/api/health' -TimeoutSec 2).ok } catch { }
    }
    if (-not $up) { throw 'The server did not start. Check the messages above.' }

    # Funnel forwards your permanent public address to this server. The setting is remembered by Tailscale.
    & $tailscale funnel --bg 8000 | Out-Host
    $status = (& $tailscale funnel status | Out-String)
    $address = [regex]::Match($status, 'https://\S+\.ts\.net').Value
    Write-Host ''
    Write-Host "TABLY is running. Your permanent address: $address"
    Write-Host 'Share bill links from the app as usual. Keep this window open. Press Ctrl+C to stop.'
    Write-Host ''
    Wait-Process -Id $server.Id
}
finally {
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
    Write-Host 'Server stopped.'
}
