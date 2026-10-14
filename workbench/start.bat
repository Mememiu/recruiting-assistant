@echo off
rem 招聘工作台 —— 双击这个文件即可启动（Windows）
rem 停止服务：在弹出来的终端窗口里按 Ctrl + C

cd /d "%~dp0" || exit /b 1

where node >nul 2>nul
if errorlevel 1 (
  echo [X] 没找到 node 命令。
  echo     如果 Node 装在别处，把本文件最后一行的 node 改成完整路径。
  pause
  exit /b 1
)

echo 招聘工作台启动中...
echo 启动后请在浏览器访问： http://127.0.0.1:8771
echo 停止服务：在这个窗口按 Ctrl + C
echo.

node server.js

pause
