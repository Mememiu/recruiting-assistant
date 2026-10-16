# HANDOFF.md — 交接文档（给下一个接手本仓库的 agent）

> 本文件记录 **2026-10-11 ~ 10-15** 这一整轮对 recruiting-assistant 做的审计、修复与改造。
> 读它之前不需要任何上下文；读完即可安全地继续开发。

---

## 一、这个仓库是什么

**Mememiu/recruiting-assistant** —— 一套围绕真实岗位标准工作的 AI 招聘助手，目标平台是 BOSS 直聘。

### 两种使用形态

| 形态 | 入口 | 说明 |
|---|---|---|
| **Skills 流程** | 把 `skills/` 装进支持 skill 的 agent（Codex / Claude Code / Qoder），对话里说人话触发 | 无 UI，agent 按文档一步步执行 `boss` / `lark-cli` 命令 |
| **工作台** | `workbench/`（零依赖 Node 服务），`start.bat` 双击 → http://127.0.0.1:8771 | 按钮化操作，与 skills 共享同一套数据格式和事实源 |

两种形态共享数据：都在用户自己的工作区文件夹里读写同一批文件。

### 主流程

```
recruit-init（一次）→ recruit-grill（每岗一次）→ recruit-daily（每天循环）
```

### 8 个 skill（`skills/`）

`recruit-init` 初始化工作区 / `recruit-grill` 逐岗逼问梳理标准 / `recruit-daily` 每日流水线 / `recruit-today` 驾驶舱（本轮新增）/ `ask-guide` 流程总目录 / `resume-review` 简历收取评估 / `interview-schedule` 面试预约 / `market-talent-mapping` 市场盘点

### 唯一真值源

`CONTEXT.md` —— 术语、初筛硬规则、在招岗位与优先级。所有 skill 文档**不抄数字**，冲突以 CONTEXT 为准。

---

## 二、这一轮做了什么（四个批次，全部已合入 main）

### 批次 1：P0 安全修复 + Windows 支持

| 问题 | 修复 |
|---|---|
| **路径穿越**：`/api/candidate`、`/api/report/read` 用 `../` 可读工作区外任意 `.md` | 加 `safeFileIn()` 限定在各自目录内 |
| **CSRF**：所有 POST 端点接受无预检的 text/plain，任意网页可驱动本地 API | 加 `allowMutation()`：需自定义头或同源 Origin |
| **模板列集静默丢数据**：官方 9 列台账缺 `硬门槛`/`AI建议`，`indexOf` 返回 -1，写入被 CSV 序列化丢弃且无报错 | 两个任务跑前校验缺列并明确报错；模板扩成完整 16 列 |
| **greet 按姓名定位错行**：同名不同岗更新错行 | 改按 `姓名+应聘岗位` 定位 |
| **morning.js 必崩**：ctx 缺 `inbox` | 补上，全流程实测跑通 |
| **Windows 跑不起来**：npm 全局装的是 `boss.cmd`，Node 无 shell 直接 spawn `.cmd` 会 EINVAL | `runner.js` 走 `cmd /c`；`childEnv` 用 `path.delimiter` + `%APPDATA%\npm`；测试桩按平台形态 |

### 批次 2：`recruit-today` 驾驶舱

**动机**：7 个 skill × ~8 处触发语（57 处自然语言入口）+ 10 个工作台按钮，全是并列的，没有任何东西读状态回答"今天该干什么"。

**做法**：加一个只读扫描，把状态变成决策卡。

- `workbench/lib/today-scan.js` —— 共享实现，只读扫描 CONTEXT.md / 台账 / inbox.json / 关键词迭代表
- `skills/recruit-today/scripts/today-scan.js` —— 对话形态入口
- 工作台 `/api/today` + 首页「今日」面板 —— 可点版本，带「→ 在工作台打开」跳转

**设计纪律**：驾驶舱**不执行任何动作**，只给建议。动作走各自原有的票据/授权流程。

### 批次 3：飞书裁剪

飞书触点从 11 个文件 43 行，收拢到 `optional/`（232 行，一字未删）。主线只留指针。不用飞书时 agent 永远不读 `optional/`。

### 批次 4：从私有 fork 切到上游 boss-cli

**背景**：原用的私有 fork `boss-engine-local 0.8.1` 在机器上丢失，改用公开上游 `@joohw/boss-cli` 0.6.6。

**关键差异**（对着真实 `boss help` 逐条核对，不是照记忆改）：

| 能力 | 私有 fork | 上游 0.6.6 | 处理 |
|---|---|---|---|
| `search` 筛选 | `--age/--degree/--city/--job` 一堆 | ❌ 只有关键词 | 代码改成只传关键词；筛选改用 `recommend --job` 收窄 |
| `greet` | `--index`/`--dry-run`（搜索池按序号打） | ❌ 只有 `greet <姓名>` | 去掉搜索池打招呼，统一走推荐池 |
| `deep-search` | — | ✅ 有 | 补进文档（新能力） |

`buildSearchCmd` 已改成只拼关键词；前端删掉年龄/学历输入框；`channels.md` 整节重写。

---

## 三、main 上的提交（3 个）

```
3f3a9b4  Adapt to upstream @joohw/boss-cli 0.6.6 (drop private-fork dependencies)
abd31ea  Windows 支持 + recruit-today 驾驶舱 + 飞书流程移至 optional/ (#1)
53630fc  Add unread and ledger cleanup controls（合并前 main 原有）
```

PR #1 已 squash 合并（abd31ea），分支已删。CI 三平台（ubuntu / windows / macos）全绿。

---

## 四、验证状态（诚实交代）

| 项目 | 状态 |
|---|---|
| P0 三个 bug | ✅ 修前复现、修后验证 |
| 路径穿越 / CSRF | ✅ 用真实起服务的 curl 验证（跨源 POST → 403；`../../probe-secret` → 404） |
| Windows spawn | ✅ 实测中文参数无损；端到端票据 → `cmd /c boss search` 跑通并落盘 |
| 驾驶舱 | ✅ 两种形态输出一致；边界情况（未初始化/台账缺失）给可操作警告 |
| 飞书裁剪 | ✅ 无断链；主线飞书引用 43→31 行，剩余都是指针或"可选"标注 |
| **boss-cli 平台反检测** | ❌ **未验证** —— 只能真实账号跑 `boss login` + `boss list --unread` |

---

## 五、关键设计决策（改代码前必读）

1. **三条不可协商规则**：工作台只监听 127.0.0.1 / 任务必须票据确认 / 改台账前必备份。票据 5 分钟过期、用过即废，不提供"总是允许"。
2. **真值分离**：`CONTEXT.md` 是唯一事实源，skill 文档不抄数字。
3. **不可逆动作边界**：点"不合适"、打招呼、建日程、发 offer 全部等确认。授权只管本轮，跨轮不延续。
4. **去重键 = 姓名+应聘岗位**：同一人换岗可重复打；同名歧义不能默认选第一人。
5. **本地文件是唯一事实源**：飞书云文档等只是对外视图，从台账同步生成。
6. **许可双轨**：主代码 MIT；`boss-cli/` 子目录 GPL-3.0（上游传染），工作台通过子进程调用保持分离。

---

## 六、如果继续开发

### 改工作台代码
- 测试：`node --test workbench/test/*.test.js`（从仓库根跑）
- 语法：`for f in workbench/server.js workbench/morning.js workbench/lib/*.js; do node --check $f; done`
- 改了记得推分支 + 建 PR，别直接推 main（CI 会自动跑三平台）

### 改 skill 文档
- 格式约定见各 SKILL.md 的 frontmatter（name + description 触发词）
- `channels.md` 的权威是 `boss help`，不是记忆
- 飞书相关流程都在 `optional/lark-integration.md`

### 诊断 boss 可用性
```bash
node workbench/doctor.js
```
只读，不碰 BOSS、不改文件。PATH 找不到 boss 时会给出排查提示。

### 待验证事项
- **boss-cli 在 Windows + 真实账号下的反检测表现**：spawn 层已验证（中文参数无损、命令合法执行），但 BOSS 平台对真实账号的风控只能实跑。跑前先 `boss login` + `boss list --unread`。
- 上游 search 无筛选参数，若搜索效率明显不如以前，可考虑给上游提 PR 补筛选，或等其完善。

---

## 七、产物清单（交付物位置）

| 文件 | 位置 | 说明 |
|---|---|---|
| patch | `C:\Users\Administrator\AppData\Local\recruiting-assistant-full.patch` | 批次 1+2+3 完整 diff（基于合并前 main） |
| bundle | `C:\Users\Administrator\AppData\Local\recruiting-assistant-full.bundle` | 同上的 git bundle，可 `git fetch` 取分支 |
| PR | https://github.com/Mememiu/recruiting-assistant/pull/1 | 已合并 |

本地 clone 在 `$TMPDIR/recruit-review`（临时目录，可能被清理）。要长期使用请重新 clone 到稳定位置。
