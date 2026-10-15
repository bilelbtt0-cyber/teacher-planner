@echo off
title Planner
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Please install it from https://nodejs.org ^(version 22 or newer^).
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing for the first time, please wait...
  call npm install --omit=dev
)

echo.
echo  Planner is starting. Keep this window open while you use it.
echo  Close this window to stop the app.
echo.
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3000"
call npm start
pause
