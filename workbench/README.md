# 招聘工作台

此目录是本地工作台源码。安装、数据隔离、启动和验证说明见仓库根目录的 [`README.md`](../README.md)。

## 启动

- **macOS / Linux**：`sh start.command`（或双击）
- **Windows**：双击 `start.bat`（或命令行运行）
- 任意平台手动启动：`node server.js`（在本目录运行），访问 <http://127.0.0.1:8771/>

数据目录由 `config.json` 相对工作台目录解析；密钥只放在 Git 忽略的 `config.local.json`。

## 晨报（morning.js）

手动运行：`node morning.js`。做三件零风险的事：拉取今日未读（只读 boss 命令）→ 生成日报（数字本地算 + 便宜模型写分析）→ 系统通知（macOS osascript / Windows toast，其他平台只写日志）。

定时启用建议用系统自带调度器（默认不启用）：macOS 用 launchd，Windows 用「任务计划程序」，每天上班前跑一次。拉未读会弹出一个 Chrome 窗口 —— 正常现象，任务结束后浏览器常驻（登录态保留）。

## 测试

`node --test test/*.test.js`（仓库根目录跑也行：`node --test workbench/test/*.test.js`）。CI 在 ubuntu / macos / windows 三个平台各跑一遍。

## boss 可执行性诊断（新环境/换平台后跑一次）

```bash
node workbench/doctor.js
```

只读检查三件事：PATH 里能否找到 boss、工作台的调用方式能否真的跑起来、`boss version` 是否正常响应。任何一步失败都会给出具体原因和修法。**首次在 Windows 上使用、或换了 boss 安装位置后，先跑这个**——它把"工作台调不动 boss"这类问题在 5 秒内定位到是 PATH、spawn 还是登录态。

前端是 `public/` 中的静态文件，服务端仅使用 Node.js 内置模块。macOS 在线简历 OCR 代码在 `bin/ocr-resume.swift`（Windows/Linux 无此依赖，截图照存，只是没有文字识别）。

## AI API 配置

工作台“设置”页可以配置任意 OpenAI 兼容 API；模型列表和计费规则取决于所配置的服务商：

- `baseUrl`：服务商的 OpenAI 兼容 API 地址，通常以 `/v1` 结尾
- `model` / `cheapModel`：填服务商返回的模型 ID；如果服务商提供免费或零价格模型，可在设置页筛选
- `apiKey`：只写入本机 `config.local.json`，GET 接口不会返回完整值
- `reasoningEffort`：如果模型不支持该参数，请选择“关闭”
- `outreach.minStars`：打招呼任务的最低评级（1-3）

保存后可以点“测试连接”。也可以让 agent 通过以下接口协助：

- 读取：`GET /api/ai/config`
- 保存：`POST /api/ai/config`
- 测试：`POST /api/ai/test`

以上接口仍受工作台本地 Origin 和变更 token 规则保护。
