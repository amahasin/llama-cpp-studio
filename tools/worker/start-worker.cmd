@echo off
setlocal
cd /d "%~dp0"
title llama.cpp Studio GPU Worker (RTX 3060)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-worker.ps1" %*
if %ERRORLEVEL% NEQ 0 pause
