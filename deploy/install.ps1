# G-CORE Gruntech - first-time install on the production server.
#
#   powershell -ExecutionPolicy Bypass -File C:\G-CORE-GRUNTECH\deploy\install.ps1
#
# Run ONCE. After this, deploy\rebuild.ps1 is the script you use.
#
# It refuses to start if the preflight finds a conflict, because the failure
# mode this guards against - claiming a port or a name that belongs to the
# gasion-vision host - is not one you want to discover halfway through.

$ErrorActionPreference = 'Stop'

# Where this installation actually is.
#
# Derived from the script's own location rather than hard-coded, so these
# scripts work from wherever the repository was put - on the server, on a
# laptop, or from a folder somebody renamed. Hard-coding it meant the very
# first person to run the preflight got "the argument ... does not exist",
# which tells them nothing about what is wrong.
$root = Split-Path -Parent $PSScriptRoot
$apiPort = 5100
$task    = 'GCoreGruntechApi'

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }

if (-not (Test-Path $root)) { throw "$root does not exist. Clone the repository there first." }

# -- 0. Preflight -------------------------------------------------------------
Step 'preflight'
& powershell -ExecutionPolicy Bypass -File "$root\deploy\preflight.ps1"
if ($LASTEXITCODE -ne 0) {
    throw 'Preflight found problems. Fix them and run this again - nothing has been changed.'
}

# -- 1. Configuration must exist before anything reads it ---------------------
Step 'check configuration'
$envFile = "$root\api\.env"
if (-not (Test-Path $envFile)) {
    throw "api\.env is missing. Copy deploy\env.production.example to api\.env and fill it in."
}
$envText = Get-Content $envFile -Raw
foreach ($bad in @('CHANGE_ME_BEFORE_FIRST_START', 'dev-only-change-me')) {
    if ($envText -match [regex]::Escape($bad)) { throw "api\.env still contains '$bad'. Fill it in properly first." }
}
if ($envText -notmatch 'JWT_SECRET\s*=\s*"[^"]{32,}"') {
    throw 'JWT_SECRET in api\.env is missing or too short. Generate one: node -e "console.log(require(''crypto'').randomBytes(48).toString(''hex''))"'
}
if ($envText -notmatch 'NODE_ENV\s*=\s*production') { throw 'api\.env does not set NODE_ENV=production.' }
Write-Host '    api\.env looks like a production configuration.' -ForegroundColor Green

$dbEnv = "$root\deploy\.env"
if (-not (Test-Path $dbEnv) -or ((Get-Content $dbEnv -Raw) -notmatch 'GCORE_DB_PASSWORD\s*=\s*\S{16,}')) {
    throw "deploy\.env is missing or has no GCORE_DB_PASSWORD (16+ characters). It must hold the same password as DATABASE_URL in api\.env."
}
Write-Host '    deploy\.env holds the database password.' -ForegroundColor Green

# -- 2. Data directories, outside the repository ------------------------------
Step 'create data directories'
foreach ($d in @("$root\data", "$root\data\uploads", "$root\data\logs")) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
}
Write-Host "    $root\data - uploads and logs live here so a pull never touches them." -ForegroundColor Green

# -- 3. Database --------------------------------------------------------------
Step 'start the database container'
Set-Location "$root\deploy"
docker compose -f docker-compose.prod.yml up -d

Write-Host '    waiting for Postgres to accept connections...' -ForegroundColor DarkGray
$ready = $false
for ($i = 1; $i -le 30; $i++) {
    docker exec gcore-gruntech-db pg_isready -U gcore -d gcore 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 2
}
if (-not $ready) { throw 'The database did not become ready. Check: docker logs gcore-gruntech-db' }
Write-Host '    database is up on 127.0.0.1:5435' -ForegroundColor Green

# -- 4. Build -----------------------------------------------------------------
Step 'install api dependencies'
Set-Location "$root\api"
npm install --no-audit --no-fund

Step 'create the schema'
if (Test-Path "$root\api\prisma\migrations") { npx prisma migrate deploy } else { npx prisma db push }

Step 'generate the prisma client'
npx prisma generate

Step 'seed'
# Safe to re-run: permissions refresh from the registry, roles keep revocations
# an administrator made, and the admin user is created only if absent.
npm run seed

Step 'build api'
npm run build

Step 'install web dependencies'
Set-Location "$root\web"
npm install --no-audit --no-fund

Step 'build web'
npm run build
if (-not (Test-Path "$root\web\dist\index.html")) { throw 'web\dist\index.html was not produced. The web build failed.' }

# -- 5. The scheduled task ----------------------------------------------------
# A scheduled task rather than PM2: PM2 on this host belongs to the vision
# system, and adding an app to somebody else's process manager means every
# `pm2 restart all` they run touches ours too.
Step "register the $task scheduled task"
$cmd = "cmd /c `"$root\deploy\start-api.cmd`""
schtasks /Create /F /TN $task /SC ONSTART /RU SYSTEM /RL HIGHEST /TR $cmd | Out-Null
Write-Host "    $task registered - starts at boot, runs as SYSTEM." -ForegroundColor Green
# schtasks cannot switch off Windows' 3-day limit or the battery stop; without
# this the API would stop by itself three days after any start.
& powershell -ExecutionPolicy Bypass -File "$root\deploy\tasks.ps1" -Ensure api
if ($LASTEXITCODE -ne 0) { throw "Could not update the $task task settings." }

Step "start $task"
schtasks /Run /TN $task | Out-Null
Start-Sleep -Seconds 10

# -- 6. Prove it works --------------------------------------------------------
Step 'health check'
$healthy = $false
for ($i = 1; $i -le 6; $i++) {
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:$apiPort/api/health" -UseBasicParsing -TimeoutSec 10
        Write-Host "    API health: $($r.StatusCode) $($r.Content)" -ForegroundColor Green
        $healthy = $true
        break
    } catch {
        Write-Host "    not up yet (attempt $i of 6)..." -ForegroundColor DarkGray
        Start-Sleep -Seconds 5
    }
}
if (-not $healthy) {
    Write-Host "`nThe app did not answer on port $apiPort." -ForegroundColor Red
    Write-Host "Look at: $root\data\logs\api.log" -ForegroundColor Red
    exit 1
}

# -- 7. What is left for a person to do ---------------------------------------
Write-Host @"

Installed.

  Local          http://localhost:$apiPort
  Task           $task
  Database       gcore-gruntech-db on 127.0.0.1:5435
  Data           $root\data
  Logs           $root\data\logs\api.log

Still to do, and none of it can be scripted:

  1. The tunnel - section 6 of deploy\README.md. Until then the app is
     reachable on this machine only.
        cloudflared tunnel create gcore-gruntech
     Do NOT run 'cloudflared service install': it would replace the existing
     Cloudflared service and take gasiontech offline. Finish with
        deploy\tasks.ps1 -Ensure tunnel
     or Windows stops the tunnel 3 days after it starts.

  2. Sign in and change the admin password. It is sitting in api\.env in plain
     text until you do.

  3. Assign the roles:
        cd $root\api
        npx tsx scripts\audit-workflows.ts
     Approvals route to roles. A role nobody holds means documents stall at
     submission with nowhere to go.

  4. Company Settings - name, logo, address, TIN, VAT and EWT rates. These
     print on every quotation, billing and invoice.

  5. Register the nightly backup - section 7 of deploy\README.md.

"@ -ForegroundColor Cyan
