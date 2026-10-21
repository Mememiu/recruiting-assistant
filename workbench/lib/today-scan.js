'use strict';
/**
 * 今日状态扫描 —— 「recruit-today」的共享实现
 *
 * 只读：不碰 BOSS、不改任何文件。把所有事实源（CONTEXT.md / 台账 / inbox.json /
 * 对内笔记的关键词迭代表）汇总成一张「今天该干什么」的决策卡。
 *
 * 两个入口共用这一份实现，保证看到的永远是同一份判断：
 *   1. 对话形态：skills/recruit-today/scripts/today-scan.sh → 本模块 → 人话决策卡
 *   2. 工作台：/api/today → 本模块 → 同一份数据渲染成可点面板
 *
 * 设计纪律（与整套系统一致）：
 *   - 只从文件读状态，不发明新事实源；CONTEXT.md 仍是唯一真值
 *   - 所有数字本地算，不过 AI
 *   - 不执行任何动作，只给建议；动作由用户一句话触发，走原有各 skill/任务流程
 */

const fs = require('fs');
const path = require('path');
const { parseCSV } = require('./ledger');

// ── CONTEXT.md 解析（表格/散文双格式，与 resume-review.js 的 ruleRows 同思路）

function section(md, heading) {
  const lines = String(md || '').split(/\r?\n/);
  const s = lines.findIndex((l) => heading.test(l));
  if (s < 0) return '';
  const e = lines.findIndex((l, i) => i > s && /^##\s/.test(l));
  return lines.slice(s + 1, e < 0 ? undefined : e).join('\n');
}

function rowsOf(text) {
  const table = String(text).split(/\r?\n/)
    .filter((l) => /^\s*\|/.test(l) && !/^\s*\|[\s|:-]+\|?\s*$/.test(l))
    .map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.replace(/[*`]/g, '').trim()));
  if (table.length) return table;
  return String(text).split(/\r?\n/)
    .map((l) => l.match(/^\s*[-*]\s*([^：:]+)[：:]\s*(.+)$/))
    .filter(Boolean).map((m) => [m[1].replace(/\*\*/g, '').trim(), m[2].trim()]);
}

function readRoles(dataHome) {
  const file = path.join(dataHome, 'CONTEXT.md');
  if (!fs.existsSync(file)) return { roles: [], contextMissing: true };
  const ctx = fs.readFileSync(file, 'utf8');
  const rows = rowsOf(section(ctx, /^##\s*四、/));
  return {
    contextMissing: false,
    roles: rows.filter((r) => r[0] && !/^（|待梳理|岗位$/.test(r[0])).map((r) => ({
      name: r[0],
      priority: r[1] || '',
      status: (r[2] || '').trim(),
      internal: r[4] || '',   // 对内笔记相对路径
    })),
  };
}

function readLedgerSafe(dataHome, ledgerRel) {
  const file = path.join(dataHome, ledgerRel);
  if (!fs.existsSync(file)) return null;
  const all = parseCSV(fs.readFileSync(file, 'utf8'));
  if (!all.length) return null;
  const header = all[0];
  const rows = all.slice(1).filter((r) => r.some((c) => String(c || '').trim()));
  const at = (row, col) => row[header.indexOf(col)] || '';
  return { header, rows, at };
}

function readInbox(dataHome) {
  const file = path.join(dataHome, 'runtime', 'inbox.json');
  if (!fs.existsSync(file)) return { items: [], source: null };
  try {
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { items: Array.isArray(st.items) ? st.items : [], source: st.source || null };
  } catch { return { items: [], source: null, broken: true }; }
}

/** 对内笔记里的关键词迭代表：最近一轮的有效词/无效词 */
function readIteration(dataHome, relPath) {
  if (!relPath) return null;
  const file = path.resolve(dataHome, relPath);
  const internalDir = path.resolve(dataHome, '01-jd', '_internal');
  if (!file.startsWith(internalDir + path.sep) || !fs.existsSync(file)) return null;
  const md = fs.readFileSync(file, 'utf8');
  const rows = rowsOf(section(md, /##\s*关键词迭代表/));
  if (rows.length < 2) return null;
  const filled = rows.slice(1).filter((r) => r[1] && r[1] !== 'YYYY-MM-DD' && (r[2] || r[3]));
  if (!filled.length) return null;
  const last = filled[filled.length - 1];
  return { round: last[0] || '', date: last[1] || '', good: last[2] || '', bad: last[3] || '', rounds: filled.length };
}

// ── 主扫描

function scan(dataHome, ledgerRel) {
  const { roles, contextMissing } = readRoles(dataHome);
  const ledger = readLedgerSafe(dataHome, ledgerRel);
  const inbox = readInbox(dataHome);
  const actions = [];      // 建议动作（带触发指令，用户复制一句话即可）
  const warnings = [];

  if (contextMissing) {
    warnings.push('找不到 CONTEXT.md —— 这个工作区还没初始化？说「初始化招聘工作区」');
  }
  if (!ledger) {
    warnings.push('找不到台账 ' + ledgerRel + ' —— 先初始化工作区，或确认数据目录没挪动');
  }

  // 台账派生数字
  const byRole = new Map();
  let totals = { total: 0, toScreen: 0, passed: 0, greeted: 0, noHardGate: 0, noRating: 0, repliedPending: 0 };
  if (ledger) {
    for (const row of ledger.rows) {
      const role = ledger.at(row, '应聘岗位') || '(未填岗位)';
      const status = ledger.at(row, '状态').trim();
      const hard = ledger.at(row, '硬门槛').trim();
      const rating = ledger.at(row, '评级').trim();
      totals.total++;
      if (status === '待初筛') totals.toScreen++;
      if (status === '初筛通过' || status === '面试中') totals.passed++;
      if (status === '已打招呼') totals.greeted++;
      if (!hard) totals.noHardGate++;
      if (!rating) totals.noRating++;
      if (status === '已回复') totals.repliedPending++;
      if (!byRole.has(role)) byRole.set(role, { role, total: 0, toScreen: 0, noHardGate: 0, passed: 0, greeted: 0 });
      const r = byRole.get(role);
      r.total++;
      if (status === '待初筛') r.toScreen++;
      if (status === '初筛通过' || status === '面试中') r.passed++;
      if (status === '已打招呼') r.greeted++;
      if (!hard) r.noHardGate++;
    }
  }

  // 未读按岗位分组
  const unreadByRole = new Map();
  for (const it of inbox.items) {
    if (it.handled) continue;
    const role = it.role || '(未关联岗位)';
    unreadByRole.set(role, (unreadByRole.get(role) || 0) + 1);
  }
  const unreadTotal = [...unreadByRole.values()].reduce((a, b) => a + b, 0);

  // 岗位卡片（按优先级数字升序，无优先级的排最后）
  const roleCards = roles.map((role) => {
    const stat = byRole.get(role.name) || { total: 0, toScreen: 0, noHardGate: 0, passed: 0, greeted: 0 };
    const unread = unreadByRole.get(role.name) || 0;
    const needsGrill = /待梳理|未梳理/.test(role.status);
    const iter = readIteration(dataHome, role.internal);
    return { ...role, ...stat, unread, needsGrill, iter };
  });
  // 台账里有、但 CONTEXT 没登记的岗位（提醒补登记，避免状态分裂）
  for (const [name, stat] of byRole) {
    if (!roles.some((r) => r.name === name) && name !== '(未填岗位)') {
      roleCards.push({ name, status: '(未在 CONTEXT 登记)', ...stat, unread: unreadByRole.get(name) || 0, needsGrill: false, iter: null });
      warnings.push(`台账里有「${name}」的人，但 CONTEXT「在招岗位」表没登记它 —— 建议补一行，否则工作流路由可能漏掉这个岗`);
    }
  }
  roleCards.sort((a, b) => {
    const pa = parseInt(String(a.priority).replace(/\D/g, ''), 10) || 99;
    const pb = parseInt(String(b.priority).replace(/\D/g, ''), 10) || 99;
    return pa - pb;
  });

  // 决策卡：按优先级生成建议动作（每条都带一句可直接复制的话）
  for (const rc of roleCards) {
    if (rc.needsGrill) {
      actions.push({
        role: rc.name, kind: 'grill', urgency: 2,
        why: `这个岗还没梳理过标准（CONTEXT 状态=「${rc.status || '待梳理'}」），没有标准就没法初筛`,
        say: `帮我梳理${rc.name}岗位`,
        free: true,
      });
      continue;
    }
    if (rc.unread > 0) {
      actions.push({
        role: rc.name, kind: 'unread', urgency: 1,
        why: `${rc.unread} 个未读候选人等你回复，趁热聊转化率最高`,
        say: `处理${rc.name}的未读`,
        free: true,
      });
    }
    if (rc.noHardGate > 0) {
      actions.push({
        role: rc.name, kind: 'hardgate', urgency: 3,
        why: `${rc.noHardGate} 人还没过硬门槛（年龄/学历/届别），先筛掉不合规的再花精力`,
        say: `批量硬门槛筛选${rc.name}`,
        free: true,
      });
    }
    if (rc.toScreen > 0) {
      actions.push({
        role: rc.name, kind: 'screen', urgency: 4,
        why: `${rc.toScreen} 人待初筛 —— 命脉判断在打招呼之前做完，别浪费畅聊卡`,
        say: `初筛${rc.name}的候选人`,
        free: true,
      });
    }
    if (rc.passed > 0 && rc.greeted === 0 && !rc.unread) {
      actions.push({
        role: rc.name, kind: 'greet', urgency: 5,
        why: `${rc.passed} 人已过初筛但还没打招呼 —— 推荐池会重排，久了人就丢了`,
        say: `给${rc.name}合格的人打招呼`,
        free: false,
      });
    }
    if (rc.iter && rc.iter.rounds >= 3) {
      actions.push({
        role: rc.name, kind: 'mapping', urgency: 6,
        why: `搜了 ${rc.iter.rounds} 轮还有大量待筛，可能标准或渠道要调 —— 值得做一次市场盘点`,
        say: `盘一下${rc.name}的市场`,
        free: true,
      });
    }
  }
  if (totals.greeted > 0) {
    actions.push({
      role: '(全岗位)', kind: 'followup', urgency: 3,
      why: `${totals.greeted} 人已打招呼，超 48 小时没回复的可以追一下`,
      say: '看看哪些人打招呼后没回复',
      free: true,
    });
  }
  actions.push({
    role: '(全岗位)', kind: 'report', urgency: 9,
    why: '收工前出一份日报，把今天的进展和待你拍板的事汇总',
    say: '出今天的招聘日报',
    free: true,
  });
  actions.sort((a, b) => a.urgency - b.urgency);

  return {
    at: new Date().toISOString(),
    contextMissing,
    ledgerFound: !!ledger,
    totals,
    unreadTotal,
    unreadByRole: [...unreadByRole.entries()],
    roleCards,
    actions,
    warnings,
  };
}

// ── 人话决策卡（对话形态的输出）

function toText(s) {
  const L = [];
  const dateStr = s.at.slice(0, 10);
  L.push(`招聘驾驶舱 · ${dateStr}（只读扫描，未做任何动作）`);
  L.push('');
  if (s.contextMissing || !s.ledgerFound) {
    s.warnings.forEach((w) => L.push('⚠️ ' + w));
    L.push('');
    L.push('工作区还没就绪 —— 说「初始化招聘工作区」先搭起来。');
    return L.join('\n');
  }

  L.push(`总览：台账 ${s.totals.total} 人 · 待初筛 ${s.totals.toScreen} · 未过硬门槛 ${s.totals.noHardGate} · 已过初筛 ${s.totals.passed} · 已打招呼 ${s.totals.greeted} · 未读待办 ${s.unreadTotal}`);
  L.push('');

  if (!s.roleCards.length) {
    L.push('CONTEXT「在招岗位」表还是空的 —— 说「帮我梳理XX岗位」开始。');
    L.push('');
  }

  for (const rc of s.roleCards) {
    const pri = rc.priority ? `（优先级 ${rc.priority}）` : '';
    L.push(`▸ ${rc.name}${pri} — ${rc.status || '(状态未填)'}`);
    const bits = [];
    if (rc.unread) bits.push(`未读 ${rc.unread}`);
    if (rc.noHardGate) bits.push(`待过硬门槛 ${rc.noHardGate}`);
    if (rc.toScreen) bits.push(`待初筛 ${rc.toScreen}`);
    if (rc.passed) bits.push(`已过初筛 ${rc.passed}`);
    if (rc.greeted) bits.push(`已打招呼 ${rc.greeted}`);
    if (!bits.length) bits.push('暂无候选人');
    L.push('   ' + bits.join(' · '));
    if (rc.needsGrill) L.push('   ⚠️ 标准未梳理 —— 先做这个，否则初筛没有依据');
    if (rc.iter && rc.iter.rounds) {
      const parts = [];
      if (rc.iter.good) parts.push(`有效词「${rc.iter.good.split(/[/、,，]/).slice(0, 3).join('/')}」`);
      if (rc.iter.bad) parts.push(`无效词「${rc.iter.bad.split(/[/、,，]/).slice(0, 3).join('/')}」`);
      if (parts.length) L.push(`   搜索经验（${rc.iter.rounds} 轮）：${parts.join('，')}`);
    }
    L.push('');
  }

  if (s.warnings.length) {
    s.warnings.forEach((w) => L.push('⚠️ ' + w));
    L.push('');
  }

  L.push('建议顺序（从最重要往下）：');
  let i = 1;
  for (const a of s.actions.slice(0, 8)) {
    L.push(`  ${i++}. [${a.role}] ${a.why}`);
    L.push(`     说：「${a.say}」`);
  }
  if (s.actions.length > 8) L.push(`  ……还有 ${s.actions.length - 8} 条（出日报等收尾动作）`);
  L.push('');
  L.push('一句话启动：说「按推荐来」= 按上面顺序从上往下做；或直接说上面任意一句。');
  return L.join('\n');
}

module.exports = { scan, toText };
