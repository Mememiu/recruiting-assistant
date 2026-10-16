'use strict';

const { spawn } = require('child_process');
const path = require('path');

function childEnv() {
  const sep = path.delimiter;
  const nodeDir = path.dirname(process.execPath);
  const npmDir = path.join(process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'), 'npm');
  return { ...process.env, PATH: [...new Set([...(process.env.PATH || '').split(sep), nodeDir, npmDir])].join(sep) };
}

const IS_WIN = process.platform === 'win32';
const BOSS_BIN = 'boss';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runBoss(args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const bin = IS_WIN ? 'cmd' : BOSS_BIN;
    const finalArgs = IS_WIN ? ['/d', '/s', '/c', BOSS_BIN, ...args] : args;
    const p = spawn(bin, finalArgs, { shell: false, env: childEnv() });
    let out = '', err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch {} resolve({ code: -1, out, err: err + '\n[超时]' }); }, timeoutMs);
    p.stdout?.on('data', (d) => { out += d; });
    p.stderr?.on('data', (d) => { err += d; });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e.message || e) }); });
  });
}

async function runLogin() {
  return new Promise((resolve) => {
    const bin = IS_WIN ? 'cmd' : BOSS_BIN;
    const finalArgs = IS_WIN ? ['/d', '/s', '/c', BOSS_BIN, 'login'] : ['login'];
    const p = spawn(bin, finalArgs, { shell: false, env: childEnv(), stdio: 'inherit' });
    p.on('close', (code) => resolve(code ?? 0));
    p.on('error', (e) => { console.error(String(e.message || e)); resolve(1); });
  });
}

async function main() {
  process.env.BOSS_BROWSER_HEADLESS = 'false';
  const timeoutArg = process.argv.find((x) => x.startsWith('--timeout='));
  const timeoutMs = timeoutArg ? Number(timeoutArg.slice(9)) : 10 * 60 * 1000;
  const first = await runBoss(['list', '--unread'], 30000);
  if (first.code === 0 && first.out.trim()) {
    console.log('BOSS 登录态已可用，无需扫码。');
    process.stdout.write(first.out.trim() + '\n');
    return 0;
  }
  console.log('需要登录：已打开登录窗口，请在浏览器中完成扫码/验证。');
  console.log('本脚本会等待登录成功，再返回给调用方；默认最多等待 10 分钟。');
  await runLogin();
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await sleep(3000);
    const r = await runBoss(['list', '--unread'], 30000);
    if (r.code === 0 && r.out.trim()) {
      console.log('BOSS 登录成功，已验证未读列表可用。');
      process.stdout.write(r.out.trim() + '\n');
      return 0;
    }
    process.stdout.write('.');
  }
  console.error('\n等待登录超时：请完成浏览器中的扫码/验证后重新运行本脚本。');
  return 1;
}

main().then((code) => { process.exitCode = code; }).catch((e) => { console.error(e); process.exitCode = 1; });
