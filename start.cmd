@echo off
REM llama.cpp Studio — launcher.
setlocal
cd /d "%~dp0"
set "NODE_EXE=%~dp0runtime\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

if not exist "web\vendor\react.production.min.js" (
  echo First run: preparing the UI...
  "%NODE_EXE%" build.js || (echo Build failed. & pause & exit /b 1)
)

if "%1"=="--console" goto console
if "%1"=="--foreground" goto console
if "%1"=="-c" goto console

REM Start in background with Windows system tray icon
echo Starting llama.cpp Studio in system tray (Router mode auto-start)...
start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0src\tray.ps1"
echo.
echo llama.cpp Studio is now running in the Windows System Tray.
echo Web UI: http://127.0.0.1:8770/
echo.
echo You may safely close this terminal window.
timeout /t 3 /nobreak >nul
goto end

:console
shift
"%NODE_EXE%" src\main.js %*
if errorlevel 1 pause

:end
endlocal
