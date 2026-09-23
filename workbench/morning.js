'use strict';
/**
 * 每日晨报任务
 *
 * 做的事（全部零风险）：拉取今日未读（只读 boss 命令）→ 生成日报（数字本地算 + 便宜模型写分析）→ macOS 通知
 *
 * 手动运行：  node morning.js
 * 定时启用：  见 README「定时自跑」一节（launchd，默认不启用）
 *
 * 注意：拉未读会弹出一个 Chrome 窗口 —— 正常现象，任务结束它会常驻（登录态保留）。
 * 失败时会发系统通知，不会静默。
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { Ledger, toCSV } = require('./lib/ledger');
const runner = require('./lib/runner');
const report = require('./lib/report');

// ── 配置加载（与 server.js 一致，含 config.local）
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
cfg.dataHome = path.resolve(__dirname, cfg.dataHome);
const lp = path.join(__dirname, 'config.local.json');
if (fs.existsSync(lp)) {
  try { cfg.ai = { ...(cfg.ai || {}), ...(JSON.parse(fs.readFileSync(lp, 'utf8')).ai || {}) }; } catch {}
}
if (cfg.ai && cfg.ai.apiKey) cfg.ai.enabled = true;

const ledger = new Ledger(cfg);
const ctx = {
  dataHome: cfg.dataHome,
  targetRole: '',
  opts: {},
  readLedger: () => ledger.read(),
  stats: () => ledger.stats(),
  writeLedger: (header, rows) => {
    ledger.backup();
    fs.writeFileSync(ledger.file, toCSV([header, ...rows]), 'utf8');
  },
};

function notify(msg) {
  try {
    execSync(`osascript -e 'display notification "${msg}" with title "招聘工作台"'`);
  } catch { /* 通知失败无所谓 */ }
}

(async () => {
  console.log('[' + new Date().toLocaleTimeString() + '] 晨报开始');

  console.log('1/2 拉取今日未读…');
  const logs1 = [];
  const r1 = await runner.TASKS['pull-unread'].execute(ctx, logs1);
  logs1.forEach((l) => console.log('   ' + l));
  if (!r1.ok) throw new Error('拉取未读失败（浏览器可能没起来，试试在终端手动跑一次 boss login）');

  console.log('2/2 生成日报…');
  const r2 = await report.generate(cfg, { stats: () => ledger.stats(), read: () => ledger.read() });
  console.log('   日报: ' + r2.file + (r2.aiOk ? '（含 AI 分析）' : '（AI 分析未生成，数字部分完整）'));

  // 推到微信（Server酱）。额度每天 5 条，所以只在晨报场景推，手动点日报不推。
  let pushed = '未配置推送';
  try {
    const { push } = require('./lib/notify');
    const p = await push({
      title: '招聘晨报 ' + new Date().toISOString().slice(5, 10),
      desp: [
        '**今日概况**',
        '',
        ...r2.aiOk ? ['（AI 分析与完整数据见工作台日报页）'] : [],
        '',
        `日报全文：浏览器打开 http://${cfg.host}:${cfg.port} → 「日报」页`,
      ].join('\n'),
    });
    pushed = p.ok ? '已推送到微信 ✓' : '推送失败：' + p.error;
  } catch (e) { pushed = '推送异常：' + e.message; }
  console.log('   微信推送: ' + pushed);

  notify('晨报完成：未读已拉取，日报已生成' + (pushed.includes('✓') ? '，已推微信' : ''));
  console.log('[' + new Date().toLocaleTimeString() + '] 晨报完成');
})().catch((e) => {
  console.error('[晨报] 失败：' + e.message);
  notify('晨报失败：' + e.message.slice(0, 60));
  process.exit(1);
});
