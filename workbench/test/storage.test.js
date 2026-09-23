'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanupOrphanScreenshots } = require('../lib/storage');

test('storage cleanup removes only aged unreferenced generated screenshots', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recruit-storage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'runtime', 'resumes', 'inbox');
  fs.mkdirSync(dir, { recursive: true });
  const names = ['a', 'b', 'c'].map((letter) => `${letter.repeat(64)}-12345678-1234-1234-1234-123456789abc.png`);
  for (const name of [...names, 'manual.png']) fs.writeFileSync(path.join(dir, name), 'image');
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  for (const name of [names[0], names[1], 'manual.png']) fs.utimesSync(path.join(dir, name), old, old);
  const inboxFile = path.join(root, 'runtime', 'inbox.json');
  fs.writeFileSync(inboxFile, JSON.stringify({ version: 1, items: [], archive: [{ resume: { file: names[0] } }] }));

  assert.deepEqual(cleanupOrphanScreenshots(root), { removed: 1, bytes: 5 });
  assert.equal(fs.existsSync(path.join(dir, names[0])), true);
  assert.equal(fs.existsSync(path.join(dir, names[1])), false);
  assert.equal(fs.existsSync(path.join(dir, names[2])), true);
  assert.equal(fs.existsSync(path.join(dir, 'manual.png')), true);

  fs.writeFileSync(inboxFile, '{broken');
  assert.throws(() => cleanupOrphanScreenshots(root));
  assert.equal(fs.existsSync(path.join(dir, names[0])), true);
});
