@echo off
title Teen Patti server
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org and run this again.
  pause
  exit /b 1
)

rem open the table in the browser once the server has had a moment to start
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"

node server.js

echo.
echo The server stopped. Scroll up to see why.
pause
