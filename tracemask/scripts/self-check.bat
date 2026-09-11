@echo off
title TraceMask live self-check
cd /d "%~dp0.."
if not exist reports mkdir reports
set TARGETS=%*
if "%TARGETS%"=="" set TARGETS=canva.com dominos.co.in myntra.com
echo Scanning %TARGETS% live... (report: reports\self-check-report.txt)
node --no-warnings=ExperimentalWarning server\self-check.js %TARGETS% --json reports\self-check-scans.json > reports\self-check-report.txt 2>&1
type reports\self-check-report.txt
echo.
echo Running security probe against the local server (if it is running)...
node tests\security-probe.mjs > reports\security-probe-report.txt 2>&1
type reports\security-probe-report.txt
pause
