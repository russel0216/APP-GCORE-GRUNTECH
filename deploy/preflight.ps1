# G-CORE Gruntech - preflight check.
#
# READ-ONLY. This script changes nothing. It answers one question: is anything
# already using the ports, container names or task names this deployment wants,
# and is the safety-critical neighbour healthy right now?
#
# Run it before install.ps1, and again any time a rebuild behaves oddly.
#
#   powershell -ExecutionPolicy Bypass -File C:\G-CORE-GRUNTECH\deploy\preflight.ps1

$ErrorActionPreference = 'Continue'

$root        = 'C:\G-CORE-GRUNTECH'
$apiPort     = 5100
$dbPort      = 5434
$task        = 'GCoreGruntechApi'
$dbContainer = 'gcore-gruntech-db'

$problems = @()
$notes    = @()

function Ok($m)    { Write-Host "  [ ok ] $m" -ForegroundColor Green }
function Warn($m)  { Write-Host "  [warn] $m" -ForegroundColor Yellow; $script:notes += $m }
function Bad($m)   { Write-Host "  [STOP] $m" -ForegroundColor Red;   $script:problems += $m }

Write-Host ""
Write-Host "G-CORE Gruntech preflight" -ForegroundColor Cyan
Write-Host "=========================" -ForegroundColor Cyan

# -- Who is on our ports ------------------------------------------------------
Write-Host "`nPorts" -ForegroundColor Cyan

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

function Describe-Listener([int]$port) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1
    if (-not $conn) { return $null }
    $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $($conn.OwningProcess)" -ErrorAction SilentlyContinue
    [pscustomobject]@{
        Pid     = $conn.OwningProcess
        Name    = if ($proc) { $proc.ProcessName } else { 'unknown' }
        Command = if ($cim)  { $cim.CommandLine } else { $null }
    }
}

$api = Describe-Listener $apiPort
if (-not $api) {
    Ok "$apiPort is free"
} elseif (Test-OurProcess $api.Pid $root) {
    Ok "$apiPort is held by our own API (pid $($api.Pid)) - expected if it is already installed"
} else {
    Bad "$apiPort is held by pid $($api.Pid) ($($api.Name)), which is NOT ours. Do not kill it - find out what it is, or move G-Core to another port in api\.env and the tunnel config."
    Write-Host "         command: $($api.Command)" -ForegroundColor DarkGray
}

$db = Describe-Listener $dbPort
if (-not $db) { Ok "$dbPort is free (our Postgres)" } else { Warn "$dbPort is in use by pid $($db.Pid) ($($db.Name)). If that is our own gcore-gruntech-db container, fine." }

$other = Describe-Listener 5433
if ($other) { Ok "5433 is in use, as expected - that is gasion_db, and we do not touch it" }
else        { Warn "5433 is free. The other system's database does not appear to be running." }

$hr = Describe-Listener 5001
if ($hr) { Ok "5001 is in use, as expected - that is G-CORE HR" }

# -- Names we are about to claim ----------------------------------------------
Write-Host "`nNames" -ForegroundColor Cyan

$existing = schtasks /Query /TN $task 2>$null
if ($LASTEXITCODE -eq 0) { Warn "Scheduled task '$task' already exists - install.ps1 will replace it (that is ours, so it is fine)" }
else                     { Ok "Scheduled task '$task' is free" }

foreach ($t in @('GCoreHrApi', 'GCoreDbBackup')) {
    $r = schtasks /Query /TN $t 2>$null
    if ($LASTEXITCODE -eq 0) { Ok "'$t' exists and belongs to the other app - untouched" }
}

$dockerUp = $true
try { docker ps --format '{{.Names}}' 2>$null | Out-Null } catch { $dockerUp = $false }
if ($LASTEXITCODE -ne 0) { $dockerUp = $false }

if (-not $dockerUp) {
    Bad "Docker is not responding. Start Docker Desktop and wait for the engine before installing."
} else {
    $names = docker ps -a --format '{{.Names}}'
    if ($names -contains $dbContainer) { Warn "Container '$dbContainer' already exists - ours, so compose will reuse it" }
    else                               { Ok "Container name '$dbContainer' is free" }
    if ($names -contains 'gasion_db')  { Ok "'gasion_db' is present and belongs to the other apps - untouched" }
}

# -- The neighbour ------------------------------------------------------------
Write-Host "`nThe safety-critical neighbour" -ForegroundColor Cyan
Write-Host "  (read-only - nothing here is started, stopped or changed)" -ForegroundColor DarkGray

$svc = Get-Service -Name 'Cloudflared' -ErrorAction SilentlyContinue
if ($svc) {
    if ($svc.Status -eq 'Running') { Ok "The 'Cloudflared' service is Running. We will NOT use it - G-Core gets its own tunnel task." }
    else { Warn "The 'Cloudflared' service is $($svc.Status). That is gasiontech's tunnel and is not ours to start." }
} else {
    Warn "No 'Cloudflared' service found. Expected on this host - worth checking with whoever runs gasiontech."
}

$pm2 = Get-Command pm2 -ErrorAction SilentlyContinue
if (-not $pm2) { $pm2 = Get-Item "$env:APPDATA\npm\pm2.cmd" -ErrorAction SilentlyContinue }
if ($pm2) {
    Write-Host "  PM2 processes (the vision stack - for information only):" -ForegroundColor DarkGray
    & $pm2.Source list 2>$null | Select-Object -First 20 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    Ok "PM2 is present. Nothing in this deployment calls it except to read."
} else {
    Warn "PM2 was not found on the PATH. If the vision stack runs under it, check with its owner."
}

$nodeCount = (Get-Process node -ErrorAction SilentlyContinue | Measure-Object).Count
if ($nodeCount -gt 0) {
    Ok "$nodeCount node process(es) running. This is exactly why nothing here kills node by image name."
}

# -- Toolchain ----------------------------------------------------------------
Write-Host "`nToolchain" -ForegroundColor Cyan

$node = (node --version 2>$null)
if ($LASTEXITCODE -eq 0) {
    $major = [int](($node -replace '^v','') -split '\.')[0]
    if ($major -ge 20) { Ok "Node $node" } else { Bad "Node $node is too old - 20 or later is required." }
} else { Bad "Node is not on the PATH." }

foreach ($tool in @('git', 'cloudflared')) {
    if (Get-Command $tool -ErrorAction SilentlyContinue) { Ok "$tool found" }
    else { if ($tool -eq 'git') { Bad "git is not on the PATH." } else { Warn "cloudflared is not on the PATH - needed for step 6, not for install." } }
}

if (Test-Path "$root\api\.env") { Ok "api\.env exists" }
else { Warn "api\.env is missing - copy deploy\env.production.example to api\.env before installing." }

# -- Verdict ------------------------------------------------------------------
Write-Host ""
if ($problems.Count -eq 0) {
    Write-Host "Preflight passed." -ForegroundColor Green
    if ($notes.Count) { Write-Host "$($notes.Count) thing(s) worth a look, none blocking." -ForegroundColor Yellow }
    exit 0
}

Write-Host "$($problems.Count) problem(s) must be fixed before installing:" -ForegroundColor Red
$problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
exit 1
