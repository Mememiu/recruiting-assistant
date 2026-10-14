#!/usr/bin/env node
'use strict';
/**
 * recruit-today 的命令行入口 —— 只读扫描，输出人话决策卡。
 *
 * 用法：node today-scan.js [工作区路径]   （默认当前目录）
 *
 * 不碰 BOSS、不改任何文件、不调 AI。所有数字从 CONTEXT.md / 台账 / inbox.json 本地算出。
 */

const path = require('path');
const fs = require('fs');

const dataHome = path.resolve(process.argv[2] || '.');
const ledgerRel = '02-sourcing/dedup-ledger.csv';

// 优先用目标工作区里工作台的 config.json 配置的台账路径；
// 找不到共享实现时（比如 skill 被拷进了没有工作台副本的目录），退回仓库内自带的实现。
let cfgLedger = ledgerRel;
try {
  const cfgFile = path.join(dataHome, 'workbench', 'config.json');
  if (fs.existsSync(cfgFile)) cfgLedger = JSON.parse(fs.readFileSync(cfgFile, 'utf8')).ledger || ledgerRel;
} catch { /* 用默认路径 */ }

const candidates = [
  path.join(dataHome, 'workbench', 'lib', 'today-scan.js'),  // 目标工作区自带的实现（优先）
  path.join(__dirname, '..', '..', '..', 'workbench', 'lib', 'today-scan.js'),  // 技能仓库副本里的实现
];
const impl = candidates.find((p) => fs.existsSync(p));
if (!impl) {
  console.error('找不到共享扫描实现（workbench/lib/today-scan.js）。');
  console.error('这个脚本要在已初始化的工作区里跑，且工作区含 workbench/ 目录。');
  process.exit(1);
}

const { scan, toText } = require(impl);
try {
  const s = scan(dataHome, cfgLedger);
  console.log(toText(s));
  process.exit(0);
} catch (e) {
  console.error('扫描失败：' + (e.message || e));
  console.error('（这是只读诊断，没有修改任何文件）');
  process.exit(1);
}
