'use strict';
/**
 * 招聘工作台 —— 本地服务（P0）
 *
 * 三条不可协商的规则，改代码时别破坏：
 *  1. 只监听 127.0.0.1 —— 同一 WiFi 下别人也访问不到
 *  2. 平台读取任务须经过一次性确认；不提供打招呼或点不合适接口
 *  3. 改台账前必先备份（在 lib/ledger.js 的 backup() 里）
 *
 * 启动：node server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Ledger } = require('./lib/ledger');
const { Inbox } = require('./lib/inbox');
const runner = require('./lib/runner');
const { screen: aiScreen } = require('./lib/ai');
const { reviewResume } = require('./lib/resume-review');
const report = require('./lib/report');
const { cleanupOrphanScreenshots } = require('./lib/storage');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
cfg.dataHome = path.resolve(ROOT, cfg.dataHome);

// 密钥单独存：config.local.json（已在 .gitignore 里），找不到就当没配
const localPath = path.join(ROOT, 'config.local.json');
if (fs.existsSync(localPath)) {
  try {
    const local = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    cfg.ai = { ...(cfg.ai || {}), ...(local.ai || {}) };
    cfg.outreach = { ...(cfg.outreach || {}), ...(local.outreach || {}) };
  } catch (e) {
    console.warn('  ⚠️ config.local.json 读不出来，已忽略：' + e.message);
  }
}
if (cfg.ai && cfg.ai.apiKey) cfg.ai.enabled = true;

const ledger = new Ledger(cfg);
const inbox = new Inbox(cfg, ledger);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.normalize(path.join(PUBLIC, rel));
  if (!target.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  const ext = path.extname(target).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(target).pipe(res);
}

function readBody(req, cb) {
  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 1e5) req.destroy();
  });
  req.on('end', () => cb(body));
}

/** 读 03-interview 下的候选人档案 */
function listCandidates() {
  const dir = path.join(cfg.dataHome, cfg.interviewDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
    .map((f) => {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      return { name: f.replace(/\.md$/, ''), file: f, mtime: st.mtime.toISOString().slice(0, 10) };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

const server = http.createServer((req, res) => {
  const u = req.url;

  // ── API
  if (u.startsWith('/api/')) {
    if (u === '/api/inbox' && req.method === 'GET') {
      try { return sendJSON(res, 200, { ok: true, ...inbox.list() }); }
      catch (e) { return sendJSON(res, 500, { ok: false, error: e.message }); }
    }
    if (u.startsWith('/api/inbox/resume/image?') && req.method === 'GET') {
      try {
        const q = new URL(u, 'http://localhost').searchParams;
        const file = inbox.resumeFile(q.get('id'), q.get('signature'));
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
        return fs.createReadStream(file).pipe(res);
      } catch (e) { return sendJSON(res, 404, { ok: false, error: e.message }); }
    }
    if (u === '/api/inbox/resume/review' && req.method === 'POST') {
      readBody(req, async (body) => {
        try {
          if (runner.getState().running) throw new Error('有任务正在执行，请稍后评估。');
          const { id, signature } = JSON.parse(body || '{}');
          const item = inbox.get(id, signature);
          if (!item.resume?.text || item.resume.text.length < 30) throw new Error('简历文字不足，暂不能可靠提取线索；请直接查看原图。');
          const review = reviewResume({ role: item.role, resume: item.resume.text,
            conversation: item.chat?.text, dataHome: cfg.dataHome });
          inbox.saveReview(id, signature, { text: review, model: '本地规则' });
          return sendJSON(res, 200, { ok: true, review, model: '本地规则' });
        } catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
      });
      return;
    }
    if ((u === '/api/inbox/import' || u === '/api/inbox/followup') && req.method === 'POST') {
      readBody(req, (body) => {
        try {
          if (runner.getState().running) throw new Error('有任务正在执行，结束后再保存。');
          const data = JSON.parse(body || '{}');
          if (u === '/api/inbox/import') {
            if (!data.source || data.source !== inbox.latest()) throw new Error('抓取结果已更新，请刷新后整理最新一批。');
            return sendJSON(res, 200, { ok: true, ...inbox.importSource(data.source) });
          }
          inbox.followup(data.id, data.signature, data.note, data.handled);
          return sendJSON(res, 200, { ok: true });
        } catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
      });
      return;
    }
    if (u === '/api/config') {
      return sendJSON(res, 200, {
        dataHome: cfg.dataHome,
        hasLedger: fs.existsSync(path.join(cfg.dataHome, cfg.ledger)),
      });
    }

    if (u === '/api/ledger') {
      try { return sendJSON(res, 200, { ok: true, ...ledger.read() }); }
      catch (e) { return sendJSON(res, 500, { ok: false, error: e.message }); }
    }

    if (u === '/api/stats') {
      try { return sendJSON(res, 200, { ok: true, ...ledger.stats() }); }
      catch (e) { return sendJSON(res, 500, { ok: false, error: e.message }); }
    }

    if (u === '/api/candidates') {
      return sendJSON(res, 200, { ok: true, items: listCandidates() });
    }

    if (u.startsWith('/api/candidate?')) {
      const name = decodeURIComponent(new URL(u, 'http://x').searchParams.get('name') || '');
      const file = path.join(cfg.dataHome, cfg.interviewDir, name + '.md');
      if (!name || !fs.existsSync(file)) {
        return sendJSON(res, 404, { ok: false, error: '档案不存在' });
      }
      return sendJSON(res, 200, { ok: true, name, content: fs.readFileSync(file, 'utf8') });
    }

    if (u === '/api/ledger/cell' && req.method === 'POST') {
      readBody(req, (body) => {
        try {
          const { name, col, value, id } = JSON.parse(body || '{}');
          if (!name || !col) throw new Error('缺少 name 或 col');
          const r = ledger.updateCell(String(name), String(col), String(value ?? ''), id);
          sendJSON(res, 200, { ok: true, ...r });
        } catch (e) {
          sendJSON(res, 400, { ok: false, error: e.message });
        }
      });
      return;
    }

    /**
     * 任务上下文：执行器只通过它碰数据，不直接摸文件
     * targetRole 为空 = 全岗；否则只筛该岗位
     */
    if (u === '/api/task/preview' && req.method === 'POST') {
      readBody(req, (body) => {
        try {
          const { task, targetRole, opts } = JSON.parse(body || '{}');
          const ctx = {
            inbox,
            dataHome: cfg.dataHome,
            targetRole: targetRole || '',
            opts: opts || {},
            outreach: cfg.outreach,
            readLedger: () => ledger.read(),
            readLedgerStrict: () => ledger.readStrict(),
            stats: () => ledger.stats(),
            writeLedger: (header, rows) => {
              ledger.write(header, rows);
            },
          };
          sendJSON(res, 200, runner.preview(task, ctx));
        } catch (e) { sendJSON(res, 400, { ok: false, error: e.message }); }
      });
      return;
    }

    if (u === '/api/task/run' && req.method === 'POST') {
      readBody(req, async (body) => {
        try {
          const { token, confirm } = JSON.parse(body || '{}');
          sendJSON(res, 200, await runner.run(token, confirm === true));
        } catch (e) { sendJSON(res, 400, { ok: false, error: e.message }); }
      });
      return;
    }

    if (u === '/api/task/status') {
      const s = runner.getState();
      return sendJSON(res, 200, { ok: true, ...s });
    }
    if (u === '/api/task/control' && req.method === 'POST') {
      readBody(req, (body) => {
        try {
          const { action } = JSON.parse(body || '{}');
          sendJSON(res, 200, runner.control(action));
        } catch (e) { sendJSON(res, 400, { ok: false, error: e.message }); }
      });
      return;
    }

    /**
     * AI 初筛建议
     * 注意：它**只返回建议文本，不写台账**。要不要采纳由人点。
     * 每次调用要花钱，所以前端会把 token 消耗显示出来。
     */
    if (u === '/api/ai/screen' && req.method === 'POST') {
      readBody(req, async (body) => {
        try {
          const { name } = JSON.parse(body || '{}');
          if (!name) throw new Error('缺少姓名');
          const file = path.join(cfg.dataHome, cfg.interviewDir, String(name) + '.md');
          if (!fs.existsSync(file)) return sendJSON(res, 404, { ok: false, error: '还没有这个人的档案' });
          const person = fs.readFileSync(file, 'utf8');
          const context = fs.readFileSync(path.join(cfg.dataHome, 'CONTEXT.md'), 'utf8');
          const r = await aiScreen({ context, person });
          sendJSON(res, 200, r);
        } catch (e) { sendJSON(res, 400, { ok: false, error: e.message }); }
      });
      return;
    }

    /** AI 用量汇总（每次调用记一行 jsonl） */
    if (u === '/api/ai/usage') {
      const f = path.join(cfg.dataHome, 'runtime', 'ai-usage.jsonl');
      const out = { calls: 0, totalTokens: 0, byModel: {}, byDay: {}, recent: [] };
      if (fs.existsSync(f)) {
        const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
        for (const l of lines) {
          let r; try { r = JSON.parse(l); } catch { continue; }
          out.calls++;
          out.totalTokens += r.total || 0;
          out.byModel[r.model] = (out.byModel[r.model] || 0) + (r.total || 0);
          const day = String(r.ts || '').slice(0, 10);
          out.byDay[day] = (out.byDay[day] || 0) + (r.total || 0);
          out.recent.unshift(r);
        }
        out.recent = out.recent.slice(0, 12);
      }
      return sendJSON(res, 200, { ok: true, ...out });
    }

    /** 数据新鲜度：台账里的数据是几点抓的 */
    if (u === '/api/freshness') {
      const dir = path.join(cfg.dataHome, 'runtime', 'raw');
      if (!fs.existsSync(dir)) return sendJSON(res, 200, { ok: true, lastPull: null });
      const files = fs.readdirSync(dir).filter((x) => x.includes('boss-unread')).sort();
      if (!files.length) return sendJSON(res, 200, { ok: true, lastPull: null });
      const f = path.join(dir, files[files.length - 1]);
      const mtime = fs.statSync(f).mtime;
      return sendJSON(res, 200, {
        ok: true,
        lastPull: mtime.toISOString(),
        file: files[files.length - 1],
        hoursAgo: +((Date.now() - mtime.getTime()) / 3600000).toFixed(1),
      });
    }

    /** 已有日报列表 / 读某一份 */
    if (u === '/api/report/list') {
      return sendJSON(res, 200, { ok: true, items: report.list(cfg) });
    }
    if (u.startsWith('/api/report/read?')) {
      const name = decodeURIComponent(new URL(u, 'http://x').searchParams.get('name') || '');
      const file = path.join(cfg.dataHome, 'runtime', 'reports', name + '.md');
      if (!name || !fs.existsSync(file)) return sendJSON(res, 404, { ok: false, error: '没有这份日报' });
      return sendJSON(res, 200, { ok: true, name, content: fs.readFileSync(file, 'utf8') });
    }

    if (u === '/api/task/list') {
      return sendJSON(res, 200, {
        ok: true,
        items: Object.entries(runner.TASKS).filter(([, v]) => !v.contextual).map(([k, v]) => ({ id: k, label: v.label, desc: v.desc })),
        allowedCommands: runner.ALLOWED_SUBCOMMANDS,
      });
    }

    return sendJSON(res, 404, { ok: false, error: '未知接口' });
  }

  // ── 静态页面
  serveStatic(req, res, u);
});

server.listen(cfg.port, cfg.host, () => {
  const url = `http://${cfg.host}:${cfg.port}`;
  console.log('');
  console.log('  招聘工作台已启动');
  console.log('  ─────────────────────────────────');
  console.log('  打开浏览器访问： ' + url);
  console.log('  数据目录：     ' + cfg.dataHome);
  console.log('  台账：         ' + cfg.ledger);
  console.log('');
  console.log('  停止服务：按 Ctrl + C');
  console.log('');
});

function cleanupStorage() {
  if (runner.getState().running) return;
  try {
    const result = cleanupOrphanScreenshots(cfg.dataHome);
    if (result.removed) console.log(`已清理 ${result.removed} 张未引用的旧简历截图。`);
  } catch (e) { console.warn('截图清理已跳过：' + e.message); }
}

cleanupStorage();
setInterval(cleanupStorage, 24 * 60 * 60 * 1000).unref();
