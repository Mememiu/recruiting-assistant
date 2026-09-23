'use strict';

const fs = require('fs');
const path = require('path');

const INBOX_SHOT = /^[a-f0-9]{64}-[a-f0-9-]{36}\.png$/;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function cleanupOrphanScreenshots(dataHome, now = Date.now()) {
  const inboxFile = path.join(dataHome, 'runtime', 'inbox.json');
  const dir = path.join(dataHome, 'runtime', 'resumes', 'inbox');
  if (!fs.existsSync(inboxFile) || !fs.existsSync(dir)) return { removed: 0, bytes: 0 };

  const inbox = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));
  if (inbox.version !== 1 || !Array.isArray(inbox.items) ||
      (inbox.archive !== undefined && !Array.isArray(inbox.archive))) throw new Error('待办结构异常，未清理截图。');
  const referenced = new Set([...inbox.items, ...(inbox.archive || [])].map((item) => item.resume?.file).filter(Boolean));
  let removed = 0, bytes = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!INBOX_SHOT.test(name) || referenced.has(name)) continue;
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || now - stat.mtimeMs < RETENTION_MS) continue;
    fs.unlinkSync(file);
    removed++;
    bytes += stat.size;
  }
  return { removed, bytes };
}

module.exports = { cleanupOrphanScreenshots };
