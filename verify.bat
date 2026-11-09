@echo off
title COLDEST API check (read-only)
cd /d "%~dp0"
call npm run verify-api
pause
