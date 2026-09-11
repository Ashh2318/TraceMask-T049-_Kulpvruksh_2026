@echo off
title TraceMask
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 22 LTS or newer from https://nodejs.org and run this again.
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  echo TraceMask needs Node.js 22.13 or newer. You have:
  node -v
  pause
  exit /b 1
)
start "" http://localhost:4390
node --no-warnings=ExperimentalWarning server\index.js
pause
