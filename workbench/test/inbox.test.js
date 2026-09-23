'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Inbox, parseUnread } = require('../lib/inbox');
const { Ledger, toCSV } = require('../lib/ledger');
const runner = require('../lib/runner');
const { reviewResume, hardgateVerdict } = require('../lib/resume-review');

const header = ['序号', '姓名', '应聘岗位', '状态', '来源轮次', '备注', '硬门槛', '更新时间', '额外扩展列'];
const list = (lines) => `未读筛选：共 ${lines.length} 人（从全量列表按未读角标筛选）。\n候选人明细：${lines.length ? '\n' + lines.join('\n') : '暂无。'}`;
const sample = list(['1. 李同学｜岗位甲｜未读:2｜时间:10:10｜消息:我可以发简历吗？', '2. 王同学｜岗位乙｜未读:1｜时间:10:08｜消息:你好']);
function setup(t, text = sample) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recruit-inbox-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'raw'));
  const cfg = { dataHome: root, ledger: 'ledger.csv', backupDir: 'backup' };
  fs.writeFileSync(path.join(root, 'ledger.csv'), toCSV([header, ['7', '李同学', '岗位甲', '面试中', '旧来源', '旧备注', '通过', '2026-09-20', '保留我']]));
  fs.mkdirSync(path.join(root, 'runtime', 'raw'), { recursive: true });
  const source = '20260923-1111-boss-unread.txt';
  fs.writeFileSync(path.join(root, 'runtime', 'raw', source), text);
  const ledger = new Ledger(cfg), inbox = new Inbox(cfg, ledger);
  return { root, cfg, ledger, inbox, source };
}

test('strict parser supports Unicode, multiline previews, pipes, missing role, zero; rejects partial/error/duplicate output', () => {
  const text = list(['1. 李同学｜岗位甲｜未读:2｜时间:10:10｜消息:<script>｜文本\n第二行', '2. 王同学｜未读:1']);
  const items = parseUnread(text);
  assert.equal(items[0].message, '<script>｜文本\n第二行');
  assert.equal(items[1].role, '');
  assert.deepEqual(parseUnread(list([])), []);
  for (const bad of ['请登录', sample.replace('共 2 人', '共 3 人'), list(['1. 李｜岗｜未读:1', '2. 李｜岗｜未读:2'])]) assert.throws(() => parseUnread(bad));
});

test('import is idempotent, links name+role, preserves all existing fields and extension columns', (t) => {
  const { ledger, inbox, source, root } = setup(t);
  const original = ledger.read().rows[0];
  assert.deepEqual(inbox.importSource(source), { added: 1, linked: 1, unresolved: 0, count: 2 });
  assert.deepEqual(ledger.read().rows[0], original);
  assert.equal(ledger.read().rows[1][0], '8');
  const once = fs.readFileSync(ledger.file, 'utf8');
  assert.equal(inbox.importSource(source).added, 0);
  assert.equal(fs.readFileSync(ledger.file, 'utf8'), once);
  assert.equal(inbox.read().items.length, 2);
  assert.equal(fs.readdirSync(path.join(root, 'backup')).length, 1);
});

test('latest unread replaces the visible queue while history survives empty pulls and reappearance', (t) => {
  const { inbox, source, root, ledger } = setup(t);
  inbox.importSource(source);
  let item = inbox.read().items[0];
  inbox.followup(item.id, item.signature, '已核实，等待简历', true);
  assert.equal(ledger.read().rows[0][3], '面试中');
  assert.match(ledger.read().rows[0][5], /旧备注.*已核实/);
  inbox.importSource(source);
  assert.equal(inbox.read().items[0].handled, true);
  const next = '20260924-1111-boss-unread.txt';
  fs.writeFileSync(path.join(root, 'runtime/raw', next), sample);
  inbox.importSource(next);
  assert.equal(inbox.read().items[0].handled, false);
  assert.equal(inbox.read().items[0].history.length, 1);
  assert.throws(() => inbox.followup(item.id, item.signature, '旧页面提交', true), /已更新/);
  const empty = '20260924-1211-boss-unread.txt';
  fs.writeFileSync(path.join(root, 'runtime/raw', empty), list([]));
  inbox.importSource(empty);
  assert.equal(inbox.read().items.length, 0);
  assert.equal(inbox.read().archive.length, 2);
  const returning = '20260925-1211-boss-unread.txt';
  fs.writeFileSync(path.join(root, 'runtime/raw', returning), list(['1. 李同学｜岗位甲｜未读:1｜时间:12:11｜消息:再次联系']));
  inbox.importSource(returning);
  assert.equal(inbox.read().items.length, 1);
  assert.equal(inbox.read().archive.length, 1);
  assert.equal(inbox.read().items[0].history.length, 1);
  assert.equal(inbox.read().items[0].handled, false);
  assert.equal(inbox.list().items.length, 1);
});

test('unknown output and malformed ledger cannot overwrite records; latest file handles legacy timestamps', (t) => {
  const { inbox, ledger, root, source } = setup(t);
  const bytes = fs.readFileSync(ledger.file);
  fs.writeFileSync(path.join(root, 'runtime/raw', '20260923-boss-unread.txt'), '请登录');
  assert.equal(inbox.latest(), source);
  assert.throws(() => inbox.importSource('20260923-boss-unread.txt'));
  assert.deepEqual(fs.readFileSync(ledger.file), bytes);
  assert.equal(fs.existsSync(inbox.file), false);
  fs.appendFileSync(ledger.file, '残缺,数据\n');
  assert.throws(() => inbox.importSource(source), /台账列数/);
  assert.throws(() => inbox.source('../ledger.csv'), /无效/);
});

test('missing roles and duplicate matching ledger rows remain unresolved; same names across roles cannot trigger chat', (t) => {
  const { inbox, ledger, source } = setup(t, list(['1. 李同学｜另一个岗位｜未读:1', '2. 周同学｜未读:1']));
  const result = inbox.importSource(source);
  assert.equal(result.added, 1); assert.equal(result.unresolved, 1);
  const item = inbox.read().items[0];
  assert.throws(() => inbox.chatTarget(item.id, item.signature), /同名/);
  const { rows } = ledger.read(); rows.push([...rows[0]]);
  ledger.write(header, rows);
  const other = '20260923-1211-boss-unread.txt';
  fs.writeFileSync(path.join(inbox.dir, other), list(['1. 李同学｜岗位甲｜未读:1']));
  assert.equal(inbox.importSource(other).unresolved, 1);
});

test('full chat must match both name and role, and is invalidated by new preview', (t) => {
  const { inbox, source, root } = setup(t);
  inbox.importSource(source);
  const item = inbox.read().items[0];
  assert.throws(() => inbox.saveChat(item.id, item.signature, '姓名: 李同学\n沟通职位: 别的岗'), /未能核对/);
  inbox.saveChat(item.id, item.signature, '姓名: 李同学\n沟通职位: 岗位甲\n完整聊天消息：你好');
  assert.ok(inbox.get(item.id).chat);
  fs.writeFileSync(path.join(root, 'runtime/raw', source), sample.replace('我可以发简历吗？', '新的回复'));
  inbox.importSource(source);
  assert.equal(inbox.get(item.id).chat, null);
});

test('resume evidence stays with the same person across pulls, review resets on a new image, and image paths are constrained', (t) => {
  const { inbox, source, root } = setup(t);
  inbox.importSource(source);
  const item = inbox.read().items[0];
  const dir = path.join(root, 'runtime', 'resumes', 'inbox');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'first.png'), 'image bytes');
  inbox.saveResume(item.id, item.signature, 'first.png', '本科\n项目经历：产品设计');
  inbox.saveReview(item.id, item.signature, { text: '证据', model: '本地规则' });
  assert.equal(path.basename(inbox.resumeFile(item.id, item.signature)), 'first.png');
  inbox.importSource(source);
  assert.equal(inbox.get(item.id).resume.review.text, '证据');
  fs.writeFileSync(path.join(dir, 'second.png'), 'new image');
  inbox.saveResume(item.id, item.signature, 'second.png', '新版简历正文');
  assert.equal(inbox.get(item.id).resume.review, null);
  const empty = '20260924-1200-boss-unread.txt';
  fs.writeFileSync(path.join(root, 'runtime/raw', empty), list([]));
  inbox.importSource(empty);
  assert.equal(inbox.read().items.length, 0);
  assert.equal(inbox.read().archive[0].resume.file, 'second.png');
  const returning = '20260925-1200-boss-unread.txt';
  fs.writeFileSync(path.join(root, 'runtime/raw', returning), list(['1. 李同学｜岗位甲｜未读:1｜时间:12:00｜消息:再次联系']));
  inbox.importSource(returning);
  assert.equal(inbox.get(item.id).resume.file, 'second.png');
  assert.throws(() => inbox.saveResume(item.id, inbox.get(item.id).signature, '../ledger.csv', 'bad'), /路径无效/);
  assert.equal(runner.validate('boss action resume').ok, false);
  assert.equal(runner.validate('boss action resume', 'inbox-resume').ok, true);
  assert.equal(runner.validate('boss action resume', 'inbox-resume-role').ok, true);
  assert.equal(runner.validate('boss action not-fit', 'inbox-resume').ok, false);
});

test('role resume preview contains only pending same-role candidates without saved resumes', (t) => {
  const { inbox, source, root } = setup(t);
  inbox.importSource(source);
  const ctx = { inbox, dataHome: root, opts: { role: '岗位甲' } };
  const first = runner.preview('inbox-resume-role', ctx);
  assert.deepEqual(first.commands, ['boss chat "李同学"', 'boss action resume']);
  const item = inbox.read().items[0];
  const dir = path.join(root, 'runtime', 'resumes', 'inbox');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'saved.png'), 'image');
  inbox.saveResume(item.id, item.signature, 'saved.png', '简历正文');
  assert.deepEqual(runner.preview('inbox-resume-role', ctx).commands, []);
  assert.throws(() => runner.preview('inbox-resume-role', { ...ctx, opts: {} }), /选择一个应聘岗位/);
});

test('local resume review uses only configured job rules and cites matching evidence', (t) => {
  const { root } = setup(t);
  fs.mkdirSync(path.join(root, '01-jd/_internal'), { recursive: true });
  fs.writeFileSync(path.join(root, 'CONTEXT.md'), [
    '## 三、初筛硬规则',
    '| 维度 | 规则 | 来源 |', '|---|---|---|',
    '| **年龄线** | **硬上限 30 岁** | 已确认 |',
    '| 学历线 | 本科及以上在读 | 已确认 |',
    '| 毕业届别（岗位甲） | 2029 届 | 已确认 |',
    '## 四、在招岗位与优先级',
    '| 岗位 | 优先级 | 状态 | 对外 JD | 对内笔记 |', '|---|---|---|---|---|',
    '| 岗位甲 | 高 | 在招 | `01-jd/a.md` | `01-jd/_internal/a.md` |',
  ].join('\n'));
  fs.writeFileSync(path.join(root, '01-jd/_internal/a.md'), [
    '## 简历初筛线索（可选）',
    '| 线索 | 检索词 |', '|---|---|',
    '| 用户研究 | 用户访谈 / 可用性测试 |',
    '| 数据分析 | SQL / 统计建模 |',
  ].join('\n'));
  const resume = '31岁｜本科｜29年应届生\n组织用户访谈并归纳反馈';
  const configured = reviewResume({ role: '岗位甲', resume, dataHome: root });
  assert.match(configured, /年龄：.*超过 30 岁上限/);
  assert.match(configured, /在读\/届别：.*本岗要求：2029 届/);
  assert.match(configured, /用户研究：“组织用户访谈并归纳反馈”/);
  assert.match(configured, /数据分析：简历中未找到明确证据/);
  const unconfigured = reviewResume({ role: '岗位乙', resume, dataHome: root });
  assert.match(unconfigured, /本岗未配置简历检索线索/);
  assert.doesNotMatch(unconfigured, /用户研究：|本岗要求：2029 届/);
  assert.equal(hardgateVerdict({ role: '岗位甲', info: '29年应届生', dataHome: root }), '通过');
  assert.equal(hardgateVerdict({ role: '岗位甲', info: '28年应届生', dataHome: root }), '不符');
  assert.equal(hardgateVerdict({ role: '岗位甲', info: '本科，已毕业', dataHome: root }), '不符');
  assert.equal(hardgateVerdict({ role: '岗位甲', info: '29年应届生，往届生', dataHome: root }), '不符');
  assert.equal(hardgateVerdict({ role: '岗位乙', info: '29年应届生', dataHome: root }), '待核');
  fs.writeFileSync(path.join(root, 'CONTEXT.md'), fs.readFileSync(path.join(root, 'CONTEXT.md'), 'utf8')
    .replace('本科及以上在读', '本科及以上'));
  assert.equal(hardgateVerdict({ role: '岗位甲', info: '本科，已毕业', dataHome: root }), '待核');
});

test('local review does not infer a threshold when the local standard omits one', () => {
  const result = reviewResume({ role: '岗位甲', resume: '31岁｜本科\n组织用户访谈' });
  assert.doesNotMatch(result, /超过 .* 岁上限/);
  assert.match(result, /年龄：“31岁｜本科”/);
});

test('ledger cell edits address stable row IDs and reject ambiguous legacy name-only calls', (t) => {
  const { ledger } = setup(t);
  const data = ledger.read();
  data.rows.push(['8', '李同学', '另一个岗', '待初筛', '', '', '', '', '']);
  ledger.write(data.header, data.rows);
  assert.throws(() => ledger.updateCell('李同学', '备注', '不应写入'), /同名/);
  ledger.updateCell('李同学', '备注', '只改第二行', '8');
  assert.equal(ledger.read().rows[0][5], '旧备注');
  assert.equal(ledger.read().rows[1][5], '只改第二行');
});

test('runner pull integrates parsing and persistence; nonzero output never imports; no real BOSS executed', async (t) => {
  const { inbox, root, ledger } = setup(t);
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const stub = path.join(bin, 'boss');
  fs.writeFileSync(stub, '#!' + process.execPath + '\nprocess.stdout.write(' + JSON.stringify(sample) + ');\n'); fs.chmodSync(stub, 0o755);
  const oldPath = process.env.PATH; process.env.PATH = bin + ':' + oldPath;
  t.after(() => { process.env.PATH = oldPath; });
  const ctx = { dataHome: root, inbox, opts: {} };
  const ticket = runner.preview('pull-unread', ctx);
  assert.equal(ticket.ok, true);
  assert.equal((await runner.run(ticket.token, false)).ok, false);
  const result = await runner.run(ticket.token, true);
  assert.equal(result.ok, true); assert.equal(result.result.added, 1);
  assert.equal((await runner.run(ticket.token, true)).ok, false);
  const before = fs.readFileSync(ledger.file, 'utf8');
  fs.writeFileSync(stub, '#!' + process.execPath + '\nprocess.stdout.write(' + JSON.stringify(sample) + ');process.exitCode=1;\n');
  const failed = await runner.run(runner.preview('pull-unread', ctx).token, true);
  assert.equal(failed.ok, false);
  assert.equal(fs.readFileSync(ledger.file, 'utf8'), before);
});
