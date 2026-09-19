# G-CORE Gruntech - nightly backup.
#
# Dumps OUR database and OUR uploads. It does not touch gasion_db, which has
# its own backup under the GCoreDbBackup task at 02:00. Register this one for
# 02:30 so two pg_dumps are not hitting the same Docker daemon at once:
#
#   schtasks /Create /F /TN GCoreGruntechBackup /SC DAILY /ST 02:30 /RU SYSTEM ^
#     /TR "powershell -ExecutionPolicy Bypass -File C:\G-CORE-GRUNTECH\deploy\backup.ps1"
#
# Restore:
#   docker cp C:\backups\gcore-gruntech\gcore_<stamp>.dump gcore-gruntech-db:/tmp/r.dump
#   docker exec gcore-gruntech-db pg_restore -U gcore -d gcore --clean --if-exists /tmp/r.dump

$ErrorActionPreference = 'Stop'

$dir       = 'C:\backups\gcore-gruntech'
$uploads   = 'C:\G-CORE-GRUNTECH\data\uploads'
$container = 'gcore-gruntech-db'
$retention = 30

New-Item -ItemType Directory -Force -Path $dir | Out-Null
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
$log   = "$dir\backup.log"

function Say($m) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m"
    Write-Host $line
    Add-Content -Path $log -Value $line
}

Say "=== backup $stamp ==="

# -- The database -------------------------------------------------------------
# Dumped inside the container in custom format, then copied out, so no shell
# encoding can mangle the stream on the way through.
try {
    docker exec $container pg_dump -U gcore -Fc -d gcore -f /tmp/gcore.dump
    if ($LASTEXITCODE -ne 0) { throw "pg_dump exited $LASTEXITCODE" }

    docker cp "${container}:/tmp/gcore.dump" "$dir\gcore_$stamp.dump"
    if ($LASTEXITCODE -ne 0) { throw "docker cp exited $LASTEXITCODE" }

    docker exec $container rm -f /tmp/gcore.dump | Out-Null

    $size = [math]::Round((Get-Item "$dir\gcore_$stamp.dump").Length / 1MB, 2)
    # A dump that is suspiciously small usually means the container came up
    # with an empty volume - worth screaming about tonight rather than
    # discovering during a restore.
    if ($size -lt 0.05) { Say "WARNING: gcore_$stamp.dump is only ${size}MB. Check the database is not empty." }
    else { Say "database: gcore_$stamp.dump (${size}MB)" }
} catch {
    Say "DATABASE BACKUP FAILED: $($_.Exception.Message)"
    exit 1
}

# -- The uploads --------------------------------------------------------------
# Attachments, the company logo, clock-in photos and service-report evidence.
# A database restored without these has invoices pointing at files that are
# gone, and attendance records whose photographic evidence no longer exists.
try {
    if (Test-Path $uploads) {
        $zip = "$dir\uploads_$stamp.zip"
        Compress-Archive -Path "$uploads\*" -DestinationPath $zip -CompressionLevel Optimal -ErrorAction Stop
        $size = [math]::Round((Get-Item $zip).Length / 1MB, 2)
        Say "uploads: uploads_$stamp.zip (${size}MB)"
    } else {
        Say "uploads: $uploads does not exist - nothing to archive"
    }
} catch {
    # Not fatal: the database dump is the irreplaceable half, and it succeeded.
    Say "UPLOADS BACKUP FAILED: $($_.Exception.Message)"
}

# -- Retention ----------------------------------------------------------------
$cutoff = (Get-Date).AddDays(-$retention)
$old = Get-ChildItem -Path $dir -Include *.dump, *.zip -File -ErrorAction SilentlyContinue |
       Where-Object { $_.LastWriteTime -lt $cutoff }
if ($old) {
    $old | Remove-Item -Force -Confirm:$false
    Say "removed $($old.Count) file(s) older than $retention days"
}

$kept = (Get-ChildItem -Path $dir -Filter *.dump -File | Measure-Object).Count
Say "done - $kept database dump(s) on hand"
