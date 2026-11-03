# Starts the TABLY server on this PC and opens a free public address for it.
#
#   powershell -ExecutionPolicy Bypass -File scripts\start-server.ps1                (database on this PC: fast, the default)
#   powershell -ExecutionPolicy Bypass -File scripts\start-server.ps1 -Database neon (cloud database, needs .env.local)
#
# Why local is the default: the server runs on this PC, and a cloud database on another continent adds ~0.2 s to every
# query (a tap on an item makes ~16 of them), which feels like several seconds of lag. The local database is the file
# data\tably.db. Back it up if you care about old bills.
#
# Keep the window open while people use the app. Close it (or press Ctrl+C) to stop everything.
# The public address (https://something.trycloudflare.com) changes every time you start this;
# paste the new one into the app: Home > Server settings.

param([ValidateSet('local', 'neon')][string]$Database = 'local')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$api = Join-Path $root 'apps\api'
$python = Join-Path $api '.venv\Scripts\python.exe'
$dist = Join-Path $root 'apps\web\dist'

if (-not (Test-Path $python)) { throw "Python environment not found at $python. See README.md." }
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    throw "cloudflared is not installed. Install it with: winget install Cloudflare.cloudflared (then open a new window)."
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
    Write-Host ''
    Write-Host 'Server is running. Look below for the line containing https://....trycloudflare.com'
    Write-Host 'That is your public address. Paste it into the app: Home > Server settings.'
    Write-Host ''
    # http2 (TCP) instead of the default QUIC (UDP): many home and public networks block UDP and the tunnel never connects.
    cloudflared tunnel --protocol http2 --url http://127.0.0.1:8000
}
finally {
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
    Write-Host 'Server stopped.'
}
