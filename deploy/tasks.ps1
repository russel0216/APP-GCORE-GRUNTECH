# G-CORE Gruntech - keep G-Core's own scheduled tasks able to run for good.
#
#   powershell -ExecutionPolicy Bypass -File C:\G-CORE-GRUNTECH\deploy\tasks.ps1 -Ensure api
#   powershell -ExecutionPolicy Bypass -File C:\G-CORE-GRUNTECH\deploy\tasks.ps1 -Ensure tunnel
#
# Why this exists. `schtasks /Create` cannot switch off Windows' default
# "stop the task if it runs longer than 3 days" (ExecutionTimeLimit PT72H), nor
# "stop if the computer switches to battery power" - which a UPS on USB counts
# as. The tunnel task never restarts on a deploy, so Windows stopped it 72 hours
# after it started, twice: 27 Sep 17:46 -> 30 Sep, and 1 Oct 05:02 -> 4 Oct
# 05:02. Both times the site showed Cloudflare's Error 1033 until somebody
# noticed. The API task carries the same limit and survives only because every
# rebuild restarts it.
#
#   -Ensure api     removes those limits from GCoreGruntechApi. Starts nothing:
#                   install.ps1 and rebuild.ps1 start it themselves.
#   -Ensure tunnel  removes them from GCoreGruntechTunnel, starts it if it is
#                   not running (restarts it once if it was running under the
#                   old limit), then proves the public address answers.
#   -Ensure deploy  checks GCoreGruntechDeploy, the every-five-minutes
#                   auto-deploy. autodeploy.ps1 -Register sets its settings
#                   itself (a task holding a password cannot be changed here
#                   without it), so this only reports, and says to register
#                   again if they are wrong.
#
# It touches ONLY those three tasks - the names are checked below. Never the
# `Cloudflared` service (gasiontech's tunnel), never PM2, never a process by
# image name. On a machine with no tunnel task (a laptop) it says so and stops.

param(
    [ValidateSet('api', 'tunnel', 'deploy')]
    [string]$Ensure = 'tunnel'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$ours = @{ api = 'GCoreGruntechApi'; tunnel = 'GCoreGruntechTunnel'; deploy = 'GCoreGruntechDeploy' }
$name = $ours[$Ensure]

# 'missing', 'changed' or 'ok'. Only ever called with one of $ours.
function Set-RunsIndefinitely([string]$taskName) {
    if ($ours.Values -notcontains $taskName) { throw "Refusing to change '$taskName' - not a G-Core task." }
    $t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $t) { return 'missing' }
    $s = $t.Settings
    $limited = $s.ExecutionTimeLimit -and $s.ExecutionTimeLimit -ne 'PT0S'
    if ($taskName -eq $ours.deploy) { $limited = $false }   # its runs are short; a per-run limit is right
    if (-not $limited -and -not $s.DisallowStartIfOnBatteries -and -not $s.StopIfGoingOnBatteries) { return 'ok' }
    if ($taskName -eq $ours.deploy) { return 'limited' }
    $s.ExecutionTimeLimit = 'PT0S'
    $s.DisallowStartIfOnBatteries = $false
    $s.StopIfGoingOnBatteries = $false
    Set-ScheduledTask -InputObject $t | Out-Null
    return 'changed'
}

$state = Set-RunsIndefinitely $name
switch ($state) {
    'missing' {
        if ($Ensure -eq 'tunnel') {
            Write-Host "    No $name task on this machine - nothing to keep running (expected on a laptop)." -ForegroundColor DarkGray
            exit 0
        }
        if ($Ensure -eq 'deploy') { throw "The $name task does not exist. Run deploy\autodeploy.ps1 -Register first." }
        throw "The $name task does not exist. Run deploy\install.ps1 first."
    }
    'changed' { Write-Host "    $name no longer stops after 3 days or on battery power." -ForegroundColor Green }
    'limited' {
        Write-Host "    $name would stop on battery power - run deploy\autodeploy.ps1 -Register again to fix its settings." -ForegroundColor Yellow
        exit 1
    }
    'ok'      { Write-Host "    $name has no time limit." -ForegroundColor DarkGray }
}
if ($Ensure -ne 'tunnel') { exit 0 }

# -- The tunnel: running, then answering --------------------------------------
$running = (Get-ScheduledTask -TaskName $name).State -eq 'Running'
if ($running -and $state -eq 'changed') {
    # A running instance may keep the limit it was started with; restart it
    # once so the one left running has none. A few seconds offline, now,
    # rather than the whole morning three days from now.
    Write-Host "    Restarting $name so the running copy has no limit either." -ForegroundColor Yellow
    schtasks /End /TN $name | Out-Null
    Start-Sleep -Seconds 3
    $running = $false
}
if (-not $running) {
    Write-Host "    $name was not running - starting it." -ForegroundColor Yellow
    schtasks /Run /TN $name | Out-Null
}

# The public address, from api\.env - the end-to-end proof that Cloudflare,
# the tunnel and the API all line up.
$url = $null
$envFile = "$root\api\.env"
if (Test-Path $envFile) {
    $m = Select-String -Path $envFile -Pattern '^\s*APP_URL\s*=\s*"?([^"\s]+)"?' | Select-Object -First 1
    if ($m) { $url = $m.Matches[0].Groups[1].Value.TrimEnd('/') }
}
if (-not $url -or $url -notmatch '^https://') {
    Write-Host "    No https APP_URL in api\.env - cannot check the public address." -ForegroundColor Yellow
    exit 0
}

# Windows PowerShell 5.1 may not offer TLS 1.2 unasked; Cloudflare requires it.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
for ($i = 1; $i -le 12; $i++) {
    try {
        $r = Invoke-WebRequest -Uri "$url/api/health" -UseBasicParsing -TimeoutSec 10
        Write-Host "    $url answers: $($r.StatusCode) $($r.Content)" -ForegroundColor Green
        exit 0
    } catch {
        Write-Host "    $url not answering yet (attempt $i of 12)..." -ForegroundColor DarkGray
        Start-Sleep -Seconds 5
    }
}

Write-Host @"

$url DOES NOT ANSWER, although the API does on this machine.
Error 1033 in a browser means the tunnel is not connected. Check our tunnel -
with its own config, because the default config.yml on this server is another
app's tunnel and plain 'cloudflared tunnel info gcore-gruntech' reports on that:

    schtasks /Query /TN $name /V /FO LIST | findstr /i "Status Last Stop"
    cloudflared tunnel --config C:\Users\Administrator\.cloudflared\gcore-gruntech.yml info gcore-gruntech

Leave the 'Cloudflared' service alone - it is gasiontech's.
"@ -ForegroundColor Red
exit 1
