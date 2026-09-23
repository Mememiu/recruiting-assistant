# 招聘工作台

此目录是本地工作台源码。安装、数据隔离、启动和验证说明见仓库根目录的 [`README.md`](../README.md)。

启动命令：`node workbench/server.js`（从仓库根目录运行），访问 <http://127.0.0.1:8771/>。数据目录由 `config.json` 相对工作台目录解析；密钥只放在 Git 忽略的 `config.local.json`。

前端是 `public/` 中的静态文件，服务端仅使用 Node.js 内置模块。macOS 在线简历 OCR 代码在 `bin/ocr-resume.swift`。测试位于 `test/`，运行 `node --test workbench/test/*.test.js`。
