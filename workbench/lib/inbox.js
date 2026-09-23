'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const roleKey = (s) => String(s || '').normalize('NFKC').replace(/\s/g, '').toLowerCase();
const personKey = (name, role) => hash(JSON.stringify([name.trim(), roleKey(role)]));
const sourcePattern = /^\d{8}(?:-\d{4}(?:\d{2})?(?:-\d+)?)?-boss-unread\.txt$/;

function atomicJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

/** Only accept the observed CLI list format. Unknown/partial output is not an empty inbox. */
function parseUnread(raw) {
  const text = raw.replace(/\u001b\[[0-9;]*m/g, '').replace(/\r/g, '');
  const header = text.match(/^未读筛选[：:]共\s*(\d+)\s*人.*$/m);
  if (!header || !text.includes('候选人明细：')) throw new Error('未识别到完整未读列表，请检查登录状态和抓取输出后重新拉取。');
  const body = text.slice(text.indexOf('候选人明细：') + '候选人明细：'.length).trim();
  const total = Number(header[1]);
  if (!total) {
    if (!/^暂无[。.]?$/.test(body)) throw new Error('未读数量与明细不一致，未修改待办或台账。');
    return [];
  }
  const blocks = body.split(/\n(?=\s*(?:-\s*)?\d+\.\s)/);
  const items = blocks.map((block, index) => {
    const line = block.match(/^\s*(?:-\s*)?(\d+)\.\s+([^｜\n]+)｜([\s\S]+)$/);
    if (!line || Number(line[1]) !== index + 1) throw new Error('未读明细格式不完整，未修改待办或台账。');
    const name = line[2].trim();
    const rest = line[3];
    const messageAt = rest.indexOf('｜消息:');
    const meta = (messageAt >= 0 ? rest.slice(0, messageAt) : rest).split('｜');
    const role = /^(未读|时间|消息):/.test(meta[0]) ? '' : meta.shift().trim();
    const unread = meta.find((s) => /^未读:\d+$/.test(s));
    if (!name || !unread) throw new Error('未读明细缺少姓名或未读数量，未修改待办或台账。');
    const time = (meta.find((s) => s.startsWith('时间:')) || '').slice(3);
    const message = messageAt >= 0 ? rest.slice(messageAt + 4).trim() : '';
    const id = personKey(name, role);
    return { id, name, role, unread: Number(unread.slice(3)), time, message,
      signature: hash(JSON.stringify([id, time, message, unread])), handled: false };
  });
  if (items.length !== total) throw new Error(`列表声称 ${total} 人，但仅解析到 ${items.length} 人。请重新拉取。`);
  if (new Set(items.map((i) => i.id)).size !== items.length) throw new Error('列表中存在同名同岗，无法可靠区分。请在 BOSS 核实后再整理。');
  return items;
}

class Inbox {
  constructor(cfg, ledger) {
    this.cfg = cfg;
    this.ledger = ledger;
    this.dir = path.join(cfg.dataHome, 'runtime', 'raw');
    this.file = path.join(cfg.dataHome, 'runtime', 'inbox.json');
  }
  read() {
    if (!fs.existsSync(this.file)) return { version: 1, items: [], source: null };
    const state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (state.version !== 1 || !Array.isArray(state.items)) throw new Error('待办文件格式异常，请保留文件并检查，未覆盖原记录。');
    if (state.archive !== undefined && !Array.isArray(state.archive)) throw new Error('待办历史格式异常，请保留文件并检查，未覆盖原记录。');
    return state;
  }
  latest() {
    if (!fs.existsSync(this.dir)) return null;
    const files = fs.readdirSync(this.dir).filter((f) => sourcePattern.test(f));
    const sortKey = (f) => f.replace('-boss-unread.txt', '').replace(/-/g, '').padEnd(20, '0');
    return files.sort((a, b) => sortKey(b).localeCompare(sortKey(a)))[0] || null;
  }
  source(name) {
    if (!sourcePattern.test(name || '')) throw new Error('无效的未读文件。');
    return fs.readFileSync(path.join(this.dir, name), 'utf8');
  }
  enrich(items) {
    const { header, rows } = this.ledger.read();
    const at = (row, col) => row[header.indexOf(col)] || '';
    return items.map((item) => {
      const matches = rows.filter((r) => at(r, '姓名') === item.name && roleKey(at(r, '应聘岗位')) === roleKey(item.role));
      const row = matches.length === 1 ? matches[0] : null;
      const candidate = row ? Object.fromEntries(header.map((h, i) => [h, row[i]])) : null;
      const sameName = rows.filter((r) => at(r, '姓名') === item.name).length;
      let next = '先读取完整沟通，核实岗位意向与简历，再记录筛选结果。';
      if (/简历|\[图片\]|\[文件\]/.test(item.message)) next = '候选人提到了简历或附件：先读完整沟通，再查看材料，避免只凭消息摘要判断。';
      if (/秋招|校招|转正|正式岗/.test(item.message)) next = '先核实候选人想找实习还是正式岗，再继续筛选。';
      if (candidate && candidate['待验证点']) next = '优先核实：' + candidate['待验证点'];
      if (candidate && /排除|已拒/.test(candidate['状态'])) next = '此前已排除或拒绝：先核对这次新消息与历史原因，保留原判断，必要时人工复核。';
      const conflict = !item.role ? '缺少应聘岗位，请先在 BOSS 核实，未自动入账。'
        : matches.length > 1 ? '台账中存在同名同岗，请人工核对，未自动合并。' : '';
      const chatBlocked = conflict || (sameName > 1 ? '存在同名候选人，当前 CLI 按姓名打开会话，请在 BOSS 中核对，避免读错人。' : '');
      const hasProfile = path.basename(item.name) === item.name
        && fs.existsSync(path.join(this.cfg.dataHome, '03-interview', item.name + '.md'));
      return { ...item, candidate, conflict, chatBlocked, next, hasProfile };
    });
  }
  list() {
    const state = this.read();
    const latest = this.latest();
    let preview = [], warning = '';
    if (latest && latest !== state.source) {
      try { preview = parseUnread(this.source(latest)).map((x) => ({ ...x, source: latest })); }
      catch (e) { warning = e.message; }
    }
    return { source: state.source, latest, needsImport: !!latest && latest !== state.source && !warning,
      warning, items: this.enrich(state.items), preview: this.enrich(preview) };
  }
  importSource(source) {
    const items = parseUnread(this.source(source)); // Validate before touching either file.
    const state = this.read();
    const { header, rows } = this.ledger.readStrict();
    const required = ['序号', '姓名', '应聘岗位', '状态', '来源轮次', '备注'];
    if (required.some((h) => !header.includes(h))) throw new Error('台账缺少必要列，未导入。');
    const at = (r, col) => r[header.indexOf(col)] || '';
    let nextId = Math.max(0, ...rows.map((r) => Number(at(r, '序号')) || 0));
    let added = 0, linked = 0, unresolved = 0;
    for (const item of items) {
      const matches = rows.filter((r) => at(r, '姓名') === item.name && roleKey(at(r, '应聘岗位')) === roleKey(item.role));
      if (!item.role || matches.length > 1) { unresolved++; continue; }
      if (matches.length) { linked++; continue; } // Preserve progressed statuses and all existing fields.
      const values = { '序号': String(++nextId), '姓名': item.name, '应聘岗位': item.role,
        '状态': '待初筛', '来源轮次': source.slice(0, 8) + 'boss未读',
        '备注': `【未读摘要】${item.message}`, '更新时间': source.slice(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') };
      rows.push(header.map((h) => values[h] || '')); added++;
    }
    if (added) this.ledger.write(header, rows);
    const previous = new Map([...(state.archive || []), ...state.items].map((i) => [i.id, i]));
    const current = items.map((item) => {
      item.signature = hash(source.slice(0, 8) + ':' + item.signature);
      const old = previous.get(item.id);
      const unchanged = old && old.signature === item.signature;
      return { ...old, ...item, source,
        handled: unchanged ? old.handled : false,
        // A newer preview must not masquerade as already-fetched full conversation.
        chat: unchanged ? old.chat : null,
        resume: old ? old.resume : null,
        history: old ? (old.history || []) : [] };
    });
    const currentIds = new Set(current.map((item) => item.id));
    state.archive = [...previous.values()].filter((item) => !currentIds.has(item.id));
    state.items = current; state.source = source;
    atomicJSON(this.file, state);
    return { added, linked, unresolved, count: items.length };
  }
  get(id, signature) {
    const item = this.read().items.find((i) => i.id === id);
    if (!item || (signature && item.signature !== signature)) throw new Error('待办已更新，请刷新后重新操作。');
    return this.enrich([item])[0];
  }
  followup(id, signature, note, handled) {
    const item = this.get(id, signature);
    if (typeof handled !== 'boolean' || typeof note !== 'string' || note.length > 3000) throw new Error('跟进记录格式不正确。');
    if (handled && !note.trim()) throw new Error('请先填写处理记录，再标记已处理。');
    const state = this.read();
    const target = state.items.find((i) => i.id === item.id);
    const now = new Date().toISOString();
    if (note.trim() && item.candidate && !item.conflict) {
      const { header, rows } = this.ledger.readStrict();
      const row = rows.find((r) => r[header.indexOf('序号')] === item.candidate['序号']);
      const idx = header.indexOf('备注');
      if (!row || idx < 0) throw new Error('台账记录发生变化，请刷新后重试。');
      row[idx] = [row[idx], `【未读跟进 ${now}】${note.trim()}`].filter(Boolean).join('｜');
      this.ledger.write(header, rows);
    }
    target.handled = handled;
    target.history = [...(target.history || []), { at: now, note: note.trim(), handled }];
    atomicJSON(this.file, state);
  }
  chatTarget(id, signature) {
    const item = this.get(id, signature);
    if (item.chatBlocked) throw new Error(item.chatBlocked);
    if (/["\r\n\u0000]/.test(item.name)) throw new Error('姓名含特殊字符，请在 BOSS 核对。');
    return item;
  }
  saveChat(id, signature, text) {
    const item = this.get(id, signature);
    const name = text.match(/^姓名:\s*(.+)$/m);
    const role = text.match(/^沟通职位:\s*(.+)$/m);
    if (!name || name[1].trim() !== item.name || !role || roleKey(role[1]) !== roleKey(item.role)) {
      throw new Error('会话姓名或岗位未能核对，未保存为此人的沟通记录。请在 BOSS 核实。');
    }
    const state = this.read();
    state.items.find((i) => i.id === id).chat = { text, fetchedAt: new Date().toISOString() };
    atomicJSON(this.file, state);
  }
  saveResume(id, signature, file, text) {
    this.chatTarget(id, signature);
    const dir = path.join(this.cfg.dataHome, 'runtime', 'resumes', 'inbox');
    const full = path.resolve(dir, file);
    if (path.dirname(full) !== dir || !fs.statSync(full).isFile()) throw new Error('简历截图路径无效。');
    const state = this.read();
    state.items.find((i) => i.id === id).resume = {
      file: path.basename(full), text: String(text || '').slice(0, 50000), fetchedAt: new Date().toISOString(), review: null,
    };
    atomicJSON(this.file, state);
  }
  saveReview(id, signature, review) {
    const item = this.get(id, signature);
    if (!item.resume || !item.resume.text) throw new Error('尚无可评估的简历文字。');
    const state = this.read();
    state.items.find((i) => i.id === id).resume.review = {
      text: String(review.text || '').slice(0, 10000), model: review.model,
      at: new Date().toISOString(), basedOn: item.resume.fetchedAt,
    };
    atomicJSON(this.file, state);
  }
  resumeFile(id, signature) {
    const item = this.get(id, signature);
    if (!item.resume?.file || path.basename(item.resume.file) !== item.resume.file) throw new Error('尚未保存简历截图。');
    const file = path.join(this.cfg.dataHome, 'runtime', 'resumes', 'inbox', item.resume.file);
    if (!fs.existsSync(file)) throw new Error('简历截图已丢失，请重新查看。');
    return file;
  }
}

module.exports = { Inbox, parseUnread, roleKey };
