# G-CORE Gruntech - deploy every push to master, by itself.
#
#   powershell -ExecutionPolicy Bypass -File C:\G-CORE-GRUNTECH\deploy\autodeploy.ps1 -Register
#   powershell -ExecutionPolicy Bypass -File C:\G-CORE-GRUNTECH\deploy\autodeploy.ps1 -Unregister
#   powershell -ExecutionPolicy Bypass -File C:\G-CORE-GRUNTECH\deploy\autodeploy.ps1            (one check, now)
#
# -Register creates G-Core's own GCoreGruntechDeploy scheduled task, which
# runs this script every 5 minutes. Each run fetches origin/master; when it
# differs from what is checked out it runs deploy\rebuild.ps1 - the same safe
# rebuild a person runs by hand - and writes everything it printed to
# data\logs\deploy.log, with the outcome in data\logs\deploy-last.txt. When
# nothing changed it does nothing and writes nothing.
#
# A push to master is therefore live within about five minutes plus the build.
# rebuild.ps1 builds the new code BEFORE it stops the running site, so a push
# that does not build leaves the site as it was and the log red; a commit the
# pull refused (the server's checkout was changed by hand) is tried once and
# then left until the next push, so a stuck deploy does not rebuild every five
# minutes.
#
# The task runs as the user who registers it, with their password (asked for
# once): the pull needs that user's saved GitHub credentials, which SYSTEM does
# not have. If that password changes, register again. Its settings (no battery
# stop, a 3-hour limit per run, one run at a time) are set at registration -
# a task holding a password cannot be changed later without it.
#
# Touches only the GCoreGruntechDeploy task. Never the Cloudflared service,
# never PM2, never a process by image name - rebuild.ps1 holds those rules.

param(
    [switch]$Register,
    [switch]$Unregister,
    [int]$EveryMinutes = 5
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$task = 'GCoreGruntechDeploy'
$logDir = "$root\data\logs"
$log = "$logDir\deploy.log"
$last = "$logDir\deploy-last.txt"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Log([string]$m) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"
    Add-Content -Path $log -Value $line
    Write-Host $line
}

if ($Register -and $Unregister) { throw 'Pick one of -Register and -Unregister.' }

if ($Unregister) {
    schtasks /Delete /F /TN $task 2>$null | Out-Null
    Write-Host "    $task removed. Deploys are by hand again: deploy\rebuild.ps1." -ForegroundColor Green
    exit 0
}

if ($Register) {
    if ($EveryMinutes -lt 1) { throw 'EveryMinutes must be at least 1.' }
    $user = "$env:USERDOMAIN\$env:USERNAME"
    Write-Host "    Registering $task to run every $EveryMinutes minutes as $user." -ForegroundColor Cyan
    Write-Host "    Your Windows password is what lets the task pull from GitHub as you." -ForegroundColor Cyan
    $secure = Read-Host -Prompt "    Password for $user" -AsSecureString
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
    # One call with the settings in it: a task that stores a password cannot
    # be changed afterwards without the password again, so the 3-day limit
    # and the battery stop are lifted here rather than by tasks.ps1.
    $action = New-ScheduledTaskAction -Execute 'powershell' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$root\deploy\autodeploy.ps1`""
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 3) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable
    Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -User $user -Password $plain -RunLevel Highest -Force | Out-Null
    $plain = $null
    Write-Host "    Done. Every push to master now deploys itself. Watch it with:" -ForegroundColor Green
    Write-Host "        Get-Content $log -Tail 40 -Wait" -ForegroundColor Green
    exit 0
}

# -- One check ----------------------------------------------------------------
if (-not (Test-Path "$root\.git")) { Log "No git repository at $root - nothing to deploy from."; exit 1 }

# git reports on stderr even when it succeeds; under 'Stop' a captured stderr
# line would end the script before it could say why.
$ErrorActionPreference = 'Continue'

$env:GIT_ASK_YESNO = 'false'
$env:GIT_TERMINAL_PROMPT = '0'
$safe = "safe.directory=$($root -replace '\\', '/')"
Set-Location $root

$fetched = & git -c $safe fetch --quiet origin master 2>&1
if ($LASTEXITCODE -ne 0) { Log "git fetch failed: $fetched"; exit 1 }
$local  = (& git -c $safe rev-parse HEAD).Trim()
$remote = (& git -c $safe rev-parse origin/master).Trim()
if ($local -eq $remote) { exit 0 }

# A commit that already failed to deploy is not tried again every five minutes.
if (Test-Path $last) {
    $prev = Get-Content $last -Raw
    if ($prev -match "^FAILED $remote") { exit 0 }
}

$short = $remote.Substring(0, 7)
Log "==> deploying $($local.Substring(0, 7)) -> $short"
# A separate process, with its own output appended to the log: npm and git
# write ordinary progress to stderr, and capturing that inside this process
# would turn it into errors.
cmd /c "powershell -NoProfile -ExecutionPolicy Bypass -File `"$root\deploy\rebuild.ps1`" >> `"$log`" 2>&1"
$code = $LASTEXITCODE
$now = (& git -c $safe rev-parse HEAD).Trim()
if ($code -eq 0 -and $now -eq $remote) {
    "OK $remote $(Get-Date -Format s)" | Set-Content $last
    Log "==> deployed $short"
    exit 0
}
"FAILED $remote $(Get-Date -Format s) exit $code" | Set-Content $last
Log "==> FAILED deploying $short (exit $code) - read above; the site stays on $($now.Substring(0, 7)). Fix, push again, or run deploy\rebuild.ps1 by hand."
exit 1
