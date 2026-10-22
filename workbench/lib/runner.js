'use strict';
/**
 * 任务执行器 —— 带确认票据与命令白名单
 *
 * 这是工作台第一次被允许调 boss 命令，三条硬规则改代码时不能破：
 *
 *  1. 命令白名单是**硬编码**的。不在名单里的子命令一律拒绝，
 *     即便前端被改、即便请求伪造——因为校验在后端。
 *  2. 执行必须凭**一次性票据**（token）：先 preview 拿票 → 用户确认 → 才跑。
 *     票据 5 分钟过期，用过即废。不提供"总是允许"。
 *  3. 任务**串行**，同一时刻只跑一个（多个 Chrome 抢同一个调试端口会互相干扰）。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const IS_WIN = process.platform === 'win32';
const SHELL_META = /[\r\n\0&|<>^%!"]/;
function assertSafeArg(value, label = '参数') {
  const s = String(value ?? '');
  if (SHELL_META.test(s)) throw new Error(label + '包含 shell 元字符，已拒绝');
  return s;
}

// ── 白名单：只允许这些
const ALLOWED_SUBCOMMANDS = ['list', 'chat', 'recommend', 'search', 'greet', 'help', 'version', 'shutdown'];

/**
 * 双保险：即使子命令合法，参数里出现这些也直接拒绝。
 *
 * 2026-09-22 加固：boss-cli 0.8.1 新增了 `boss send`（发消息）和
 * `boss action request-attachment-resume`（求简历）——都是**对外不可逆动作**。
 * 白名单本来就把它们挡在外面（不在 ALLOWED 里就是拒），这里是第三层：
 * 万一以后有人往白名单加了 search/list，参数里混进这些词也照样拦。
 */
const FORBIDDEN_ARGS = ['resume', 'greet', '不合适', 'action', 'send',
  'request-attachment', 'agree-resume', 'not-fit', 'remark', 'wechat'];

const TICKETS = new Map();   // token -> { task, created, used }
const TICKET_TTL = 5 * 60 * 1000;
let STATE = { running: false, task: null, current: 0, total: 0, logs: [], done: false, ok: null };
let batchControl = null;
/** 支持暂停/取消的批量任务：文本初筛（ai-screen-batch）与多模态复核（vision-review）。 */
const BATCH_AI_TASKS = ['ai-screen-batch', 'vision-review'];

/** 让子进程一定能找到 boss（~/.local/bin 不一定在当前 PATH 里） */
function childEnv() {
  const home = os.homedir();
  const sep = path.delimiter;                       // Windows 是 ';'，POSIX 是 ':'
  const extra = IS_WIN
    ? [path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm'),
       path.join(home, '.local', 'bin')]
    : [path.join(home, '.local', 'bin'), '/usr/local/bin', '/usr/bin', '/bin'];
  const nodeDir = path.dirname(process.execPath);
  return { ...process.env, PATH: [...new Set([...(process.env.PATH || '').split(sep), nodeDir, ...extra])].join(sep) };
}

/**
 * 跨平台执行 boss。
 * Windows 上 npm 全局装出来的是 boss.cmd，Node 无 shell 直接 spawn 会 EINVAL
 * （Node 18.20.2+ 起的修复：不再把 .cmd/.bat 直接交给 CreateProcess），
 * 所以 Windows 走 cmd /c；POSIX 维持原样。
 */
/** 切命令：要认得引号，否则关键词里有空格会被拆成两个参数 */
function splitCmd(s) {
  const out = [];
  let cur = '';
  let q = false;
  for (const c of String(s)) {
    if (c === '"') { q = !q; continue; }
    if (c === ' ' && !q) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += c;
  }
  if (q) throw new Error('命令引号未闭合，已拒绝');
  if (cur) out.push(cur);
  return out;
}

function runArgs(argv, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const parts = argv.map((v) => assertSafeArg(v));
    if (!parts.length) return resolve({ out: '', err: '命令为空', code: -1 });
    const bin = IS_WIN ? 'cmd' : parts[0];
    const args = IS_WIN ? ['/d', '/s', '/c', parts[0], ...parts.slice(1)] : parts.slice(1);
    const p = spawn(bin, args, { env: childEnv(), shell: false });
    let out = '', err = '';
    const t = setTimeout(() => { try { p.kill(); } catch {} resolve({ out, err: err + '\n[超时]', code: -1 }); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => { clearTimeout(t); resolve({ out, err, code }); });
    p.on('error', (e) => { clearTimeout(t); resolve({ out, err: String(e.message || e), code: -1 }); });
  });
}

function runOne(cmd, timeoutMs = 60000) {
  try {
    const parts = splitCmd(cmd);
    for (const part of parts) assertSafeArg(part);
    return runArgs(parts, timeoutMs);
  } catch (e) {
    return Promise.resolve({ out: '', err: String(e.message || e), code: -1 });
  }
}

function runBoss(args, timeoutMs = 60000) {
  return runArgs(['boss', ...args], timeoutMs);
}

function validate(cmd, task) {
  // 内部 AI 动作（ai: 文本初筛、vision: 多模态复核）：不碰招聘平台，白名单不管它
  // （它们有自己的记录与确认）。这两类前缀都由代码拼装，不含用户输入。
  const isInternalAI = String(cmd).startsWith('ai:') || String(cmd).startsWith('vision:');
  try {
    if (!isInternalAI) {
      const parts = splitCmd(cmd);
      for (const part of parts) assertSafeArg(part);
    }
  } catch (e) {
    return { ok: false, why: e.message };
  }
  if (isInternalAI) return { ok: true };
  // 仅未读沟通与简历任务可调用这个固定的只读截图动作，绝不放开通用 action。
  if (['inbox-chat', 'inbox-resume', 'inbox-resume-role'].includes(task) && cmd === 'boss action resume') return { ok: true };
  const parts = String(cmd).trim().split(/\s+/);
  if (parts[0] !== 'boss') return { ok: false, why: '只允许 boss 命令' };
  const sub = (parts[1] || '').replace(/^-+/, '');
  if (!ALLOWED_SUBCOMMANDS.includes(sub)) {
    return { ok: false, why: `子命令不在白名单：${sub}（允许：${ALLOWED_SUBCOMMANDS.join('/')}）` };
  }
  const rest = parts.slice(2).join(' ');
  for (const bad of FORBIDDEN_ARGS) {
    if (rest.includes(bad)) return { ok: false, why: `参数含禁用词：${bad}` };
  }
  return { ok: true };
}

/**
 * 简历文字识别：macOS 用系统 Apple Vision（亚秒级）；其余平台用 RapidOCR（本地、免密钥）。
 * 两者契约一致：stdout 输出按阅读顺序的文字行，exit 0 表示成功。
 * RapidOCR 单份约 30 秒，超时给足余量。
 */
const OCR_TIMEOUT_MS = 180000;

function pythonOcrCommand(file) {
  const venvPy = IS_WIN
    ? path.join(__dirname, '..', '.venv-ocr', 'Scripts', 'python.exe')
    : path.join(__dirname, '..', '.venv-ocr', 'bin', 'python');
  const py = fs.existsSync(venvPy) ? venvPy : (IS_WIN ? 'python' : 'python3');
  return { bin: py, args: [path.join(__dirname, '..', 'bin', 'ocr-resume.py'), file] };
}

/**
 * 压缩简历截图给视觉模型用：BOSS 的截图是超长 PNG（713x4970），直接 base64 会到 1.5MB，
 * 多半被接口拒掉或传得很慢。压成 640 宽的 JPEG 再发。
 */
function pythonPrepCommand(src, dst) {
  const venvPy = IS_WIN
    ? path.join(__dirname, '..', '.venv-ocr', 'Scripts', 'python.exe')
    : path.join(__dirname, '..', '.venv-ocr', 'bin', 'python');
  const py = fs.existsSync(venvPy) ? venvPy : (IS_WIN ? 'python' : 'python3');
  return { bin: py, args: [path.join(__dirname, '..', 'bin', 'prep-image.py'), src, dst] };
}

function recognizeResume(file) {
  const run = (spec, allowFallback) => new Promise((resolve) => {
    const p = spawn(spec.bin, spec.args, { shell: false });
    let out = '', err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch {} resolve({ ok: false, error: '简历文字识别超时' }); }, OCR_TIMEOUT_MS);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => {
      clearTimeout(timer);
      // macOS 装了 Xcode Command Line Tools 才有 swift；没有就退回 Python 识别
      if (allowFallback && e.code === 'ENOENT') return resolve(run(pythonOcrCommand(file), false));
      resolve({ ok: false, error: e.message });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 3) return resolve({ ok: false, error: err.trim() || '缺少 OCR 依赖，请先运行 workbench/install-ocr' });
      resolve({ ok: code === 0, text: out.trim(), error: err.trim() });
    });
  });

  return process.platform === 'darwin'
    ? run({ bin: 'swift', args: [path.join(__dirname, '..', 'bin', 'ocr-resume.swift'), file] }, true)
    : run(pythonOcrCommand(file), false);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 任务定义

const report = require('./report');
const { screen: aiScreen, vision: aiVision, loadCfg } = require('./ai');
const { reviewResume, hardgateVerdict } = require('./resume-review');

function chatArgs(item) {
  return item.remoteId ? ['chat', '--id', item.remoteId] : ['chat', item.name];
}

function chatCommandString(item) {
  return item.remoteId ? `boss chat --id "${item.remoteId}"` : `boss chat "${item.name}"`;
}

function unreadResumeTargets(ctx) {
  const role = String(ctx.opts.role || '');
  if (!role) throw new Error('请先选择一个应聘岗位。');
  return ctx.inbox.list().items.filter((item) => item.role === role && !item.handled && !item.resume && !item.chatBlocked);
}

async function captureInboxResume(ctx, item, logs) {
  const current = ctx.inbox.chatTarget(item.id, item.signature);
  const chat = await runBoss(chatArgs(current), 60000);
  if (chat.code !== 0) throw new Error(chat.err || '打开会话失败。');
  ctx.inbox.saveChat(current.id, current.signature, chat.out);
  logs.push(`已核对 ${current.name} · ${current.role} 的会话`);
  const result = await runOne('boss action resume', 90000);
  if (result.code !== 0) throw new Error(result.err || '在线简历截图失败。');
  const match = result.out.match(/截图文件：([^\r\n]+\.png)/);
  const source = match && path.resolve(match[1].trim());
  const expectedDir = path.join(os.homedir(), '.boss-cli', '.cache', 'resume-screenshots');
  if (!source || path.dirname(source) !== expectedDir || !path.basename(source).startsWith(`online-resume-${current.name}-`)) {
    throw new Error('简历截图未能与候选人姓名核对，请在 BOSS 人工核实，未归档。');
  }
  if (!fs.statSync(source).isFile()) throw new Error('截图文件不存在。');
  const dir = path.join(ctx.dataHome, 'runtime', 'resumes', 'inbox');
  fs.mkdirSync(dir, { recursive: true });
  const file = `${current.id}-${crypto.randomUUID()}.png`;
  const dest = path.join(dir, file);
  fs.copyFileSync(source, dest);
  fs.chmodSync(dest, 0o600);
  const ocr = await recognizeResume(dest);
  ctx.inbox.saveResume(current.id, current.signature, file, ocr.ok ? ocr.text : '');
  if (ocr.ok && ocr.text.length >= 30) {
    const review = reviewResume({ role: current.role, resume: ocr.text, conversation: chat.out, dataHome: ctx.dataHome });
    ctx.inbox.saveReview(current.id, current.signature, { text: review, model: '本地规则' });
    logs.push(`${current.name}：简历原图、${ocr.text.length} 字识别结果及本地线索已保存。`);
  } else {
    logs.push(`${current.name}：原图已保存，文字识别未完成（${ocr.error || '正文不足'}）。`);
  }
  return { ok: true, hasText: !!(ocr.ok && ocr.text) };
}

/**
 * 拼 boss search 命令（上游 @joohw/boss-cli）。
 * 上游 search 只接受 [关键词]，没有筛选参数 —— 年龄/学历/岗位等筛选在搜索页做不了，
 * 交给推荐池的 --job（recommend/greet 都接 --job）来收窄。硬规则初筛在拿到列表后本地做。
 * 值可能含空格，加引号。
 */
function buildSearchCmd(ctx, s) {
  const kw = String(s.keyword || '').trim();
  if (!kw) return null;
  return `boss search "${assertSafeArg(kw, '搜索关键词')}"`;
}

/** 本地日期（YYYY-MM-DD）：同一天的判定用用户时区，不用 UTC——凌晨打的招呼不能算成昨天 */
function localDateStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 打招呼候选名单：只按本机配置的评级阈值选已通过的推荐池人选，且今天已打过的跳过。 */
function greetTargets(ctx) {
  const minStars = ctx.outreach?.minStars;
  if (!Number.isInteger(minStars) || minStars < 1 || minStars > 3) {
    throw new Error('请先在本地配置打招呼的最低评级（1-3 星）。');
  }
  const { header, rows } = ctx.readLedger();
  // 缺列时 indexOf = -1 会让同日去重静默失效——宁可报错让人加列，也不能假装保护生效
  if (header.indexOf('最后打招呼时间') < 0) {
    throw new Error('台账缺少「最后打招呼时间」列，请在表头补上（见 skills/recruit-daily/references/ledger-and-report.md）再跑。');
  }
  const iRating = header.indexOf('评级'), iStatus = header.indexOf('状态');
  const iSource = header.indexOf('来源轮次'), iName = header.indexOf('姓名');
  const iRole = header.indexOf('应聘岗位');
  const iGreet = header.indexOf('最后打招呼时间');
  const today = localDateStr();
  return rows
    .map((r) => ({
      name: r[iName], role: r[iRole],
      stars: ((r[iRating] || '').match(/⭐/g) || []).length,
      status: r[iStatus], source: r[iSource] || '',
      greetedAt: String(r[iGreet] || '').trim(),
    }))
    .filter((t) => t.stars >= minStars && t.status === '初筛通过' && t.source.includes('推荐'))
    .filter((t) => t.greetedAt !== today);   // 同一天内打过的，这天不再打（隔天可再试）
}

const TASKS = {
  /** 生成今日日报：数字本地算，模型只写分析 */
  'daily-report': {
    label: '生成今日日报',
    desc: '把台账现状汇总成中文日报，存到 runtime/reports/。'
      + '**数字全部在本地统计**（模型算数不靠谱），模型只写分析段落。'
      + '使用配置的轻量模型。',
    plan: () => [`ai: ${loadCfg().ai.cheapModel || loadCfg().ai.model} × 1 次调用`],
    async execute(ctx, logs) {
      const r = await report.generate(
        { dataHome: ctx.dataHome },
        { stats: ctx.stats, read: ctx.readLedger }
      );
      logs.push(`$ 生成日报 → ${path.basename(r.file)}`);
      if (r.aiOk) {
        logs.push(`模型：${r.model} · token ${(r.usage && r.usage.total_tokens) || '?'} · ${(r.ms / 1000).toFixed(1)}s`);
      } else {
        logs.push('⚠️ 模型分析未生成（日报的数字部分仍然完整）');
      }
      return { ok: true, file: r.file };
    },
  },

  /**
   * 搜索池寻源：按关键词去 BOSS 常规搜索页捞人（上游 @joohw/boss-cli）。
   * 上游 search 只接受关键词，没有年龄/学历等筛选参数 —— 硬规则初筛在拿到列表后本地做。
   */
  'search-pool': {
    label: '搜索池寻源',
    desc: '按关键词去 BOSS 常规搜索页捞人。只读，不打招呼。结果存到 runtime/raw/。'
      + '⚠️ 上游 search 无筛选参数（年龄/学历），需按关键词搜后在本地硬规则初筛；'
      + '要按岗位收窄请用「拉取推荐牛人」。搜索结果姓名打码。',
    plan: (ctx) => {
      const s = (ctx.opts || {});
      const cmd = buildSearchCmd(ctx, s);
      return cmd ? [cmd] : [];
    },
    async execute(ctx, logs) {
      const s = (ctx.opts || {});
      const cmd = buildSearchCmd(ctx, s);
      if (!cmd) { logs.push('没填关键词，未执行。'); return { ok: false }; }
      logs.push('$ ' + cmd);
      const r = await runBoss(['search', String(s.keyword || '').trim()], 120000);
      if (r.code !== 0 && !r.out.trim()) {
        logs.push('执行失败：' + (r.err || ('退出码 ' + r.code)));
        logs.push('（上游 search 只接受 [关键词]，不支持筛选参数；关键词含空格已自动加引号）');
        return { ok: false };
      }
      const dir = path.join(ctx.dataHome, 'runtime', 'raw');
      fs.mkdirSync(dir, { recursive: true });
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
      const file = path.join(dir, `${stamp}-boss-search.txt`);
      fs.writeFileSync(file, r.out, 'utf8');
      const n = (r.out.match(/^\s*-\s*\d+\.\s/gm) || r.out.match(/^\d+\.\s/gm) || []).length;
      logs.push(`抓到 ${n} 条，已存到 runtime/raw/${path.basename(file)}`);
      if (!n) logs.push('（0 条：可能是关键词太窄、筛选太严，也可能是没登录）');
      return { ok: true, count: n, file };
    },
  },

  /**
   * 推荐池寻源：boss recommend（姓名不打码）
   * 策略：拉列表 → 本地/人工筛 → 只给最对口的少数人看简历（boss preview）
   */
  'recommend-pool': {
    label: '拉取推荐牛人',
    desc: '跑 boss recommend 拉推荐池列表（姓名不打码）。'
      + '看完列表再决定给谁看简历，挑最对口的看效率高。'
      + '打招呼发出后不可撤回。',
    plan: (ctx) => {
      const job = (ctx.opts && ctx.opts.job) || ctx.targetRole || '';
      return job ? [`boss recommend "${job}"`] : ['boss recommend'];
    },
    async execute(ctx, logs) {
      const job = (ctx.opts && ctx.opts.job) || ctx.targetRole || '';
      const cmd = job ? `boss recommend "${job}"` : 'boss recommend';
      logs.push('$ ' + cmd);
      const r = await runBoss(job ? ['recommend', job] : ['recommend'], 120000);
      if (r.code !== 0 && !r.out.trim()) {
        logs.push('执行失败：' + (r.err || ('退出码 ' + r.code)));
        return { ok: false };
      }
      const dir = path.join(ctx.dataHome, 'runtime', 'raw');
      fs.mkdirSync(dir, { recursive: true });
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
      const file = path.join(dir, `${stamp}-boss-recommend.txt`);
      fs.writeFileSync(file, r.out, 'utf8');
      const n = (r.out.match(/^\s*-\s*\d+\.\s/gm) || r.out.match(/^\d+\.\s/gm) || []).length;
      logs.push(`抓到 ${n} 人，已存到 runtime/raw/${path.basename(file)}`);
      if (!n) logs.push('（0 人：可能没登录，或该岗位推荐池空了）');
      return { ok: true, count: n, file };
    },
  },

  /**
   * 给合格候选人打招呼（推荐页常规动作，无需逐条确认，打完逐一回报）。
   * 硬条件（代码强制）：本机配置的最低评级、状态=初筛通过、来源=推荐池。
   * 理由：池子里的人列表会重排，不立刻打招呼就会丢 —— 打了才进沟通列表，后续只读筛选手段才解锁。
   */
  'greet-qualified': {
    label: '给合格候选人打招呼',
    desc: '只对「评级达到本机最低标准、状态=初筛通过、来源=推荐池、今天还没打过」的人打招呼；条件在代码里强制。'
      + '发出的是账号默认话术；不可撤回。'
      + '每打成功一人立即回写台账（状态改「已打招呼」+ 最后打招呼时间），中途崩了重跑也不会重复打。',
    plan: (ctx) => greetTargets(ctx).map((t) => `boss greet "${t.name}" --job "${t.role}"`),
    async execute(ctx, logs) {
      const targets = greetTargets(ctx);
      if (!targets.length) {
        logs.push('没有符合本机评级条件的推荐池初筛通过人选（今天已打过的也已跳过）。');
        return { ok: true, count: 0 };
      }
      logs.push(`共 ${targets.length} 人，间隔 3 秒，发出账号默认话术`);
      const { header, rows } = ctx.readLedger();
      const iName = header.indexOf('姓名'), iStatus = header.indexOf('状态');
      const iRole = header.indexOf('应聘岗位');
      const iUpd = header.indexOf('更新时间');
      const iGreet = header.indexOf('最后打招呼时间');
      // 台账去重键是「姓名+应聘岗位」：同一人可同时应聘多个岗位，只按姓名定位会更新错行
      const findRow = (t) => rows.find((x) => x[iName] === t.name
        && (iRole < 0 || String(x[iRole] || '').trim() === String(t.role || '').trim()));
      let ok = 0, fail = 0;
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        STATE.current = i + 1; STATE.total = targets.length;
        const cmd = `boss greet "${t.name}" --job "${t.role}"`;
        logs.push('$ ' + cmd);
        let r = await runBoss(['greet', t.name, '--job', t.role], 60000);
        let out = ((r.out || '') + ' ' + (r.err || ''));
        let bad = /失败|错误|error|未找到|无法|不存在/i.test(out);
        if (r.code !== 0 || bad) {
          await sleep(2000);
          r = await runBoss(['greet', t.name, '--job', t.role], 60000);   // 文档：偶发失败，重试一次
          out = ((r.out || '') + ' ' + (r.err || ''));
          bad = /失败|错误|error|未找到|无法|不存在/i.test(out);
        }
        if (r.code === 0 && !bad) {
          ok++;
          const row = findRow(t);
          if (!row) logs.push(`⚠️ 台账里没定位到「${t.name}（${t.role}）」这一行，状态未改，请手动核对。`);
          else {
            row[iStatus] = '已打招呼';
            if (iGreet >= 0) row[iGreet] = localDateStr();
            if (iUpd >= 0) row[iUpd] = localDateStr();
            // 打招呼不可撤回：每打成功一个立刻落盘，中途崩掉/重跑也不会对同一个人打第二次
            ctx.writeLedger(header, rows);
          }
          logs.push(`${t.name}（${t.role}，${t.stars}）：已打招呼`);
        } else {
          fail++;
          logs.push(`${t.name}（${t.role}）：失败 —— ${out.trim().slice(0, 80)}`);
        }
        await sleep(3000);   // 文档：循环打太快撞列表刷新会偶发失败
      }
      logs.push(`完成：${ok} 人已打招呼${fail ? `，${fail} 人失败（失败的不改状态、不记时间，可重跑）` : ''}`);
      return { ok: fail === 0, count: ok, failed: fail };
    },
  },

  /**
   * 批量 AI 初筛：在工作台内跑，完全不碰 BOSS。
   * 材料 = 台账里已有的免费档案（硬门槛三件套 + 聊天摘要），AI 只写「AI建议」列，不改状态。
   */
  'ai-screen-batch': {
    label: '批量 AI 初筛',
    desc: '对「待初筛」且「AI建议」为空的人，把台账里的免费材料逐个发给配置的 AI 模型，'
      + '按 CONTEXT 硬规则出建议，写入「AI建议」列。**不碰状态、不碰 BOSS 平台，只花 token。**'
      + '每人约 3-4k token，跑完在台账里逐条看、由你决定是否采纳。',
    plan: (ctx) => {
      const { header, rows } = ctx.readLedger();
      const iStatus = header.indexOf('状态'), iRole = header.indexOf('应聘岗位');
      const iAi = header.indexOf('AI建议');
      const n = rows.filter((r) => r[iStatus] === '待初筛' && !r[iAi]
        && (!ctx.targetRole || r[iRole] === ctx.targetRole)).length;
      if (!n) return [];
      return [`ai: ${loadCfg().ai.model} × ${n} 次调用（约 ${(n * 3.5).toFixed(0)}k token）`];
    },
    async execute(ctx, logs) {
      const readLedger = ctx.readLedgerStrict || ctx.readLedger;
      const { header, rows } = readLedger();
      const iStatus = header.indexOf('状态'), iRole = header.indexOf('应聘岗位');
      const iAi = header.indexOf('AI建议'), iName = header.indexOf('姓名');
      const iBg = header.indexOf('现职/背景'), iNote = header.indexOf('备注');
      // 台账缺这些列时 indexOf 返回 -1，写入会静默丢失（写进数组的 -1 属性，CSV 序列化时消失）。
      // 宁可报错让人加列，也不要假装修完。
      if (iAi < 0) throw new Error('台账缺少「AI建议」列，请在表头补上（见 skills/recruit-daily/references/ledger-and-report.md）再跑。');
      const context = fs.readFileSync(path.join(ctx.dataHome, 'CONTEXT.md'), 'utf8');

      const targets = rows.filter((r) => r[iStatus] === '待初筛' && !r[iAi]
        && (!ctx.targetRole || r[iRole] === ctx.targetRole));
      if (!targets.length) { logs.push('没有要筛的人（都跑过了）'); return { ok: true, count: 0 }; }

      logs.push(`共 ${targets.length} 人，模型 ${loadCfg().ai.model}，预计 ${Math.round(targets.length * 12)} 秒左右`);
      let done = 0, fail = 0, saved = 0;
      for (const row of targets) {
        if (batchControl.cancelRequested) break;
        if (batchControl.pauseRequested) {
          STATE.paused = true;
          logs.push('已暂停，当前没有进行中的 AI 请求。');
          await new Promise((resolve) => { batchControl.wake = resolve; });
          batchControl.wake = null;
          STATE.paused = false;
        }
        if (batchControl.cancelRequested) break;
        STATE.total = targets.length;
        const name = row[iName];
        // 命脉技能写在对内笔记（01-jd/_internal/<role>.md）里，是 AI 初筛的一票否决依据，
        // 必须一起喂给模型——否则第 2 条「命脉是否命中」只能答「无法判断」。
        const notesPath = path.join(ctx.dataHome, '01-jd', '_internal', (row[iRole] || '') + '.md');
        const notes = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8') : '';
        // 简历正文（机器识别）是命脉证据的主要来源：真机调试、模块联调的具体细节都在里面。
        // 台账「简历路径」列指向 runtime/resumes/inbox/ 下的 OCR 文本；没有就读不到，只能用免费档案。
        let resumeText = '';
        const iResume = header.indexOf('简历路径');
        const resumePath = iResume >= 0 ? row[iResume] : '';
        if (resumePath && /\.(txt|md)$/i.test(resumePath) && fs.existsSync(resumePath)) {
          try { resumeText = fs.readFileSync(resumePath, 'utf8').slice(0, 12000); } catch (e) { /* 路径失效就跳过 */ }
        }
        const person = [
          `姓名: ${name}`,
          `应聘岗位: ${row[iRole]}`,
          `现职/背景: ${row[iBg]}`,
          `免费档案与聊天记录: ${row[iNote]}`,
          resumeText
            ? `\n简历正文（机器识别，可能有错字）:\n${resumeText}`
            : '\n（无简历正文可读——命脉判断可能只能写「无法判断」）',
        ].join('\n');
        let counted = false;
        try {
          const ctrl = new AbortController();
          batchControl.request = ctrl;
          const r = await (ctx.screen || aiScreen)({ context, notes, person, signal: ctrl.signal });
          batchControl.request = null;
          if (batchControl.cancelRequested || r.cancelled) break;
          done++;
          counted = true;
          STATE.current = done;
          if (!r.ok) { fail++; logs.push(`${name}：调用失败（${r.error}）`); continue; }
          const brief = String(r.content).replace(/\n+/g, ' ').trim().slice(0, 220);
          const latest = readLedger();
          const idCol = latest.header.indexOf('序号');
          const id = row[header.indexOf('序号')];
          const matches = latest.rows.filter((item) => item[idCol] === id);
          if (matches.length !== 1) throw new Error(`台账序号 ${id} 不唯一或已删除，未写入建议`);
          const item = matches[0];
          const aiCol = latest.header.indexOf('AI建议');
          const statusCol = latest.header.indexOf('状态');
          if (item[statusCol] !== '待初筛' || item[aiCol]) {
            logs.push(`${name}：台账已变更，跳过写入`);
            continue;
          }
          item[aiCol] = brief;
          const updatedCol = latest.header.indexOf('更新时间');
          if (updatedCol >= 0) item[updatedCol] = new Date().toISOString().slice(0, 10);
          ctx.writeLedger(latest.header, latest.rows);
          saved++;
          const tok = r.usage && r.usage.total_tokens ? `（${r.usage.total_tokens}t）` : '';
          logs.push(`${name}：${brief.slice(0, 80)}…${tok}`);
        } catch (e) {
          batchControl.request = null;
          if (batchControl.cancelRequested) break;
          if (!counted) { done++; STATE.current = done; }
          fail++; logs.push(`${name}：异常 ${e.message}`);
        }
        if (!batchControl.cancelRequested && !batchControl.pauseRequested) await sleep(500);
      }
      logs.push(`${batchControl.cancelRequested ? '已取消' : '完成'}：${saved} 人写入建议${fail ? `，${fail} 人失败` : ''}（状态列未动）`);
      return { ok: !batchControl.cancelRequested, cancelled: batchControl.cancelRequested, count: saved, failed: fail };
    },
  },

  /**
   * 多模态抽样复核：让视觉模型直接看简历截图，专抓 OCR 引文看不出来的语义风险。
   *
   * 与「批量 AI 初筛」分工：
   *   批量 AI 初筛  判「符不符合标准」——OCR 文本 + 命脉标准，快、便宜、结论可存档可引用。
   *   多模态复核    判「像不像真的」——参与度伪装、方向漂移、短期贴金、仿真冒充实机。
   * 抽样跑（默认 20%、单次最多 5 人）：视觉模型慢（实测完整复核约 95 秒/份）且不产出可复用的文字，
   * 但它能抓到文本引文看不出的那类风险（实测能点出「多处写『参与』」）。
   * 只写「多模态复核」列，不动状态、不改 AI建议。
   */
  'vision-review': {
    label: '多模态抽样复核',
    desc: '抽一部分人，让视觉模型直接看简历截图，专抓 OCR 引文看不出的语义风险'
      + '（参与度伪装、方向漂移、短期贴金、仿真冒充实机）。'
      + '**只写「多模态复核」列，不动状态、不改 AI建议。**每人约 95 秒、约 7k token。',
    plan: (ctx) => {
      const { header, rows } = ctx.readLedger();
      const iPath = header.indexOf('简历路径'), iRole = header.indexOf('应聘岗位');
      const n = rows.filter((r) => iPath >= 0 && r[iPath] && /\.(txt|md)$/i.test(r[iPath]) && fs.existsSync(r[iPath])
        && (!ctx.targetRole || r[iRole] === ctx.targetRole)).length;
      if (!n) return [];
      const cfg = loadCfg();
      const rate = Number(cfg.ai.visionSampleRate) > 0 ? Number(cfg.ai.visionSampleRate) : 0.2;
      const pick = Math.min(Math.ceil(n / Math.max(1, Math.round(1 / rate))), 5);
      return [`vision: ${cfg.ai.visionModel || cfg.ai.model} × ${pick} 人（约 ${(pick * 7).toFixed(0)}k token，约 ${pick * 95} 秒）`];
    },
    async execute(ctx, logs) {
      const readLedger = ctx.readLedgerStrict || ctx.readLedger;
      const { header, rows } = readLedger();
      const iRole = header.indexOf('应聘岗位'), iName = header.indexOf('姓名');
      const iPath = header.indexOf('简历路径'), iVision = header.indexOf('多模态复核');
      const iBg = header.indexOf('现职/背景'), iNote = header.indexOf('备注');
      if (iVision < 0) throw new Error('台账缺少「多模态复核」列，请在表头补上（见 skills/recruit-daily/references/ledger-and-report.md）再跑。');
      const cfg = loadCfg();
      const rate = Number(cfg.ai.visionSampleRate) > 0 ? Number(cfg.ai.visionSampleRate) : 0.2;
      const every = Math.max(1, Math.round(1 / rate));
      const candidates = rows.filter((r) => iPath >= 0 && r[iPath] && /\.(txt|md)$/i.test(r[iPath]) && fs.existsSync(r[iPath])
        && (!ctx.targetRole || r[iRole] === ctx.targetRole));
      if (!candidates.length) {
        logs.push('没有带简历正文的人可复核（先跑「读取沟通和在线简历」或批量读简历，让 OCR 文本落盘）');
        return { ok: true, count: 0 };
      }
      const picked = candidates.filter((_, i) => i % every === 0).slice(0, 5);
      logs.push(`共 ${candidates.length} 人可复核，按 ${Math.round(rate * 100)}% 抽样取 ${picked.length} 人`);

      const system = '你是招聘复核助手，专挑简历里「看着好、其实不对」的信号。'
        + '每条结论必须引用简历原话；看不到的写「无法判断」，不许猜。输出中文，简短。';
      let done = 0, fail = 0, saved = 0;
      for (const row of picked) {
        if (batchControl.cancelRequested) break;
        STATE.total = picked.length;
        const name = row[iName];
        const txt = row[iPath];
        const png = txt.replace(/\.(txt|md)$/i, '.png');
        const jpg = txt.replace(/\.(txt|md)$/i, '.vision.jpg');
        if (!fs.existsSync(png)) { fail++; logs.push(`${name}：没有对应截图（${path.basename(png)}），跳过`); continue; }
        try {
          if (!fs.existsSync(jpg)) {
            const spec = pythonPrepCommand(png, jpg);
            const prep = await new Promise((resolve) => {
              const p = spawn(spec.bin, spec.args, { shell: false });
              let err = '';
              const t = setTimeout(() => { try { p.kill(); } catch {} resolve({ ok: false, error: '图片压缩超时' }); }, 60000);
              p.stderr.on('data', (d) => { err += d; });
              p.on('error', (e) => { clearTimeout(t); resolve({ ok: false, error: e.message }); });
              p.on('close', (code) => { clearTimeout(t); resolve({ ok: code === 0, error: err.trim() }); });
            });
            if (!prep.ok) { fail++; logs.push(`${name}：图片压缩失败（${prep.error}）`); continue; }
          }
          const person = [
            `姓名: ${name}`,
            `应聘岗位: ${row[iRole]}`,
            `现职/背景: ${row[iBg]}`,
            `聊天/备注: ${row[iNote]}`,
          ].join('\n');
          const notesPath = path.join(ctx.dataHome, '01-jd', '_internal', (row[iRole] || '') + '.md');
          const notes = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8') : '';
          const prompt = [
            '## 岗位标准（判断方向是否一致用）', notes || '（未找到对内笔记）', '',
            '## 候选人基本信息', person, '',
            '## 你要回答的（严格 4 条，每条不超过 50 字）',
            '1. 参与度伪装：是否多处用「参与/协助」却说不出自己具体做了什么？是/否 + 举一处原话',
            '2. 方向漂移：求职意向与目标岗位实际方向是否一致？是/否 + 说明',
            '3. 短期贴金：有没有大厂/大赛经历只做了 1-2 个月？是/否 + 举一处',
            '4. 真机还是仿真：项目跑在真实设备上还是纯仿真？真实/仿真/无法判断 + 一句依据', '',
            '最后一行输出「结论：值得深聊 / 一般 / 存疑 + 一句话理由」',
          ].join('\n');
          const ctrl = new AbortController();
          batchControl.request = ctrl;
          const r = await aiVision({ system, prompt, imagePath: jpg, signal: ctrl.signal });
          batchControl.request = null;
          if (batchControl.cancelRequested || r.cancelled) break;
          done++;
          STATE.current = done;
          if (!r.ok) { fail++; logs.push(`${name}：调用失败（${r.error}）`); continue; }
          const brief = String(r.content).replace(/\n+/g, ' ').trim().slice(0, 300);
          const latest = readLedger();
          const idCol = latest.header.indexOf('序号');
          const id = row[header.indexOf('序号')];
          const matches = latest.rows.filter((item) => item[idCol] === id);
          if (matches.length !== 1) throw new Error(`台账序号 ${id} 不唯一或已删除，未写入复核结果`);
          const item = matches[0];
          const vCol = latest.header.indexOf('多模态复核');
          if (item[vCol]) { logs.push(`${name}：已复核过，跳过`); continue; }
          item[vCol] = brief;
          const updCol = latest.header.indexOf('更新时间');
          if (updCol >= 0) item[updCol] = localDateStr();
          ctx.writeLedger(latest.header, latest.rows);
          saved++;
          logs.push(`${name}：${brief.slice(0, 100)}…`);
        } catch (e) {
          batchControl.request = null;
          fail++;
          logs.push(`${name}：异常 ${e.message}`);
        }
        await sleep(500);
      }
      logs.push(`${batchControl.cancelRequested ? '已取消' : '完成'}：${saved} 人写入复核结果${fail ? `，${fail} 人失败` : ''}（状态与 AI建议未动）`);
      return { ok: !batchControl.cancelRequested, cancelled: batchControl.cancelRequested, count: saved, failed: fail };
    },
  },

  /** 拉取今日未读：跑 boss list --unread，原始输出落盘 */
  'pull-unread': {
    label: '拉取今日未读',
    desc: '拉取 BOSS 当前未读消息，替换待办名单；旧记录转入本地历史，新候选人去重入账。完成后进入「未读待办」继续处理。',
    plan: () => ['boss list --unread'],
    async execute(ctx, logs) {
      const r = await runOne('boss list --unread', 90000);
      logs.push('$ boss list --unread');
      if (r.code !== 0) {
        logs.push('执行失败：' + (r.err || ('退出码 ' + r.code)));
        return { ok: false };
      }
      const dir = path.join(ctx.dataHome, 'runtime', 'raw');
      fs.mkdirSync(dir, { recursive: true });
      const d = new Date();
      // 带时分：同一天跑多次不会互相覆盖（原始抓取是留档核对用的，覆盖了就找不回来）
      const p2 = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
      const file = path.join(dir, `${stamp}-boss-unread.txt`);
      fs.writeFileSync(file, r.out, 'utf8');
      const result = ctx.inbox.importSource(path.basename(file));
      logs.push(`未读 ${result.count} 人 · 新增 ${result.added} 人 · 关联已有 ${result.linked} 人`);
      if (result.unresolved) logs.push(`${result.unresolved} 人身份信息待核实，未自动入账。`);
      logs.push('已整理到「未读待办」，可查看消息、读取完整沟通并记录下一步。');
      return { ok: true, ...result, file };
    },
  },

  'inbox-chat': {
    contextual: true,
    label: '读取沟通和在线简历',
    desc: '打开这位候选人的 BOSS 会话，核对姓名和岗位后查看在线简历，保存完整沟通、简历原图与本地初筛线索。打开会话可能使平台消息变为已读；不会发送消息或改变筛选状态。',
    plan(ctx) {
      const item = ctx.inbox.chatTarget(ctx.opts.id, ctx.opts.signature);
      return [chatCommandString(item), 'boss action resume'];
    },
    async execute(ctx, logs) {
      const item = ctx.inbox.chatTarget(ctx.opts.id, ctx.opts.signature);
      logs.push(`正在读取 ${item.name} · ${item.role}`);
      return captureInboxResume(ctx, item, logs);
    },
  },

  'inbox-resume': {
    contextual: true,
    label: '查看在线简历',
    desc: '先核对候选人姓名与沟通岗位，再打开 BOSS 在线简历并保存截图到当前工作区。平台可能记录一次简历查看；不会发送消息或改变筛选状态。',
    plan(ctx) {
      const item = ctx.inbox.chatTarget(ctx.opts.id, ctx.opts.signature);
      return [chatCommandString(item), 'boss action resume'];
    },
    async execute(ctx, logs) {
      const item = ctx.inbox.chatTarget(ctx.opts.id, ctx.opts.signature);
      return captureInboxResume(ctx, item, logs);
    },
  },

  'inbox-resume-role': {
    contextual: true,
    label: '批量查看本岗在线简历',
    desc: '逐人核对姓名和岗位，只读取当前岗位待处理且尚无简历的人选。打开会话可能使消息变已读。失败者会跳过；不发消息、不改筛选状态。',
    plan(ctx) {
      return unreadResumeTargets(ctx).flatMap((item) => [chatCommandString(item), 'boss action resume']);
    },
    async execute(ctx, logs) {
      const targets = unreadResumeTargets(ctx);
      STATE.total = targets.length;
      let done = 0, failed = 0;
      for (let i = 0; i < targets.length; i++) {
        STATE.current = i + 1;
        try { await captureInboxResume(ctx, targets[i], logs); done++; }
        catch (e) { failed++; logs.push(`${targets[i].name}：${e.message}`); }
      }
      logs.push(`本岗完成：${done} 人已存简历，${failed} 人未完成。`);
      return { ok: true, done, failed };
    },
  },

  /** 批量硬门槛筛选：对硬门槛为空的人逐个 boss chat（不碰对外动作） */
  'screen-hardgate': {
    label: '批量硬门槛筛选',
    desc: '对台账里「硬门槛」还没填的人，逐个跑 boss chat 带出年龄/届别/学历，自动填回台账。'
      + '每人约 3 秒。',
    plan: (ctx) => {
      const { header, rows } = ctx.readLedger();
      const iHard = header.indexOf('硬门槛'), iRole = header.indexOf('应聘岗位');
      const target = ctx.targetRole
        ? rows.filter((r) => !r[iHard] && r[iRole] === ctx.targetRole)
        : rows.filter((r) => !r[iHard]);
      return target.map((r) => `boss chat "${r[header.indexOf('姓名')]}"`);
    },
    async execute(ctx, logs) {
      const { header, rows } = ctx.readLedger();
      const iHard = header.indexOf('硬门槛'), iRole = header.indexOf('应聘岗位');
      const iNote = header.indexOf('备注'), iName = header.indexOf('姓名');
      // 缺列时 indexOf = -1：verdict 会写进数组的 -1 属性，CSV 序列化时静默消失。
      // 必须在这里挡住，否则跑完看起来成功、台账里一条记录都没有。
      if (iHard < 0) throw new Error('台账缺少「硬门槛」列，请在表头补上（见 skills/recruit-daily/references/ledger-and-report.md）再跑。');
      const targets = ctx.targetRole
        ? rows.filter((r) => !r[iHard] && r[iRole] === ctx.targetRole)
        : rows.filter((r) => !r[iHard]);
      if (!targets.length) { logs.push('没有需要筛的人（硬门槛都填过了）'); return { ok: true, count: 0 }; }

      let filled = 0, failed = 0;
      for (let i = 0; i < targets.length; i++) {
        const row = targets[i];
        const name = row[iName];
        STATE.current = i + 1;
        STATE.total = targets.length;
        const r = await runBoss(['chat', name], 45000);
        if (r.code !== 0 && !r.out.trim()) { failed++; logs.push(`${name}：执行失败`); continue; }
        const m = r.out.match(/基本信息:\s*(.+)/);
        if (!m) { failed++; logs.push(`${name}：没读到「基本信息」（可能未登录或页面变了）`); continue; }
        const info = m[1];
        const verdict = hardgateVerdict({ role: row[iRole], info, dataHome: ctx.dataHome });
        row[iHard] = verdict;
        if (iNote >= 0) row[iNote] = (row[iNote] ? row[iNote] + '｜' : '') + `【硬门槛】${info.trim()}`;
        filled++;
        logs.push(`${name}：${verdict}（${info.trim()}）`);
        await sleep(2000);   // 别太快，尊重平台
      }
      ctx.writeLedger(header, rows);
      logs.push(`已回填 ${filled} 人${failed ? `，${failed} 人失败` : ''}`);
      return { ok: true, count: filled, failed };
    },
  },
};

// ── 票据

function issueTicket(task, ctx) {
  const now = Date.now();
  for (const [token, ticket] of TICKETS) {
    if (now - ticket.created > TICKET_TTL) TICKETS.delete(token);
  }
  const token = crypto.randomUUID();
  TICKETS.set(token, { task, ctx, created: now, used: false });
  return token;
}

function preview(task, ctx) {
  const def = TASKS[task];
  if (!def) return { ok: false, error: '没有这个任务' };
  const cmds = def.plan(ctx);
  for (const c of cmds) {
    const v = validate(c, task);
    if (!v.ok) return { ok: false, error: `命令被白名单拒绝：${c}（${v.why}）` };
  }
  const token = issueTicket(task, ctx);
  return {
    ok: true, token, task,
    label: def.label,
    desc: def.desc,
    commands: cmds,
    estimateSec: Math.max(5, cmds.length * 3),
  };
}

async function run(token, confirm) {
  if (!confirm) return { ok: false, error: '未确认，不执行' };
  const t = TICKETS.get(token);
  if (!t) return { ok: false, error: '票据无效或已过期，请重新点按钮' };
  if (t.used) return { ok: false, error: '票据已用过（每次执行都要重新确认）' };
  if (Date.now() - t.created > TICKET_TTL) { TICKETS.delete(token); return { ok: false, error: '票据已过期，请重新点按钮' }; }
  if (STATE.running) return { ok: false, error: '已有任务在跑，等它结束' };

  // 就地标记，不做整体替换：preview() 可能在此期间为同一任务签新票，
  // 整体替换 TICKETS.set 有把别人的新条目覆盖掉的风险。
  t.used = true;
  const def = TASKS[t.task];
  // 支持暂停/取消的批量任务：文本初筛与多模态复核共用一套控制通道。
  // （原来只认 'ai-screen-batch'，别的批量任务一跑就撞上 batchControl 为 null。）
  const batchAi = BATCH_AI_TASKS.includes(t.task);
  STATE = { running: true, task: t.task, current: 0, total: 0, logs: [], done: false, ok: null,
    paused: false, pauseRequested: false, cancelRequested: false, cancelled: false,
    controllable: batchAi };
  batchControl = batchAi ? { pauseRequested: false, cancelRequested: false, request: null, wake: null } : null;

  try {
    const res = await def.execute(t.ctx, STATE.logs);
    STATE.ok = res.ok !== false;
    STATE.cancelled = !!res.cancelled;
    STATE.done = true;
    STATE.running = false;
    return { ok: STATE.ok, result: res };
  } catch (e) {
    STATE.logs.push('异常：' + e.message);
    STATE.ok = false; STATE.done = true; STATE.running = false;
    return { ok: false, error: e.message };
  } finally {
    batchControl = null;
  }
}

function control(action) {
  if (!batchControl || !STATE.running || !BATCH_AI_TASKS.includes(STATE.task)) return { ok: false, error: '没有正在执行的批量 AI 任务' };
  if (action === 'pause') {
    if (batchControl.cancelRequested) return { ok: false, error: '任务正在取消' };
    batchControl.pauseRequested = true;
    STATE.pauseRequested = true;
  } else if (action === 'resume') {
    batchControl.pauseRequested = false;
    STATE.pauseRequested = false;
    batchControl.wake?.();
  } else if (action === 'cancel') {
    batchControl.cancelRequested = true;
    STATE.cancelRequested = true;
    batchControl.request?.abort();
    batchControl.wake?.();
  } else return { ok: false, error: '无效的任务操作' };
  return { ok: true };
}

module.exports = { TASKS, preview, run, control, validate, getState: () => STATE, ALLOWED_SUBCOMMANDS };
