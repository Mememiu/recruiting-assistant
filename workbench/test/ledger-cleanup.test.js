'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Ledger, toCSV } = require('../lib/ledger');
const { Inbox } = require('../lib/inbox');
const { LedgerCleanup } = require('../lib/ledger-cleanup');

const header = ['序号', '姓名', '应聘岗位', '状态', '硬门槛', '评级', '来源轮次', '备注', '更新时间'];
const rows = [
  ['1', '甲', '硬件岗', '待初筛', '不符：届别', '', '202609boss未读', '旧候选人', '2026-09-10'],
  ['2', '乙', '硬件岗', '待初筛', '不符：年龄', '', '202609boss未读', '旧候选人', '2026-09-11'],
  ['3', '丙', '硬件岗', '初筛通过', '通过', '⭐⭐⭐', '202609boss未读', '重点', '2026-09-12'],
  ['4', '丁', '软件岗', '待初筛', '不符：届别', '', '202609boss推荐', '旧候选人', '2026-09-12'],
];

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recruit-ledger-cleanup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = { dataHome: root, ledger: 'ledger.csv', backupDir: 'backup' };
  fs.writeFileSync(path.join(root, 'ledger.csv'), toCSV([header, ...rows]));
  const ledger = new Ledger(cfg);
  const inbox = new Inbox(cfg, ledger);
  const cleanup = new LedgerCleanup(ledger, inbox);
  return { root, ledger, inbox, cleanup };
}

test('combined conditions preview exact rows and exclude current unread candidates', (t) => {
  const { root, cleanup } = setup(t);
  fs.mkdirSync(path.join(root, 'runtime'));
  fs.writeFileSync(path.join(root, 'runtime', 'inbox.json'), JSON.stringify({ version: 1,
    items: [{ name: '乙', role: '硬件岗' }], archive: [], source: null }));
  assert.throws(() => cleanup.preview({}), /至少选择一个/);
  const result = cleanup.preview({ role: '硬件岗', status: '待初筛', hard: '不符',
    source: '未读', updatedBefore: '2026-09-15', keyword: '旧候选人' });
  assert.deepEqual(result.items.map((x) => x.id), ['1']);
  assert.equal(result.blocked, 1);
  assert.ok(result.token);
  assert.throws(() => cleanup.preview({ updatedBefore: '2026-02-30' }), /日期/);
});

test('selected candidates move to recoverable archive and IDs remain reserved', (t) => {
  const { ledger, cleanup } = setup(t);
  const before = ledger.readStrict().rows;
  const preview = cleanup.preview({ status: '待初筛' });
  assert.deepEqual(preview.items.map((x) => x.id), ['1', '2', '4']);
  assert.throws(() => cleanup.commit(preview.token, ['3']), /预览名单/);
  const result = cleanup.commit(preview.token, ['2', '4']);
  assert.equal(result.removed, 2);
  assert.deepEqual(ledger.readStrict().rows.map((r) => r[0]), ['1', '3']);
  assert.equal(ledger.nextId(ledger.readStrict().rows), 4);
  assert.equal(cleanup.archives()[0].count, 2);
  assert.equal(fs.readdirSync(ledger.backupDir).length, 1);
  assert.throws(() => cleanup.commit(preview.token, ['1']), /已使用|过期/);
  assert.deepEqual(cleanup.restore(result.archiveId), { restored: 2 });
  assert.deepEqual(ledger.readStrict().rows, before);
  assert.equal(cleanup.archives()[0].restored, true);
  assert.throws(() => cleanup.restore(result.archiveId), /已经恢复/);
});

test('stale previews and active unread changes cannot clear ledger rows', (t) => {
  const { root, ledger, cleanup } = setup(t);
  const stale = cleanup.preview({ role: '硬件岗' });
  ledger.updateCell('甲', '备注', '刚更新', '1');
  assert.throws(() => cleanup.commit(stale.token, ['1']), /已更新/);
  const fresh = cleanup.preview({ role: '硬件岗' });
  fs.mkdirSync(path.join(root, 'runtime'));
  fs.writeFileSync(path.join(root, 'runtime', 'inbox.json'), JSON.stringify({ version: 1,
    items: [{ name: '甲', role: '硬件岗' }], archive: [], source: null }));
  assert.throws(() => cleanup.commit(fresh.token, ['1']), /未读待办/);
  assert.equal(ledger.readStrict().rows.length, 4);
});

test('restore can finish after the ledger write succeeds but archive update fails', (t) => {
  const { ledger, cleanup } = setup(t);
  const preview = cleanup.preview({ status: '待初筛' });
  const { archiveId } = cleanup.commit(preview.token, ['2']);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to.endsWith(`${archiveId}.json`)) throw new Error('archive write interrupted');
    return rename(from, to);
  };
  try { assert.throws(() => cleanup.restore(archiveId), /archive write interrupted/); }
  finally { fs.renameSync = rename; }
  assert.equal(ledger.readStrict().rows.length, 4);
  assert.deepEqual(cleanup.restore(archiveId), { restored: 1 });
  assert.equal(cleanup.archives()[0].restored, true);
});
