@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo 找不到 Node.js，請先安裝：https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo 第一次使用，正在安裝套件…
  call npm install
  if errorlevel 1 (
    echo 安裝失敗
    pause
    exit /b 1
  )
)

echo 正在啟動萬用下載器…
echo 瀏覽器會自動開啟 http://127.0.0.1:8787
echo 關掉這個視窗 = 停止下載器
echo.
set OPEN_BROWSER=1
call npm start
pause
