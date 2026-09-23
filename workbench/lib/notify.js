'use strict';
/**
 * Server酱推送 —— 把日报推到用户微信
 *
 * 用的是 Server酱（sct.ftqq.com）官方 API：走微信公众平台模板消息，合规、无封号风险。
 * 免费额度每天 5 条 —— 所以只在晨报场景推送；用户手动点日报任务时人就在电脑前，不浪费额度。
 * Key 放 config.local.json（已 gitignore），不进代码库。
 */

const fs = require('fs');
const path = require('path');

function loadPushCfg() {
  const root = path.join(__dirname, '..');
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const lp = path.join(root, 'config.local.json');
  if (fs.existsSync(lp)) {
    cfg.push = { ...(cfg.push || {}), ...(JSON.parse(fs.readFileSync(lp, 'utf8')).push || {}) };
  }
  return cfg;
}

/**
 * @param {string} title 标题（≤32 字，超出会截断）
 * @param {string} desp  正文（支持 markdown）
 */
async function push({ title, desp }) {
  const cfg = loadPushCfg();
  const key = cfg.push && cfg.push.sendKey;
  if (!key) return { ok: false, error: '还没配 Server酱 SendKey（写在 config.local.json 的 push.sendKey）' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(`https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ title: String(title).slice(0, 32), desp: String(desp || '') }).toString(),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const d = await r.json();
    if (d.code === 0) return { ok: true };
    return { ok: false, error: d.message || ('HTTP ' + r.status) };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: e.name === 'AbortError' ? '推送超时' : String(e.message || e) };
  }
}

module.exports = { push };
