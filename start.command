#!/bin/zsh
# 双击启动当前开发副本；工作台使用当前目录的数据和 8771 端口。
cd "$(dirname "$0")" || exit 1
exec ./workbench/start.command
