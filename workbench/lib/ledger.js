'use strict';
/**
 * 台账读写 —— 工作台的数据层
 *
 * 设计约束（不要破坏）：
 *  1. CSV 是唯一事实源。写盘前必须备份，坏了没有第二份。
 *  2. 零依赖：用 Node 内置模块，不装任何 npm 包（用户无技术背景，装包坏了难修）。
 *  3. 只读写配置的数据目录，不做任何平台动作。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── CSV 解析/序列化（自己实现，处理引号内逗号与换行）

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

function toCSV(rows) {
  return rows.map((r) => r.map((v) => {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n') + '\n';
}

// ── 台账

class Ledger {
  constructor(cfg) {
    this.cfg = cfg;
    this.file = path.join(cfg.dataHome, cfg.ledger);
    this.backupDir = path.join(cfg.dataHome, cfg.backupDir);
  }

  read() {
    if (!fs.existsSync(this.file)) throw new Error('台账文件不存在: ' + this.file);
    const raw = fs.readFileSync(this.file, 'utf8');
    const rows = parseCSV(raw);
    if (!rows.length) throw new Error('台账为空');
    const header = rows[0];
    const data = rows.slice(1).map((r) => {
      while (r.length < header.length) r.push('');
      return r.slice(0, header.length);
    });
    return { header, rows: data };
  }

  readStrict() {
    const [header, ...rows] = parseCSV(fs.readFileSync(this.file, 'utf8'));
    if (!header || new Set(header).size !== header.length || rows.some((r) => r.length !== header.length)) {
      throw new Error('台账列数或列名异常，已停止写入，请先检查原文件。');
    }
    return { header, rows };
  }

  /** New inbox writes preserve every column and replace only a fully serialized file. */
  write(header, rows) {
    if (new Set(header).size !== header.length || rows.some((r) => r.length !== header.length)) throw new Error('台账列数异常，未保存。');
    const temp = this.file + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temp, toCSV([header, ...rows]), { mode: 0o600 });
      const backupTo = this.backup();
      fs.renameSync(temp, this.file);
      return backupTo;
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }

  /** 写盘前先备份（保留最近 20 份） */
  backup() {
    if (!fs.existsSync(this.backupDir)) fs.mkdirSync(this.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, '-') + '-' + crypto.randomUUID();
    const dest = path.join(this.backupDir, `dedup-ledger.bak-${stamp}.csv`);
    fs.copyFileSync(this.file, dest);
    this._trimBackups();
    return dest;
  }

  _trimBackups() {
    const files = fs.readdirSync(this.backupDir)
      .filter((f) => f.startsWith('dedup-ledger.bak-'))
      .sort();
    while (files.length > 20) {
      fs.unlinkSync(path.join(this.backupDir, files.shift()));
    }
  }

  /**
   * 更新一个单元格
   * @param {string} name  姓名（定位行，比行号稳，因为会排序）
   * @param {string} col   列名
   * @param {string} value 新值
   */
  updateCell(name, col, value, id) {
    const { header, rows } = this.readStrict();
    const ci = header.indexOf(col);
    if (ci < 0) throw new Error('不存在的列: ' + col);
    const matches = rows.filter((r) => r[header.indexOf('姓名')] === name
      && (id == null || r[header.indexOf('序号')] === String(id)));
    if (matches.length > 1) throw new Error('有同名候选人，请刷新后按台账序号保存。');
    const row = matches[0];
    if (!row) throw new Error('台账里没有这个人: ' + name);
    const before = row[ci];
    if (before === value) return { changed: false };
    row[ci] = value;
    const backupTo = this.write(header, rows);
    return { changed: true, before, after: value, backup: backupTo };
  }

  /** 汇总统计，供图表用 */
  stats() {
    const { header, rows } = this.read();
    const iRole = header.indexOf('应聘岗位');
    const iStatus = header.indexOf('状态');
    const iHard = header.indexOf('硬门槛');
    const iResult = header.indexOf('处理结果');
    const iReason = header.indexOf('归因原因');
    const iRating = header.indexOf('评级');
    const iSource = header.indexOf('来源轮次');

    const count = (idx) => {
      const m = {};
      for (const r of rows) {
        const k = (idx >= 0 ? r[idx] : '') || '(未填)';
        m[k] = (m[k] || 0) + 1;
      }
      return Object.entries(m).sort((a, b) => b[1] - a[1]);
    };

    return {
      total: rows.length,
      byRole: count(iRole),
      byStatus: count(iStatus),
      byHardGate: count(iHard),
      byResult: count(iResult),
      byReason: count(iReason),
      byRating: count(iRating),
      bySource: count(iSource),
    };
  }
}

module.exports = { Ledger, parseCSV, toCSV };
