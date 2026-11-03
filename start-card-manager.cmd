@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0rhodes-pvp-v98"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 or newer first.
  pause
  exit /b 1
)
set CARD_MANAGER_OPEN=1
node tools\card-manager.js
pause
