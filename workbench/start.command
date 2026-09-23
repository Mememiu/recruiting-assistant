#!/bin/zsh
# 招聘工作台 —— 双击这个文件即可启动
# 停止服务：在弹出来的终端窗口里按 Ctrl + C

cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "❌ 没找到 node 命令。"
  echo "   如果 Node 装在别处，把本文件最后一行的 node 改成完整路径。"
  read -k1 "?按任意键退出…"
  exit 1
fi

echo "招聘工作台启动中…"
echo "启动后请在浏览器访问： http://127.0.0.1:8771"
echo "停止服务：在这个窗口按 Ctrl + C"
echo

node server.js
