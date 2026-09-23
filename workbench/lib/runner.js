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

/** 让子进程一定能找到 boss（~/.local/bin 不一定在当前 PATH 里） */
function childEnv() {
  const home = os.homedir();
  const extra = [path.join(home, '.local', 'bin'), '/usr/local/bin', '/usr/bin', '/bin'];
  return { ...process.env, PATH: [...new Set([...(process.env.PATH || '').split(':'), ...extra])].join(':') };
}

function validate(cmd, task) {
  // 内部 AI 动作：不碰招聘平台，白名单不管它（它有自己的记录与确认）
  if (String(cmd).startsWith('ai:')) return { ok: true };
  // 仅单人简历任务可调用这个固定的只读截图动作，绝不放开通用 action。
  if ((task === 'inbox-resume' || task === 'inbox-resume-role') && cmd === 'boss action resume') return { ok: true };
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
  if (cur) out.push(cur);
  return out;
}

function runOne(cmd, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const parts = splitCmd(cmd);
    const p = spawn(parts[0], parts.slice(1), { env: childEnv(), shell: false });
    let out = '', err = '';
    const t = setTimeout(() => { try { p.kill(); } catch {} resolve({ out, err: err + '\n[超时]', code: -1 }); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => { clearTimeout(t); resolve({ out, err, code }); });
    p.on('error', (e) => { clearTimeout(t); resolve({ out, err: String(e.message || e), code: -1 }); });
  });
}

function recognizeResume(file) {
  return new Promise((resolve) => {
    const p = spawn('swift', [path.join(__dirname, '..', 'bin', 'ocr-resume.swift'), file], { shell: false });
    let out = '', err = '';
    const timer = setTimeout(() => p.kill(), 120000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, text: out.trim(), error: err.trim() }); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 任务定义

const report = require('./report');
const { screen: aiScreen, loadCfg } = require('./ai');
const { reviewResume, hardgateVerdict } = require('./resume-review');

function unreadResumeTargets(ctx) {
  const role = String(ctx.opts.role || '');
  if (!role) throw new Error('请先选择一个应聘岗位。');
  return ctx.inbox.list().items.filter((item) => item.role === role && !item.handled && !item.resume && !item.chatBlocked);
}

async function captureInboxResume(ctx, item, logs) {
  const current = ctx.inbox.chatTarget(item.id, item.signature);
  const chat = await runOne(`boss chat "${current.name}"`, 60000);
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

/** 拼 boss search 命令（值可能含空格，都加引号；没填的参数一律不传） */
function buildSearchCmd(ctx, s) {
  const kw = String(s.keyword || '').trim();
  const parts = ['boss search', `"${kw}"`];
  if (s.job) parts.push('--job', `"${s.job}"`);
  if (s.ageRange) parts.push('--age-range', `"${String(s.ageRange).trim()}"`);
  if (s.degree) parts.push('--degree', `"${String(s.degree).trim()}"`);
  if (s.city) parts.push('--city', `"${String(s.city).trim()}"`);
  return parts.join(' ');
}

/** 打招呼候选名单：只按本机配置的评级阈值选已通过的推荐池人选。 */
function greetTargets(ctx) {
  const minStars = ctx.outreach?.minStars;
  if (!Number.isInteger(minStars) || minStars < 1 || minStars > 3) {
    throw new Error('请先在本地配置打招呼的最低评级（1-3 星）。');
  }
  const { header, rows } = ctx.readLedger();
  const iRating = header.indexOf('评级'), iStatus = header.indexOf('状态');
  const iSource = header.indexOf('来源轮次'), iName = header.indexOf('姓名');
  const iRole = header.indexOf('应聘岗位');
  return rows
    .map((r) => ({
      name: r[iName], role: r[iRole],
      stars: ((r[iRating] || '').match(/⭐/g) || []).length,
      status: r[iStatus], source: r[iSource] || '',
    }))
    .filter((t) => t.stars >= minStars && t.status === '初筛通过' && t.source.includes('推荐'));
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
   * 搜索池寻源：用关键词 + 筛选参数去 BOSS 搜索页捞人
   * fork 0.8.0 起支持 --degree / --age-range / --exp 等筛选，且每次搜索前会先清空筛选
   */
  'search-pool': {
    label: '搜索池寻源',
    desc: '按关键词去 BOSS 人才库捞人，可带学历 / 年龄 / 经验筛选。'
      + '只读，不消耗简历额度，也不打招呼。结果存到 runtime/raw/。'
      + '⚠️ 搜索池打招呼消耗的权益与推荐池不同，请先核对平台当前额度。'
      + '—— 没畅聊卡时把这里当储备池，主动联系请走推荐池。',
    plan: (ctx) => {
      const s = (ctx.opts || {});
      if (!String(s.keyword || '').trim()) return [];
      return [buildSearchCmd(ctx, s)];
    },
    async execute(ctx, logs) {
      const s = (ctx.opts || {});
      const cmd = buildSearchCmd(ctx, s);
      logs.push('$ ' + cmd);
      const r = await runOne(cmd, 120000);
      if (r.code !== 0 && !r.out.trim()) {
        logs.push('执行失败：' + (r.err || ('退出码 ' + r.code)));
        logs.push('（如果提示参数值不对，它通常会把可选项列出来 —— 照着改即可）');
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
   * 推荐池寻源：boss recommend（姓名不打码、拉列表免费）
   * 策略：列表免费 → 本地/人工筛 → 只给最对口的少数人花简历额度（boss preview）
   */
  'recommend-pool': {
    label: '拉取推荐牛人',
    desc: '跑 boss recommend 拉推荐池列表（姓名不打码，**拉列表免费**）。'
      + '看完列表再决定给谁看简历 —— VIP 简历不限量，但挑对口的看效率高。'
      + '⚠️ 给推荐池的人打招呼会消耗平台额度，请先核对当前余额。',
    plan: (ctx) => {
      const job = (ctx.opts && ctx.opts.job) || ctx.targetRole || '';
      return job ? [`boss recommend "${job}"`] : ['boss recommend'];
    },
    async execute(ctx, logs) {
      const job = (ctx.opts && ctx.opts.job) || ctx.targetRole || '';
      const cmd = job ? `boss recommend "${job}"` : 'boss recommend';
      logs.push('$ ' + cmd);
      const r = await runOne(cmd, 120000);
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
   * 给合格候选人打招呼，须经本轮确认。
   * 硬条件（代码强制）：本机配置的最低评级、状态=初筛通过、来源=推荐池。
   * 理由：池子里的人列表会重排，不立刻打招呼就会丢 —— 打了才进沟通列表，后续免费筛选手段才解锁。
   */
  'greet-qualified': {
    label: '给合格候选人打招呼',
    desc: '只对「评级达到本机最低标准、状态=初筛通过、来源=推荐池」的人打招呼；条件在代码里强制。'
      + '发出的是账号默认话术；消耗平台打招呼额度；不可撤回。'
      + '打完状态改「已打招呼」，之后就能用 boss chat 免费跟进。',
    plan: (ctx) => greetTargets(ctx).map((t) => `boss greet "${t.name}" --job "${t.role}"`),
    async execute(ctx, logs) {
      const targets = greetTargets(ctx);
      if (!targets.length) {
        logs.push('没有符合本机评级条件的推荐池初筛通过人选。');
        return { ok: true, count: 0 };
      }
      logs.push(`共 ${targets.length} 人，间隔 3 秒，发出账号默认话术`);
      const { header, rows } = ctx.readLedger();
      const iName = header.indexOf('姓名'), iStatus = header.indexOf('状态');
      const iUpd = header.indexOf('更新时间');
      let ok = 0, fail = 0;
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        STATE.current = i + 1; STATE.total = targets.length;
        const cmd = `boss greet "${t.name}" --job "${t.role}"`;
        logs.push('$ ' + cmd);
        let r = await runOne(cmd, 60000);
        let out = ((r.out || '') + ' ' + (r.err || ''));
        let bad = /失败|错误|error|未找到|无法|不存在/i.test(out);
        if (r.code !== 0 || bad) {
          await sleep(2000);
          r = await runOne(cmd, 60000);   // 文档：偶发失败，重试一次
          out = ((r.out || '') + ' ' + (r.err || ''));
          bad = /失败|错误|error|未找到|无法|不存在/i.test(out);
        }
        if (r.code === 0 && !bad) {
          ok++;
          const row = rows.find((x) => x[iName] === t.name);
          if (row) { row[iStatus] = '已打招呼'; if (iUpd >= 0) row[iUpd] = new Date().toISOString().slice(0, 10); }
          logs.push(`${t.name}（${t.stars}）：已打招呼`);
        } else {
          fail++;
          logs.push(`${t.name}：失败 —— ${out.trim().slice(0, 80)}`);
        }
        await sleep(3000);   // 文档：循环打太快撞列表刷新会偶发失败
      }
      ctx.writeLedger(header, rows);
      logs.push(`完成：${ok} 人已打招呼${fail ? `，${fail} 人失败（失败的不改状态，可重跑）` : ''}`);
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
        const person = [
          `姓名: ${name}`,
          `应聘岗位: ${row[iRole]}`,
          `现职/背景: ${row[iBg]}`,
          `免费档案与聊天记录: ${row[iNote]}`,
        ].join('\n');
        let counted = false;
        try {
          const ctrl = new AbortController();
          batchControl.request = ctrl;
          const r = await (ctx.screen || aiScreen)({ context, person, signal: ctrl.signal });
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
    label: '读取完整沟通',
    desc: '打开这位候选人的 BOSS 会话，读取聊天和人才摘要。打开会话可能使平台消息变为已读；本地待办会保留到你记录处理结果。',
    plan(ctx) {
      const item = ctx.inbox.chatTarget(ctx.opts.id, ctx.opts.signature);
      return [`boss chat "${item.name}"`];
    },
    async execute(ctx, logs) {
      const item = ctx.inbox.chatTarget(ctx.opts.id, ctx.opts.signature);
      const command = `boss chat "${item.name}"`;
      logs.push(`正在读取 ${item.name} · ${item.role}`);
      const result = await runOne(command, 60000);
      if (result.code !== 0) throw new Error(result.err || '读取失败，请检查 BOSS 登录状态。');
      ctx.inbox.saveChat(item.id, item.signature, result.out);
      logs.push('完整沟通已保存，回到待办可查看。');
      return { ok: true };
    },
  },

  'inbox-resume': {
    contextual: true,
    label: '查看在线简历',
    desc: '先核对候选人姓名与沟通岗位，再打开 BOSS 在线简历并保存截图到当前工作区。平台可能记录一次简历查看；不会发送消息或改变筛选状态。',
    plan(ctx) {
      const item = ctx.inbox.chatTarget(ctx.opts.id, ctx.opts.signature);
      return [`boss chat "${item.name}"`, 'boss action resume'];
    },
    async execute(ctx, logs) {
      const item = ctx.inbox.chatTarget(ctx.opts.id, ctx.opts.signature);
      return captureInboxResume(ctx, item, logs);
    },
  },

  'inbox-resume-role': {
    contextual: true,
    label: '批量查看本岗在线简历',
    desc: '逐人核对姓名和岗位，只读取当前岗位待处理且尚无简历的人选。打开会话可能使消息变已读，在线简历可能占用平台查看次数。失败者会跳过；不发消息、不改筛选状态。',
    plan(ctx) {
      return unreadResumeTargets(ctx).flatMap((item) => [`boss chat "${item.name}"`, 'boss action resume']);
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

  /** 批量免费硬门槛筛选：对硬门槛为空的人逐个 boss chat（免费，不花简历额度） */
  'screen-hardgate': {
    label: '批量免费硬门槛筛选',
    desc: '对台账里「硬门槛」还没填的人，逐个跑 boss chat 免费带出年龄/届别/学历，自动填回台账。'
      + '**不消耗简历查看额度**。每人约 3 秒。',
    plan: (ctx) => {
      const { header, rows } = ctx.readLedger();
      const iHard = header.indexOf('硬门槛'), iRole = header.indexOf('应聘岗位');
      const target = ctx.targetRole
        ? rows.filter((r) => !r[iHard] && r[iRole] === ctx.targetRole)
        : rows.filter((r) => !r[iHard]);
      return target.map((r) => `boss chat "${r[1]}"`);
    },
    async execute(ctx, logs) {
      const { header, rows } = ctx.readLedger();
      const iHard = header.indexOf('硬门槛'), iRole = header.indexOf('应聘岗位');
      const iNote = header.indexOf('备注');
      const targets = ctx.targetRole
        ? rows.filter((r) => !r[iHard] && r[iRole] === ctx.targetRole)
        : rows.filter((r) => !r[iHard]);
      if (!targets.length) { logs.push('没有需要筛的人（硬门槛都填过了）'); return { ok: true, count: 0 }; }

      let filled = 0, failed = 0;
      for (let i = 0; i < targets.length; i++) {
        const row = targets[i];
        const name = row[1];
        STATE.current = i + 1;
        STATE.total = targets.length;
        const r = await runOne(`boss chat "${name}"`, 45000);
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
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  TICKETS.set(token, { task, ctx, created: Date.now(), used: false });
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

  TICKETS.set(token, { ...t, used: true });
  const def = TASKS[t.task];
  STATE = { running: true, task: t.task, current: 0, total: 0, logs: [], done: false, ok: null,
    paused: false, pauseRequested: false, cancelRequested: false, cancelled: false,
    controllable: t.task === 'ai-screen-batch' };
  batchControl = t.task === 'ai-screen-batch' ? { pauseRequested: false, cancelRequested: false, request: null, wake: null } : null;

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
  if (!batchControl || !STATE.running || STATE.task !== 'ai-screen-batch') return { ok: false, error: '没有正在执行的批量 AI 初筛' };
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
