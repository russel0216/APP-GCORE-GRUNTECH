@echo off
REM G-CORE Gruntech - what the GCoreGruntechApi scheduled task runs.
REM
REM Registered by install.ps1. Started and stopped only through that task, or
REM by PID after confirming the PID is ours. Never by image name - this host
REM also runs gasion-vision.
REM
REM Logs go to data\logs\api.log, outside the repository so a pull never
REM disturbs them and a clone never carries them.

setlocal
REM Derived from this script's own folder (%~dp0 ends with a backslash), so
REM the scheduled task works wherever the repository was put.
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
set LOGDIR=%ROOT%\data\logs

if not exist "%LOGDIR%" mkdir "%LOGDIR%"

REM Roll the log once it passes ~20MB, keeping one previous. Crude on purpose:
REM a scheduled task that depends on a log-rotation package is a scheduled task
REM that stops starting one day.
for %%A in ("%LOGDIR%\api.log") do (
  if %%~zA GTR 20000000 (
    if exist "%LOGDIR%\api.log.1" del "%LOGDIR%\api.log.1"
    move /Y "%LOGDIR%\api.log" "%LOGDIR%\api.log.1" >nul
  )
)

cd /d "%ROOT%\api"
echo. >> "%LOGDIR%\api.log"
echo ==== started %DATE% %TIME% ==== >> "%LOGDIR%\api.log"

REM dist\index.js, not tsx: production runs compiled JavaScript. If this file
REM is missing, the build did not run - see deploy\rebuild.ps1.
REM Absolute path on purpose. node.exe reports the same executable path for
REM every node process on this box, so the command line is the only thing that
REM identifies this one as ours - which rebuild.ps1 depends on before it frees
REM the port. See the ownership check there.
node "%ROOT%\api\dist\index.js" >> "%LOGDIR%\api.log" 2>&1

echo ==== exited %DATE% %TIME% with code %ERRORLEVEL% ==== >> "%LOGDIR%\api.log"
endlocal
