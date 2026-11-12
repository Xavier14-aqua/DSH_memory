@echo off
chcp 65001 >nul
cd /d "%~dp0"
title dsh-memory worker
:loop
node src\worker\worker.mjs
set "worker_code=%errorlevel%"
if "%worker_code%"=="23" (
  echo.
  echo [worker] Another instance is already running.
  echo [worker] If this is unexpected, check logs\worker.log and .state\worker.lock.
  echo [worker] Press any key to close this window.
  pause >nul
  exit /b 23
)
echo.
echo [worker] exited with code %worker_code%, restarting in 5s...
timeout /t 5 /nobreak >nul
goto loop
