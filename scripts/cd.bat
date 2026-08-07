@echo off
setlocal

set "SEEWOSERVICE_ROOT=C:\Program Files (x86)\Seewo\SeewoService"
set "ASSISTANT_DIR="

for /f "usebackq delims=" %%D in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0findSeewoAssistant.ps1"`) do set "ASSISTANT_DIR=%%D"

if not defined ASSISTANT_DIR goto :not_found

if defined AURA_DRY_RUN goto :dry_run

cd /d "%ASSISTANT_DIR%"
cmd /k
exit /b %ERRORLEVEL%

:dry_run
echo %ASSISTANT_DIR%
exit /b 0

:not_found
echo Unable to find SeewoServiceAssistant.exe under "%SEEWOSERVICE_ROOT%\SeewoService_*".
exit /b 1
