'use strict';
/**
 * boss 可执行性诊断 —— 装好 boss-cli 后跑一次，确认工作台能正常调用它。
 *
 *   node workbench/doctor.js
 *
 * 检查三件事（按顺序，任何一步失败都会给出具体原因和修法）：
 *   1. boss 是否在 PATH 里能找到（用与 runner 完全相同的 childEnv）
 *   2. 工作台的 spawn 方式能否真的把它跑起来（Windows 走 cmd /c）
 *   3. `boss version` 是否有正常响应
 *
 * 设计为只读：不登录、不拉数据、不发任何平台动作。
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const IS_WIN = process.platform === 'win32';

// ── 与 runner.js 保持一致的 childEnv（改了这里也要改那里，反之亦然）
function childEnv() {
  const home = os.homedir();
  const sep = path.delimiter;
  const extra = IS_WIN
    ? [path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm'),
       path.join(home, '.local', 'bin')]
    : [path.join(home, '.local', 'bin'), '/usr/local/bin', '/usr/bin', '/bin'];
  const nodeDir = path.dirname(process.execPath);
  return { ...process.env, PATH: [...new Set([...(process.env.PATH || '').split(sep), nodeDir, ...extra])].join(sep) };
}

// ── 与 runner.js 一致的跨平台执行
function spawnTool(cmd, args, timeoutMs = 30000) {
  const bin = IS_WIN ? 'cmd' : cmd;
  const finalArgs = IS_WIN ? ['/d', '/s', '/c', cmd, ...args] : args;
  return new Promise((resolve) => {
    const p = spawn(bin, finalArgs, { env: childEnv(), shell: false });
    let out = '', err = '';
    const t = setTimeout(() => { try { p.kill(); } catch {} resolve({ out, err: err + '\n[超时]', code: -1 }); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => { clearTimeout(t); resolve({ out, err, code }); });
    p.on('error', (e) => { clearTimeout(t); resolve({ out, err: String(e.message || e), code: -1 }); });
  });
}

let failed = 0;
const ok = (msg) => console.log('  [OK]   ' + msg);
const bad = (msg) => { failed++; console.log('  [FAIL] ' + msg); };
const info = (msg) => console.log('         ' + msg);

(async () => {
  console.log('');
  console.log('  boss 可执行性诊断');
  console.log('  ─────────────────────────────────');
  console.log('  平台: ' + process.platform + ' | Node: ' + process.version);
  console.log('');

  // 1. PATH 里能否找到 boss
  console.log('1. PATH 解析');
  const dirs = childEnv().PATH.split(path.delimiter);
  const candidates = dirs.map((d) => path.join(d, IS_WIN ? 'boss.cmd' : 'boss'));
  const hit = candidates.find((c) => fs.existsSync(c));
  if (hit) ok('找到 boss: ' + hit);
  else {
    bad('PATH 里找不到 boss' + (IS_WIN ? '（也找过 boss.cmd）' : ''));
    info('已搜索 ' + dirs.length + ' 个目录。npm 全局装的 boss 通常在这些位置之一:');
    if (IS_WIN) info('  %APPDATA%\\npm  (当前: ' + path.join(process.env.APPDATA || '?', 'npm') + ')');
    else info('  /usr/local/bin 或 ~/.local/bin');
    info('你的私有 fork 装在哪，就把那个目录加进 PATH，或确认它在上面列出的目录里。');
  }
  console.log('');

  // 2. spawn 能否跑起来（这一步与工作台实际调用的路径完全相同）
  console.log('2. 执行测试（与工作台 runner 相同的调用方式）');
  if (hit) {
    const r = await spawnTool('boss', ['version']);
    if (r.code === 0 && (r.out || '').trim()) {
      ok('boss version 正常返回（退出码 0）');
      info('输出: ' + r.out.trim().split('\n')[0].slice(0, 100));
    } else if (r.code === -1 && /ENOENT|EINVAL/i.test(r.err)) {
      bad('spawn 失败: ' + r.err.split('\n')[0]);
      if (IS_WIN) info('Windows 上 Node 无 shell 不能直接 exec .cmd —— 本脚本已走 cmd /c，仍失败说明 boss 不在 PATH，回上一步看。');
      else info('检查文件是否有可执行权限（chmod +x）。');
    } else {
      bad('执行返回异常（退出码 ' + r.code + '）');
      info('stderr: ' + (r.err || r.out || '').trim().split('\n')[0].slice(0, 120));
      info('能跑起来但报错，通常是没登录或浏览器环境问题 —— 试跑一次 `boss login`。');
    }
  } else {
    info('跳过（上一步已失败）');
  }
  console.log('');

  // 3. 平台侧提醒（不阻断）
  console.log('3. 提醒');
  if (IS_WIN) {
    info('BOSS 平台的反检测对 Windows + 无头 Chrome 的表现未经实测。');
    info('正式用之前务必先手动跑一次: boss login  然后  boss list --unread');
    info('依据: Boss 曾有账号因无头模式被限制 web 端登录 24 小时（见 channels.md）。');
    info('工作台已强制有头模式，不要设 BOSS_BROWSER_HEADLESS / RECRUIT_BROWSER_HIDDEN。');
  }
  console.log('');

  if (failed) {
    console.log('  诊断结果: ' + failed + ' 项未通过 —— 按上面的提示处理后重跑本脚本。');
    console.log('');
    process.exit(1);
  }
  console.log('  诊断结果: 全部通过 —— 工作台可以正常调用 boss。');
  console.log('');
})().catch((e) => { console.error('诊断脚本异常:', e); process.exit(1); });
