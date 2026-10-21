# 招聘 Assistant

一个围绕真实岗位要求工作的 AI 招聘助手，协助把岗位梳理、寻找候选人、简历初筛、跟进和招聘复盘连成一条线。它负责整理信息、提供有依据的建议；录用判断和对外动作仍由招聘负责人决定。

## 能做什么

- **梳理岗位**：穷尽原则，通过连续问答明确硬性要求、关键能力和排除信号，整理对外职位描述与内部寻访思路。
- **处理未读**：进入 BOSS 平台按岗位查看新消息和候选人简历，保留沟通与跟进历史；可清空本地待办，不影响平台消息。
- **主动寻访**：从搜索和推荐入口寻找候选人，结合岗位标准初筛、去重，并持续改进搜索关键词，单候选人用时30s内（由接入的大模型决定）
- **评估简历**：对照已确认的标准给出证据、匹配建议和待验证点；看不出来的内容明确说不确定，不凭空补全。
- **管理候选人进展**：维护台账、候选人池、跟进记录和面试档案；过期人选可按条件从台账清理，并按批次恢复。
- **盘点与复盘**：分析岗位的人才供给、薪资和目标公司，汇总招聘进展与待决策事项。

**每天开工只需一句话**：说「处理今天的招聘」或「今天干什么」——驾驶舱（`recruit-today`）会只读扫描
工作区现状（在招岗位 / 台账人数 / 未读待办 / 搜索经验），按优先级输出一张决策卡，
每条建议后面直接给一句可复制的话。不用记任何流程名，照着说就行。工作台首页「今日」页是
同一份数据的可点版本（点「→ 在工作台打开」直达对应任务页）。驾驶舱不执行任何动作，只决定今天从哪开始。

**前置依赖**：Node ≥ 20、本机 Chrome/Edge、`boss-cli`（`npm install -g @joohw/boss-cli`，然后 `boss login` 扫码登录）。飞书可选。装好后跑 `node workbench/doctor.js` 确认能被调用。

可以和安装了skill的agent直接说“帮我梳理这个岗位”“只看某个岗位的未读”“看看这份简历是否符合要求”或“出一份今天的招聘日报”，或者在基于此搭建的工作台直接进行操作（已经自带工作台的搭建流程）。

## 协作边界

助手目前不会自行在招聘平台点“不合适”以及给候选人发消息、安排面试或发 offer。初筛标准以使用者确认后的梳理完成的岗位要求为准，AI 建议不是最终决定。

本仓库保存助手程序和通用流程；候选人简历、聊天记录、招聘台账、浏览器登录态和 API key 不随仓库上传。实际招聘数据保留在使用者自己的工作区。

**飞书是可选的**：不装 `lark-cli` 完全不影响招聘主流程——日报落本地 Markdown、约面试输出手动建会清单（任何会议工具都行）、简历直接丢本地文件。所有飞书能力（云文档 / IM 卡片 / 邮箱收简历 / 日历日程）都收在 `optional/` 目录，主线文档只留指针，不用就不读。详见 [optional/README.md](optional/README.md)。

建议搭配ai工具：codex、workbuddy等生成本地工作台，部署云端容易失效

## 支持平台

| 组件 | macOS | Windows | Linux |
|---|---|---|---|
| skills 流程（agent 直接执行 boss/lark-cli 命令） | ✅ | ✅ | ✅ |
| 工作台（Web UI） | ✅ | ✅（`start.bat` 双击启动） | ✅ |
| 工作台晨报（morning.js） | ✅ | ✅ | 无通知（仅日志） |
| 在线简历 OCR（工作台内） | ✅ Apple Vision（免安装） | ✅ RapidOCR（跑一次 `install-ocr.bat`） | ✅ RapidOCR（跑一次 `install-ocr.sh`） |

**在线简历 OCR**：把简历截图里的文字提出来，供后续初筛使用。三条引擎按平台自动选择：

| 引擎 | 用在哪 | 说明 |
|---|---|---|
| Apple Vision | macOS | 系统自带，亚秒级，无需安装 |
| **RapidOCR** | Windows / Linux（macOS 可作备选） | 开源、本地、免费、免密钥；用的是 PaddleOCR 的中文模型 |
| 百度 OCR API | 可选 | 需自己配密钥，一般用不上 |

首次使用装一次依赖（约 200MB，走国内镜像）：

```bash
# Windows：双击 workbench\install-ocr.bat
# macOS / Linux：
sh workbench/install-ocr.sh
```

装在 `workbench/.venv-ocr/`（独立虚拟环境，不污染系统 Python）。没装也能用工作台，只是简历只存原图、不提取文字。单份识别约 30 秒（CPU）。

**Windows 注意**：`boss-cli` 在 Windows 上是 `boss.cmd`，工作台已通过 `cmd /c` 适配；npm 全局目录请确认在 PATH 中（通常 `%APPDATA%\npm`）。BOSS 平台的反检测在 Windows + 无头 Chrome 下的表现**未经实测**，首次使用务必先跑一次 `boss login` + `boss list --unread` 验证（依据：Boss 曾有账号因无头被限 24 小时，见 `skills/recruit-daily/references/channels.md`）。

**换环境/换平台后**，先跑 `node workbench/doctor.js`（5 秒只读诊断）：它会检查 PATH 里能否找到 boss、工作台的调用方式能否跑起来、`boss version` 是否正常，任一步失败都给出具体修法。

正在完善功能：话术库：实现候选人回聊、追聊，要简历——简历入库。

PS：需要接入ai api方可运作工作台，不需要工作台形式可以借助安装了的ai工具一步步执行。

## 开机自启（可选）

工作台是本地 Node 进程，**重启电脑后不会自己起来**，网址打不开是正常现象。想让它登录后自动运行：

```powershell
双击 workbench\install-autostart.bat
```

它会往当前用户的「启动」文件夹写一个最小化启动项（不需要管理员权限，只影响当前用户）；注销自启运行 `install-autostart.bat --uninstall`，或 Win+R 输入 `shell:startup` 手动管理。手动方式也一样：把 `start.bat` 的快捷方式拖进 `shell:startup` 打开的文件夹。

注意：自启拉起的是工作台本身；BOSS 登录态（`boss login`）的有效性与是否自启无关，过期了仍需手动扫码。

## 登录等待

上游 `boss login` 打开登录页后会立即返回，不负责等待扫码。需要由 agent 等待时，请运行：

```powershell
node workbench\boss-login-wait.js
```

脚本会先检查登录态；未登录时打开登录窗口，并轮询 `boss list --unread` 直到登录成功（默认最多 10 分钟）。

## boss-cli 推荐去重补丁

上游推荐页的卡片根节点选择器会同时匹配嵌套节点，导致同一页输出重复。运行：

```powershell
node workbench\patch-boss-cli.js
```

补丁只修改本机安装的 `@joohw/boss-cli` 解析代码；执行 `boss update` 后请重新运行一次。

## 未读列表增强

`boss list --unread` 现在会：

- 自动滚动 `.user-list`，直到列表连续两次不再增长；
- 输出每条候选人的稳定 ID（`id:...`）；
- 后续打开会话优先使用 `boss chat --id <稳定ID>`，避免新消息插入导致序号移动。

补丁由 `node workbench\patch-boss-cli.js` 应用，`boss update` 后重新执行。
