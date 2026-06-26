@echo off
setlocal

set "SEEWOSERVICE_ROOT=C:\Program Files (x86)\Seewo\SeewoService"
set "ASSISTANT_DIR="

for /f "usebackq delims=" %%D in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$root = $env:SEEWOSERVICE_ROOT; Get-ChildItem -LiteralPath $root -Directory -Filter 'SeewoService_*' -ErrorAction SilentlyContinue | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'SeewoServiceAssistant\SeewoServiceAssistant.exe') } | Sort-Object @{ Expression = { try { [version]($_.Name -replace '^SeewoService_', '') } catch { [version]'0.0' } } }, Name -Descending | Select-Object -First 1 | ForEach-Object { Join-Path $_.FullName 'SeewoServiceAssistant' }"`) do set "ASSISTANT_DIR=%%D"

if not defined ASSISTANT_DIR goto :not_found

if defined AURA_DRY_RUN goto :dry_run

cd /d "%ASSISTANT_DIR%"
cls
taskkill /f /im SeewoServiceAssistant.exe
taskkill /f /im SeewoServiceAssistant.exe
taskkill /f /im SeewoServiceAssistant.exe
.\SeewoServiceAssistant.exe --inspect 9229 --aura-debug
exit /b %ERRORLEVEL%

:dry_run
echo %ASSISTANT_DIR%
exit /b 0

:not_found
echo Unable to find SeewoServiceAssistant.exe under "%SEEWOSERVICE_ROOT%\SeewoService_*".
exit /b 1
