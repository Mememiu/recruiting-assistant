'use strict';

const fs = require('fs');
const path = require('path');

const plain = (value) => String(value || '').replace(/[*`]/g, '').trim();
const quote = (line) => line ? `“${line.slice(0, 110)}”` : '简历中未找到明确证据';

function section(markdown, heading) {
  const lines = String(markdown || '').split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return '';
  const end = lines.findIndex((line, i) => i > start && /^##\s/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

function tableRows(markdown) {
  return String(markdown || '').split(/\r?\n/)
    .filter((line) => /^\s*\|/.test(line) && !/^\s*\|[\s|:-]+\|?\s*$/.test(line))
    .map((line) => line.trim().replace(/^\||\|$/g, '').split('|').map(plain));
}

function readLocalStandards(dataHome, role) {
  if (!dataHome) return { context: '', notes: '' };
  const contextFile = path.join(dataHome, 'CONTEXT.md');
  if (!fs.existsSync(contextFile)) return { context: '', notes: '' };
  const context = fs.readFileSync(contextFile, 'utf8');
  const jobs = tableRows(section(context, /^##\s*四、/));
  const job = jobs.find((row) => row[0] === role);
  const relative = job?.[4];
  const internalDir = path.resolve(dataHome, '01-jd', '_internal');
  const file = relative && path.resolve(dataHome, relative);
  const notes = file && file.startsWith(internalDir + path.sep) && file.endsWith('.md') && fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8') : '';
  return { context, notes };
}

function graduationRule(context, role) {
  return tableRows(section(context, /^##\s*三、/))
    .find((row) => /^毕业届别[（(]/.test(row[0]) &&
      String(role || '').includes(row[0].replace(/^毕业届别[（(]/, '').replace(/[）)]$/, '')))?.[1] || '';
}

function hardgateVerdict({ role, info, dataHome }) {
  const { context } = readLocalStandards(dataHome, role);
  const rules = tableRows(section(context, /^##\s*三、/));
  const education = rules.find((row) => row[0] === '学历线')?.[1] || '';
  if (/在读|在校|未毕业/.test(education) && /已毕业|往届生|非在校生|不在读/.test(String(info || ''))) {
    return '不符';
  }
  const required = graduationRule(context, role);
  const allowed = [...required.matchAll(/20\d{2}/g)].map((m) => Number(m[0]));
  const found = String(info || '').match(/(?:^|\D)((?:20)?\d{2})\s*(?:年应届生|届)/);
  if (!allowed.length || !found) return '待核';
  const year = Number(found[1].length === 2 ? '20' + found[1] : found[1]);
  return allowed.includes(year) ? '通过' : '不符';
}

function reviewResume({ role, resume, conversation, dataHome }) {
  const lines = String(resume || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const chat = String(conversation || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const find = (pattern, source = lines) => source.find((line) => pattern.test(line));
  const { context, notes } = readLocalStandards(dataHome, role);
  const rules = tableRows(section(context, /^##\s*三、/));
  const rule = (dimension) => rules.find((row) => dimension.test(row[0]))?.[1] || '';
  const ageRule = rule(/^年龄线$/);
  const degreeRule = rule(/^学历线$/);
  const roleGraduationRule = graduationRule(context, role);
  const signals = tableRows(section(notes, /^##\s*简历初筛线索/)).slice(1)
    .filter((row) => row[0] && row[1] && !row[0].includes('〔'));
  const result = ['本地简历初筛线索（依据机器识别文字，请对照原图核实）', ''];

  const degree = find(/博士|硕士|本科|大专|专科|高中/);
  const education = find(/(?:20)?\d{2}\s*(?:年应届生|届)|20\d{2}\s*[-—–至]\s*20\d{2}/);
  const age = find(/(?:^|\D)\d{1,2}\s*岁/) || find(/(?:^|\D)\d{1,2}\s*岁/, chat);
  const ageValue = age?.match(/(?:^|\D)(\d{1,2})\s*岁/);
  const cap = ageRule.match(/硬上限\s*(\d+)\s*岁/);
  result.push(`学历：${quote(degree)}${degreeRule ? `（本地要求：${degreeRule}）` : ''}`);
  result.push(`在读/届别：${quote(education)}${roleGraduationRule ? `（本岗要求：${roleGraduationRule}）` : ''}`);
  result.push(`年龄：${quote(age)}${ageValue && cap ? Number(ageValue[1]) <= Number(cap[1])
    ? `（未超过 ${cap[1]} 岁上限）` : `（超过 ${cap[1]} 岁上限，先核对原图）` : ageRule ? `（本地要求：${ageRule}）` : ''}`);

  if (signals.length) {
    result.push('', '岗位笔记中的简历线索：');
    for (const [label, words] of signals.slice(0, 12)) {
      const terms = words.split('/').map((word) => word.trim()).filter(Boolean);
      const evidence = lines.find((line) => terms.some((term) => line.includes(term)));
      result.push(`${label}：${quote(evidence)}`);
    }
  } else {
    result.push('', '本岗未配置简历检索线索，不输出岗位匹配判断。');
    result.push(`经历线索：${quote(find(/项目|负责|开发|设计|产品|工程|实习/))}`);
  }
  result.push('', '建议：对照简历原图和本地岗位标准核实线索；此处不改变台账状态。');
  return result.join('\n');
}

module.exports = { reviewResume, hardgateVerdict };
