'use strict';
/**
 * 日报生成
 *
 * 原则：**数字全部在本地算，AI 只负责把事实写成通顺的中文**。
 * 这样既不会算错（LLM 算数不靠谱），又省 token（它不用去数表格）。
 */

const fs = require('fs');
const path = require('path');
const { chat } = require('./ai');

/** 本地算出的事实，不经过 AI */
function collectFacts(ledger) {
  const s = ledger.stats();
  const { header, rows } = ledger.read();
  const iVerify = header.indexOf('待验证点');
  const iName = header.indexOf('姓名');
  const iRating = header.indexOf('评级');
  const iStatus = header.indexOf('状态');

  const pending = rows
    .filter((r) => iVerify >= 0 && r[iVerify].trim())
    .map((r) => ({ name: r[iName], rating: r[iRating], point: r[iVerify] }));

  const promoted = rows
    .filter((r) => r[iStatus] === '初筛通过' || r[iStatus] === '面试中')
    .map((r) => ({ name: r[iName], rating: r[iRating] }));

  return { stats: s, pending, promoted, total: rows.length };
}

function markdown(facts, aiText, dateStr) {
  const s = facts.stats;
  const row = (k, arr) => arr.map(([a, b]) => `| ${a} | ${b} |`).join('\n');

  const lines = [];
  lines.push(`# 招聘日报 ${dateStr}`);
  lines.push('');
  lines.push('> 数字部分由工作台本地统计，不经过模型；分析与建议由模型生成。');
  lines.push('');
  lines.push('## 一、概况');
  lines.push('');
  lines.push(`- 台账共 **${facts.total}** 人`);
  const st = Object.fromEntries(s.byStatus);
  lines.push(`- 待初筛 ${st['待初筛'] || 0} · 初筛通过 ${st['初筛通过'] || 0} · 已排除 ${st['已排除'] || 0}`);
  const hg = Object.fromEntries(s.byHardGate);
  lines.push(`- 硬门槛：通过 ${hg['通过'] || 0} · 待核 ${hg['待核'] || 0} · 不符 ${hg['不符'] || 0} · 未填 ${hg['(未填)'] || 0}`);
  lines.push('');
  lines.push('## 二、按岗位');
  lines.push('');
  lines.push('| 岗位 | 人数 |');
  lines.push('|---|---|');
  lines.push(row('', s.byRole));
  lines.push('');
  lines.push('## 三、归因');
  lines.push('');
  lines.push('| 原因 | 人数 |');
  lines.push('|---|---|');
  const reasons = s.byReason.filter((x) => x[0] !== '(未填)');
  lines.push(reasons.length ? row('', reasons) : '| （还没有记录归因） | 0 |');
  lines.push('');
  if (facts.promoted.length) {
    lines.push('## 四、已通过初筛');
    lines.push('');
    for (const p of facts.promoted) lines.push(`- **${p.name}** ${p.rating || ''}`);
    lines.push('');
  }
  if (facts.pending.length) {
    lines.push(`## ${facts.promoted.length ? '五' : '四'}、待你确认（面试时顺口问）`);
    lines.push('');
    for (const p of facts.pending) lines.push(`- **${p.name}**：${p.point}`);
    lines.push('');
  }
  if (aiText) {
    lines.push('---');
    lines.push('');
    lines.push('## 模型分析与建议');
    lines.push('');
    lines.push(aiText.trim());
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * 生成日报
 * @returns {{ok:boolean, file?:string, usage?:object, model?:string, error?:string}}
 */
async function generate(cfg, ledger) {
  const facts = collectFacts(ledger);
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const dateStr = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

  const prompt = [
    '下面是今天的招聘数据（数字已经统计好，不要改动、不要重新计算）：',
    '',
    JSON.stringify({
      台账人数: facts.total,
      状态分布: Object.fromEntries(facts.stats.byStatus),
      硬门槛: Object.fromEntries(facts.stats.byHardGate),
      岗位分布: Object.fromEntries(facts.stats.byRole),
      归因: facts.stats.byReason.filter((x) => x[0] !== '(未填)'),
      待确认事项: facts.pending,
    }, null, 2),
    '',
    '请写两段，中文，平实分析师口吻，不要口号：',
    '1. **观察**：基于上面这些数字，今天最值得注意的 2-3 条（要有依据，样本小就说明样本小）',
    '2. **建议动作**：今天具体该干什么，最多 3 条，要可执行（不是"加强招聘力度"这种）',
    '',
    '不要重复罗列上面的数字（表格里已经有了），只写数字背后的意思。',
  ].join('\n');

  const r = await chat({
    cheap: true,
    kind: 'report',
    system: '你是招聘分析师。克制、讲证据、不编数据。数字已给定，你只负责解读。',
    prompt,
  });

  const text = r.ok ? r.content : `> ⚠️ 模型分析未生成：${r.error}`;

  const dir = path.join(cfg.dataHome, 'runtime', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${dateStr}.md`);
  fs.writeFileSync(file, markdown(facts, text, dateStr), 'utf8');

  return { ok: true, file, usage: r.usage || {}, model: r.model || '', ms: r.ms || 0, aiOk: r.ok };
}

/** 列出已有日报 */
function list(cfg) {
  const dir = path.join(cfg.dataHome, 'runtime', 'reports');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f.replace(/\.md$/, ''), file: f, mtime: st.mtime.toISOString().slice(0, 10), size: st.size };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

module.exports = { generate, list, collectFacts };
