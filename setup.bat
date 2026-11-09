@echo off
title COLDEST Merge Engine - Setup
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed.
  echo Install the "LTS" version from https://nodejs.org  then double-click setup.bat again.
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  echo.
  echo Your Node.js is too old. Install the current LTS from https://nodejs.org and try again.
  pause
  exit /b 1
)
echo Installing (this takes a minute)...
call npm install
if errorlevel 1 ( pause & exit /b 1 )
if not exist .env (
  copy .env.example .env >nul
  echo Created your settings file: .env
)
echo.
echo Running the automated tests...
call npm test
echo.
echo ============================================================
echo  Setup finished.
echo  Next: open the file ".env" with Notepad and fill in your keys.
echo  (Step 3 in README.md)
echo ============================================================
pause
