@echo off
chcp 65001 >nul
cd /d "%~dp0"
title SECOND TAKE studio
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed. Install Node.js 22 LTS or newer from https://nodejs.org and run this again.
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  echo [ERROR] Node.js 22.13 or newer is required. Current version:
  node -v
  pause
  exit /b 1
)
where ffmpeg >nul 2>nul
if errorlevel 1 echo [WARN] FFmpeg not found on PATH. The studio opens, but new videos cannot be rendered.
if not exist storage\app.db node --disable-warning=ExperimentalWarning src\cli.js demo
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3000"
echo Studio running at http://localhost:3000  (close this window to stop)
node --disable-warning=ExperimentalWarning src\web\server.js
pause
