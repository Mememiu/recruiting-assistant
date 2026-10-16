'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { validate } = require('../lib/runner');
const { Ledger, parseCSV, toCSV } = require('../lib/ledger');
const { parseUnread } = require('../lib/inbox');

test('command validation rejects shell metacharacters and unterminated quotes', () => {
  assert.equal(validate('boss chat "张 三"', 'inbox-chat').ok, true);
  assert.equal(validate('boss chat "张三" & calc.exe', 'inbox-chat').ok, false);
  assert.equal(validate('boss chat 张三^&calc', 'inbox-chat').ok, false);
  assert.equal(validate('boss chat "张三', 'inbox-chat').ok, false);
  assert.equal(validate('ai: model x 1', 'daily-report').ok, true);
});

test('CSV parser rejects unterminated quotes and ledger preserves extension columns', (t) => {
  assert.throws(() => parseCSV('id,name\n"unclosed,2\n'), /引号未闭合/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recruiting-ledger-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = { dataHome: root, ledger: 'ledger.csv', backupDir: 'backup' };
  fs.writeFileSync(path.join(root, cfg.ledger), toCSV([
    ['id', 'name', 'extension'],
    ['1', 'Alice', 'keep-me'],
  ]), 'utf8');

  const ledger = new Ledger(cfg);
  assert.deepEqual(ledger.read(), {
    header: ['id', 'name', 'extension'],
    rows: [['1', 'Alice', 'keep-me']],
  });

  fs.writeFileSync(path.join(root, cfg.ledger), 'id,name,extension\n1,Alice\n', 'utf8');
  assert.throws(() => ledger.read(), /列数或列名异常/);
});

test('unread parser preserves stable remote id from boss list output', () => {
  const raw = [
    '未读筛选：共 1 人（已切换页面「未读」筛选）。',
    '候选人明细：',
    '1. Alice｜机器人软件开发实习生｜id:769568498-0｜未读:1｜时间:19:36｜消息:你好',
  ].join('\n');
  const [item] = parseUnread(raw);
  assert.equal(item.remoteId, '769568498-0');
  assert.equal(item.role, '机器人软件开发实习生');
});

test('stable remote id preserves distinct same-name records', () => {
  const raw = [
    '未读筛选：共 2 人（已切换页面「未读」筛选）。',
    '候选人明细：',
    '1. 钱多多｜硬件开发实习生（日常实习）｜id:111-0｜未读:1｜时间:19:36｜消息:a',
    '2. 钱多多｜硬件开发实习生（日常实习）｜id:222-0｜未读:1｜时间:19:37｜消息:b',
  ].join('\n');
  const items = parseUnread(raw);
  assert.equal(items.length, 2);
  assert.notEqual(items[0].id, items[1].id);
  assert.equal(items[0].remoteId, '111-0');
  assert.equal(items[1].remoteId, '222-0');
});
