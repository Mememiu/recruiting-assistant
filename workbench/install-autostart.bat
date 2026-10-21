@echo off
rem Recruiting workbench - register / unregister Windows logon autostart.
rem
rem Usage:
rem   Double-click             = register autostart
rem   Double-click --uninstall = unregister autostart
rem   Manual alternative: Win+R -> shell:startup, drop a shortcut to start.bat.
rem
rem Writes a small launcher into the current user's Startup folder that starts
rem start.bat in a minimized window at logon. No admin rights needed.
rem
rem NOTE: keep this file ASCII-only - cmd.exe misparses UTF-8 Chinese text.
rem The Chinese docs live in README (section: workbench autostart).
rem
rem Testing hook: set AUTOSTART_DIR to override the target directory.

setlocal

set "HERE=%~dp0"
if not exist "%HERE%start.bat" (
  echo [X] start.bat not found. Run this file from inside the workbench directory.
  pause
  exit /b 1
)

if not defined AUTOSTART_DIR set "AUTOSTART_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\StartUp"
set "TARGET=%AUTOSTART_DIR%\recruiting-workbench.bat"

if /i "%~1"=="--uninstall" goto uninstall

where node >nul 2>nul
if errorlevel 1 (
  echo [X] node not found. Install Node.js and make sure it is on PATH first.
  pause
  exit /b 1
)

> "%TARGET%" echo @echo off
>>"%TARGET%" echo start "recruiting-workbench" /min "%HERE%start.bat"

echo [OK] Autostart registered: %TARGET%
echo      It will launch minimized at next logon.
echo      To take effect now, either log off and on again, or run start.bat manually.
pause
exit /b 0

:uninstall
if not exist "%TARGET%" (
  echo No autostart was registered: %TARGET%
  pause
  exit /b 0
)
del "%TARGET%"
if exist "%TARGET%" (
  echo [X] Failed to remove: %TARGET%
  pause
  exit /b 1
)
echo [OK] Autostart removed: %TARGET%
pause
exit /b 0
