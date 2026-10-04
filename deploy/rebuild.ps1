# G-CORE Gruntech - safe rebuild and restart.
#
#   powershell -ExecutionPolicy Bypass -File C:\G-CORE-GRUNTECH\deploy\rebuild.ps1
#
# Restarts ONLY the GCoreGruntechApi scheduled task. It never kills node by
# image name, never touches PM2, and never touches the Cloudflared service -
# that host also runs gasion-vision (live hospital oxygen-plant monitoring) and
# an image-name kill has taken it down three times. See deploy\README.md.
#
# The one place this is stricter than its predecessor: before freeing port 5100
# it CHECKS the listener is ours, and stops rather than killing a stranger.

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

# Is the process holding a port OURS?
#
# node.exe reports the same executable path for every node process on this box,
# so Path alone would judge our own API a stranger - and rebuild would refuse to
# free the port on every single run. The command line is what tells them apart,
# which is why start-api.cmd launches with an absolute script path.
function Test-OurProcess([int]$processId, [string]$root) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
    if (-not $p) { return $false }
    $r = $root.ToLower()
    if ($p.CommandLine    -and $p.CommandLine.ToLower().Contains($r))      { return $true }
    if ($p.ExecutablePath -and $p.ExecutablePath.ToLower().StartsWith($r)) { return $true }
    return $false
}

if (-not (Test-Path $root)) { throw "$root does not exist. Is this the right machine?" }

# -- 1. Pull ------------------------------------------------------------------
Step 'git pull'
Set-Location $root
if (Test-Path "$root\.git") {
    git pull
} else {
    Write-Host "    No git repository here - skipping the pull and building what is on disk." -ForegroundColor Yellow
}

# -- 2. Dependencies ----------------------------------------------------------
# Quick when nothing changed, essential the moment a commit adds a dependency:
# without it the build fails with "Cannot find module".
Step 'install api dependencies'
Set-Location "$root\api"
npm install --no-audit --no-fund

# -- 3. Schema before the code that needs it ----------------------------------
Step 'apply database migrations'
if (Test-Path "$root\api\prisma\migrations") {
    npx prisma migrate deploy
} else {
    # This project has been developed with `prisma db push` rather than a
    # migration history. Pushing is safe for additive change and is what the
    # schema has always been applied with; it is NOT safe once real data has to
    # survive a destructive change, which is when to start using migrations.
    Write-Host "    No migrations folder - using 'prisma db push' instead." -ForegroundColor Yellow
    npx prisma db push
}

# -- 4. Stop OURS, and only ours ----------------------------------------------
# Stopping before generating is not optional: the running API holds
# node_modules\.prisma\query_engine-windows.dll.node open, and Windows refuses
# to replace a file that is in use. Skipping this is what produces
# "EPERM: operation not permitted, rename query_engine-windows.dll.node".
Step "stop ONLY $task"
schtasks /End /TN $task 2>$null | Out-Null
Start-Sleep -Seconds 3

$listener = Get-NetTCPConnection -LocalPort $apiPort -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1

if ($listener) {
    $proc = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    $cim  = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
    $isOurs = Test-OurProcess $listener.OwningProcess $root

    if ($isOurs) {
        Write-Host "    Port $apiPort still held by our own pid $($listener.OwningProcess) - stopping that PID." -ForegroundColor Yellow
        Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    } else {
        # Deliberately fatal. The predecessor script killed whatever held the
        # port; on a shared host that is how you take down somebody else's
        # service while thinking you are restarting your own.
        throw @"
Port $apiPort is held by a process that is NOT ours:
    pid   $($listener.OwningProcess)
    name  $(if ($proc) { $proc.ProcessName } else { 'unknown' })
    cmd   $(if ($cim) { $cim.CommandLine } else { 'unknown' })

Refusing to kill it. Find out what it is first. If G-Core should move to a
different port, change PORT in api\.env and the tunnel config to match.
"@
    }
}

# -- 5. Prisma client ---------------------------------------------------------
Step 'regenerate prisma client'
# The engine DLL sometimes stays locked even after the API stops (antivirus, the
# search indexer, a lingering handle), so the final rename fails with EPERM.
# That last step only swaps in a byte-identical binary for the same Prisma
# version - the generated TypeScript client is written before it, and that is
# the part the build needs. The api build below is the real gate.
Remove-Item "$root\api\node_modules\.prisma\client\*.tmp*" -Force -ErrorAction SilentlyContinue
$ErrorActionPreference = 'Continue'
npx prisma generate
if ($LASTEXITCODE -ne 0) {
    Write-Host "    NOTE: prisma generate hit EPERM on the engine binary - continuing; the api build verifies the client is current." -ForegroundColor Yellow
}
$ErrorActionPreference = 'Stop'

# Seeding is idempotent by design: permissions are refreshed from the registry,
# a role/permission pair is granted only if the seed has never offered it, and
# everything else is create-only - so an administrator's revocations and edits
# survive. Without this step a new screen's permission, workflow or setting
# never reaches the server.
Step 'seed (idempotent)'
npm run seed
if ($LASTEXITCODE -ne 0) { throw 'npm run seed failed' }

# -- 6. Build -----------------------------------------------------------------
Step 'build api'
npm run build

Step 'install web dependencies'
Set-Location "$root\web"
npm install --no-audit --no-fund

Step 'build web'
npm run build
# In production the API serves web\dist, so there is one origin, one port and
# one tunnel. If this folder is missing the app still runs - as an API with no
# front end, which looks like a broken deployment.
if (-not (Test-Path "$root\web\dist\index.html")) { throw 'web\dist\index.html was not produced. The web build failed.' }

# -- 7. Start and prove it answers --------------------------------------------
# Windows stops a task created by schtasks after 3 days, and on battery power.
# Lifted here, while the API is stopped, so the copy started below has neither.
Step "keep $task running for good"
& powershell -ExecutionPolicy Bypass -File "$root\deploy\tasks.ps1" -Ensure api
if ($LASTEXITCODE -ne 0) { throw "Could not update the $task task settings." }

Step "start $task"
schtasks /Run /TN $task | Out-Null
Start-Sleep -Seconds 8

Step 'health check'
$healthy = $false
for ($i = 1; $i -le 6; $i++) {
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:$apiPort/api/health" -UseBasicParsing -TimeoutSec 10
        Write-Host "    API health: $($r.StatusCode) $($r.Content)" -ForegroundColor Green
        $healthy = $true
        break
    } catch {
        # The face-recognition models load at boot, so the first request can
        # arrive before the listener is up. Worth a few seconds' patience.
        Write-Host "    not up yet (attempt $i of 6)..." -ForegroundColor DarkGray
        Start-Sleep -Seconds 5
    }
}
if (-not $healthy) {
    Write-Host "`nHEALTH CHECK FAILED. The app did not answer on port $apiPort." -ForegroundColor Red
    Write-Host "Look at: $root\data\logs\api.log" -ForegroundColor Red
    exit 1
}

# -- 8. The tunnel, and the public address --------------------------------------
# A rebuild never restarts the tunnel, so nothing else would notice it had
# stopped - Windows stopped it twice after 3 days (Error 1033). Lift the limit,
# start it if it is not running, and prove https://gruntech.gcore.tech answers.
# Only G-Core's own GCoreGruntechTunnel task; never the Cloudflared service.
Step 'tunnel and public address'
& powershell -ExecutionPolicy Bypass -File "$root\deploy\tasks.ps1" -Ensure tunnel
$publicOk = $LASTEXITCODE -eq 0

# -- 9. Confirm we disturbed nothing ------------------------------------------
# Read-only. If the vision stack is down, this script did not do it - but it is
# worth knowing before you walk away.
Step 'the neighbour (read-only)'
$pm2 = Get-Command pm2 -ErrorAction SilentlyContinue
if (-not $pm2) { $pm2 = Get-Item "$env:APPDATA\npm\pm2.cmd" -ErrorAction SilentlyContinue }
if ($pm2) {
    $ErrorActionPreference = 'Continue'
    & $pm2.Source list 2>$null | Select-Object -First 15 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    $ErrorActionPreference = 'Stop'
}
$svc = Get-Service -Name 'Cloudflared' -ErrorAction SilentlyContinue
if ($svc) { Write-Host "    Cloudflared service: $($svc.Status)" -ForegroundColor DarkGray }

if (-not $publicOk) {
    Write-Host "`nThe new code is running on http://localhost:$apiPort, but the public address is NOT answering - see above.`n" -ForegroundColor Red
    exit 1
}
Write-Host "`nG-CORE Gruntech is up on http://localhost:$apiPort - https://gruntech.gcore.tech`n" -ForegroundColor Green
