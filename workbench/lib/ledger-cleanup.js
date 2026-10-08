'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseCSV } = require('./ledger');
const { roleKey } = require('./inbox');

const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const personKey = (name, role) => `${String(name || '').trim()}\u0000${roleKey(role)}`;
const archiveName = /^[0-9a-f-]{36}\.json$/;

function atomicJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

function strictRows(raw) {
  const [header, ...rows] = parseCSV(raw);
  const required = ['序号', '姓名', '应聘岗位', '状态', '硬门槛', '评级', '来源轮次', '更新时间'];
  if (!header || new Set(header).size !== header.length || rows.some((r) => r.length !== header.length)
      || required.some((name) => !header.includes(name))) {
    throw new Error('台账列数或列名异常，已停止清除，请先检查原文件。');
  }
  const ids = rows.map((r) => r[header.indexOf('序号')]);
  if (!header.includes('序号') || ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error('台账序号缺失或重复，已停止清除。');
  }
  return { header, rows };
}

function normalizeFilters(input) {
  const fields = ['role', 'status', 'hard', 'rating', 'source', 'updatedBefore', 'keyword'];
  const filters = Object.fromEntries(fields.map((key) => [key, String(input?.[key] || '').trim()]));
  if (!Object.values(filters).some(Boolean)) throw new Error('请至少选择一个清除条件。');
  if (filters.keyword.length > 120) throw new Error('关键词过长。');
  if (filters.hard && !['通过', '待核', '不符', '空'].includes(filters.hard)) throw new Error('无效的硬门槛条件。');
  if (filters.source && !['未读', '推荐', '搜索', '其他'].includes(filters.source)) throw new Error('无效的来源条件。');
  if (filters.updatedBefore) {
    const day = filters.updatedBefore;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))
        || new Date(day).toISOString().slice(0, 10) !== day) {
      throw new Error('日期格式不正确。');
    }
  }
  return filters;
}

function sourceCategory(value) {
  if (value.includes('未读')) return '未读';
  if (value.includes('推荐')) return '推荐';
  if (value.includes('搜索')) return '搜索';
  return '其他';
}

class LedgerCleanup {
  constructor(ledger, inbox) {
    this.ledger = ledger;
    this.inbox = inbox;
    this.dir = path.join(ledger.cfg.dataHome, 'runtime', 'ledger-removals');
    this.tickets = new Map();
  }
  activeKeys() {
    return new Set(this.inbox.read().items.map((item) => personKey(item.name, item.role)));
  }
  matches(row, header, filters) {
    const at = (name) => row[header.indexOf(name)] || '';
    if (filters.role && at('应聘岗位') !== filters.role) return false;
    if (filters.status && at('状态') !== filters.status) return false;
    if (filters.hard && (at('硬门槛').match(/^(通过|待核|不符)/)?.[1] || '空') !== filters.hard) return false;
    if (filters.rating && (filters.rating === '空' ? !!at('评级') : at('评级') !== filters.rating)) return false;
    if (filters.source && sourceCategory(at('来源轮次')) !== filters.source) return false;
    if (filters.updatedBefore && (!at('更新时间') || at('更新时间') >= filters.updatedBefore)) return false;
    if (filters.keyword && !row.join(' ').toLowerCase().includes(filters.keyword.toLowerCase())) return false;
    return true;
  }
  preview(input) {
    const filters = normalizeFilters(input);
    const raw = fs.readFileSync(this.ledger.file, 'utf8');
    const { header, rows } = strictRows(raw);
    const active = this.activeKeys();
    const matched = rows.filter((row) => this.matches(row, header, filters));
    const at = (row, name) => row[header.indexOf(name)] || '';
    const blocked = matched.filter((row) => active.has(personKey(at(row, '姓名'), at(row, '应聘岗位')))).length;
    const eligible = matched.filter((row) => !active.has(personKey(at(row, '姓名'), at(row, '应聘岗位'))));
    const items = eligible.map((row) => ({ id: at(row, '序号'), name: at(row, '姓名'), role: at(row, '应聘岗位'),
      status: at(row, '状态'), hard: at(row, '硬门槛'), rating: at(row, '评级'), updated: at(row, '更新时间') }));
    const token = crypto.randomUUID();
    this.tickets.set(token, { created: Date.now(), digest: hash(raw), ids: new Set(items.map((item) => item.id)), filters });
    return { token, items, blocked };
  }
  commit(token, ids) {
    const ticket = this.tickets.get(token);
    if (!ticket || Date.now() - ticket.created > 5 * 60 * 1000) throw new Error('预览已过期，请重新筛选。');
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some((id) => !ticket.ids.has(id))) {
      throw new Error('所选候选人不在预览名单中。');
    }
    const raw = fs.readFileSync(this.ledger.file, 'utf8');
    if (hash(raw) !== ticket.digest) throw new Error('台账已更新，请重新预览后清除。');
    const { header, rows } = strictRows(raw);
    const idIndex = header.indexOf('序号');
    const nameIndex = header.indexOf('姓名'), roleIndex = header.indexOf('应聘岗位');
    const selected = new Set(ids);
    const removed = rows.filter((row) => selected.has(row[idIndex]));
    const positions = rows.flatMap((row, index) => selected.has(row[idIndex]) ? [index] : []);
    if (removed.length !== ids.length) throw new Error('台账名单已更新，请重新预览。');
    const active = this.activeKeys();
    if (removed.some((row) => active.has(personKey(row[nameIndex], row[roleIndex])))) {
      throw new Error('所选候选人进入了未读待办，请先处理或清空本地未读待办。');
    }
    const archiveId = crypto.randomUUID();
    const file = path.join(this.dir, `${archiveId}.json`);
    atomicJSON(file, { id: archiveId, created: new Date().toISOString(), filters: ticket.filters,
      header, rows: removed, positions });
    try { this.ledger.write(header, rows.filter((row) => !selected.has(row[idIndex]))); }
    catch (e) { fs.unlinkSync(file); throw e; }
    this.tickets.delete(token);
    return { removed: removed.length, archiveId };
  }
  archives() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir).filter((name) => archiveName.test(name)).map((name) => {
      const record = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
      return { id: record.id, created: record.created, count: record.rows.length, restored: !!record.restoredAt };
    }).sort((a, b) => b.created.localeCompare(a.created)).slice(0, 20);
  }
  restore(id) {
    if (!/^[0-9a-f-]{36}$/.test(String(id))) throw new Error('无效的清除记录。');
    const file = path.join(this.dir, `${id}.json`);
    if (!fs.existsSync(file)) throw new Error('清除记录不存在。');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record.id !== id || !Array.isArray(record.rows) || !Array.isArray(record.header)) throw new Error('清除记录格式异常。');
    if (record.restoredAt) throw new Error('这批候选人已经恢复。');
    const { header, rows } = this.ledger.readStrict();
    if (JSON.stringify(header) !== JSON.stringify(record.header)) throw new Error('台账列结构已变化，无法自动恢复。');
    if (record.rows.some((row) => row.length !== header.length)) throw new Error('清除记录列数异常。');
    const idIndex = header.indexOf('序号');
    const current = new Map(rows.map((row) => [row[idIndex], row]));
    const present = record.rows.filter((row) => current.has(row[idIndex]));
    if (present.length === record.rows.length && record.rows.every((row) =>
      JSON.stringify(current.get(row[idIndex])) === JSON.stringify(row))) {
      record.restoredAt = new Date().toISOString();
      atomicJSON(file, record);
      return { restored: record.rows.length };
    }
    if (present.length) throw new Error('台账中已有相同序号，无法自动恢复。');
    const restored = [...rows];
    record.rows.forEach((row, index) => restored.splice(Math.min(record.positions?.[index] ?? restored.length, restored.length), 0, row));
    this.ledger.write(header, restored);
    record.restoredAt = new Date().toISOString();
    atomicJSON(file, record);
    return { restored: record.rows.length };
  }
}

module.exports = { LedgerCleanup };
