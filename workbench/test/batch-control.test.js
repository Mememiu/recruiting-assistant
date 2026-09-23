'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const runner = require('../lib/runner');
const { Ledger, toCSV } = require('../lib/ledger');

const header = ['序号', '姓名', '应聘岗位', '状态', 'AI建议', '现职/背景', '备注', '更新时间'];
const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await pause();
  }
  throw new Error('等待任务状态超时');
}

test('batch AI pause, resume and cancel retain completed advice without starting the next person', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recruit-batch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'CONTEXT.md'), '## 三、初筛硬规则\n按材料判断\n## 五、术语表');
  const ledger = new Ledger({ dataHome: root, ledger: 'ledger.csv', backupDir: 'backup' });
  fs.writeFileSync(ledger.file, toCSV([header,
    ['1', '甲', '岗位A', '待初筛', '', '', '', ''],
    ['2', '乙', '岗位A', '待初筛', '', '', '', ''],
    ['3', '丙', '岗位B', '待初筛', '', '', '', '']]));
  let finishFirst;
  const called = [];
  const ctx = {
    dataHome: root, targetRole: '岗位A', readLedger: () => ledger.read(),
    writeLedger: (h, rows) => ledger.write(h, rows),
    screen: ({ person, signal }) => {
      called.push(person);
      if (called.length === 1) return new Promise((resolve) => { finishFirst = resolve; });
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ ok: false, cancelled: true }), { once: true }));
    },
  };
  assert.equal(runner.control('pause').ok, false);
  const ticket = runner.preview('ai-screen-batch', ctx);
  const run = runner.run(ticket.token, true);
  await until(() => !!finishFirst);
  assert.equal(runner.control('pause').ok, true);
  assert.equal(runner.getState().pauseRequested, true);
  finishFirst({ ok: true, content: '建议甲', usage: {} });
  await until(() => runner.getState().paused);
  assert.equal(called.length, 1);
  assert.equal(ledger.read().rows[0][4], '建议甲');
  assert.equal(ledger.read().rows[1][4], '');
  assert.equal(runner.control('resume').ok, true);
  await until(() => called.length === 2);
  assert.equal(runner.control('cancel').ok, true);
  const result = await run;
  assert.equal(result.result.cancelled, true);
  assert.equal(runner.getState().cancelled, true);
  assert.equal(runner.getState().running, false);
  assert.equal(ledger.read().rows[0][4], '建议甲');
  assert.equal(ledger.read().rows[1][4], '');
  assert.equal(ledger.read().rows[2][4], '');
  assert.equal(fs.readdirSync(path.join(root, 'backup')).length, 1);
  assert.equal(runner.control('resume').ok, false);
});

test('greeting threshold comes from local settings and never runs during preview', () => {
  const ctx = {
    readLedger: () => ({
      header: ['姓名', '应聘岗位', '评级', '状态', '来源轮次'],
      rows: [
        ['甲', '岗位A', '⭐⭐', '初筛通过', '推荐'],
        ['乙', '岗位A', '⭐⭐⭐', '初筛通过', '推荐'],
        ['丙', '岗位B', '⭐⭐⭐', '待初筛', '推荐'],
      ],
    }),
  };
  assert.throws(() => runner.preview('greet-qualified', ctx), /本地配置/);
  ctx.outreach = { minStars: 3 };
  assert.deepEqual(runner.preview('greet-qualified', ctx).commands, ['boss greet "乙" --job "岗位A"']);
  ctx.outreach = { minStars: 2 };
  assert.deepEqual(runner.preview('greet-qualified', ctx).commands,
    ['boss greet "甲" --job "岗位A"', 'boss greet "乙" --job "岗位A"']);
});
