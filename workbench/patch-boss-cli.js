'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function npmEnv() {
  const sep = path.delimiter;
  const nodeDir = path.dirname(process.execPath);
  const npmDir = path.join(process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'), 'npm');
  return { ...process.env, PATH: [...new Set([...(process.env.PATH || '').split(sep), nodeDir, npmDir])].join(sep) };
}

function npmRoot() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  if (process.platform === 'win32') {
    const out = execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm', 'root', '-g'], { encoding: 'utf8', env: npmEnv() });
    return out.trim();
  }
  return execFileSync('npm', ['root', '-g'], { encoding: 'utf8', env: npmEnv() }).trim();
}

function file(rel) {
  const f = path.join(npmRoot(), '@joohw', 'boss-cli', 'dist', rel);
  if (!fs.existsSync(f)) throw new Error('未找到 boss-cli 文件：' + f);
  return f;
}

function replaceOnce(text, oldText, newText, label) {
  if (!text.includes(oldText)) return [text, false];
  return [text.replace(oldText, newText), true];
}


function patchListEmptyRetry(text) {
  if (text.includes('const nextItems = (await page.evaluate')) return text;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((x) => x.includes('const items = (await page.evaluate'));
  const end = lines.findIndex((x, i) => i > start && x.includes('})()`));'));
  if (start < 0 || end < 0) return text;
  const block = lines.slice(start, end + 1);
  const letBlock = block.map((x) => x.replace('const items', 'let items'));
  const nextBlock = block.map((x) => x.replace('const items', 'const nextItems'));
  const retry = [
    ...letBlock,
    '            if (unreadOnly && !items.some((it) => it.unreadCount > 0)) {',
    '                for (let attempt = 0; attempt < 2; attempt++) {',
    "                    await sleepRandom(1000, 1500);",
    "                    await ensureChatListReady(page, 'unread');",
    ...nextBlock.map((x) => '                    ' + x),
    '                    items = nextItems;',
    '                    if (items.some((it) => it.unreadCount > 0)) break;',
    '                }',
    '            }'
  ];
  lines.splice(start, end - start + 1, ...retry);
  return lines.join('\n');
}


function patchListVirtualization() {
  const target = file('toolset/list.js');
  let text = fs.readFileSync(target, 'utf8');
  const find = (start, end, from = 0) => {
    const a = text.indexOf(start, from);
    if (a < 0) throw new Error('list.js: start marker missing');
    const b = text.indexOf(end, a);
    if (b < 0) throw new Error('list.js: end marker missing');
    return { a, b, content: text.slice(a, b + end.length) };
  };
  if (!text.includes('async function readGeekItems(page)')) {
    const block = find('let items = (await page.evaluate(`(() => {', '})()`));');
    const helper = [
      'async function readGeekItems(page) {',
      '    ' + block.content.replace('let items = (await page.evaluate', 'return (await page.evaluate'),
      '}',
      '',
    ].join('\n') + '\n\n';
    const pos = text.indexOf('async function scrollChatListToLoadMore');
    if (pos < 0) throw new Error('list.js: scroll marker missing');
    text = text.slice(0, pos) + helper + text.slice(pos);
  }
  if (!text.includes('const collected = new Map();')) {
    text = text.replace('async function scrollChatListToLoadMore(page, opts = {}) {', 'async function scrollChatListToLoadMore(page, opts = {}) {\n    const collected = new Map();');
    text = text.replace('        const before = await page.evaluate', '        for (const item of await readGeekItems(page)) collected.set(item.remoteId || item.name + "|" + item.job, item);\n        const before = await page.evaluate');
    text = text.replace('        const after = await page.evaluate', '        for (const item of await readGeekItems(page)) collected.set(item.remoteId || item.name + "|" + item.job, item);\n        const after = await page.evaluate');
    const sc = text.indexOf('async function scrollChatListToLoadMore');
    const cl = text.indexOf('async function clickChatFilterTab', sc);
    let seg = text.slice(sc, cl);
    const close = seg.lastIndexOf('    }\n}\n\n');
    if (close < 0) throw new Error('list.js: scroll close missing');
    seg = seg.slice(0, close) + '    }\n    return Array.from(collected.values());\n}\n\n' + seg.slice(close + '    }\n}\n\n'.length);
    text = text.slice(0, sc) + seg + text.slice(cl);
  }
  text = text.replace('    await scrollChatListToLoadMore(page);\n    await waitForCandidateListSettled(page, {', '    const collected = await scrollChatListToLoadMore(page);\n    await waitForCandidateListSettled(page, {');
  text = text.replace('        minMsBeforeEmptyOk: LIST_MIN_BEFORE_EMPTY_OK_MS,\n    });\n}', '        minMsBeforeEmptyOk: LIST_MIN_BEFORE_EMPTY_OK_MS,\n    });\n    return collected;\n}');
  text = text.replace('            await ensureChatListReady(page, unreadOnly ? \'unread\' : \'all\');', '            const collected = await ensureChatListReady(page, unreadOnly ? \'unread\' : \'all\');');
  if (text.includes('            let items = (await page.evaluate')) {
    const block = find('            let items = (await page.evaluate(`(() => {', '})()`));');
    const candidates = text.indexOf('            const candidates = items.filter((it) => it.name);', block.a);
    if (candidates < 0) throw new Error('list.js: candidates marker missing');
    const replacement = [
      '            let items = collected && collected.length ? collected : await readGeekItems(page);',
      '            if (unreadOnly && !items.some((it) => it.unreadCount > 0)) {',
      '                for (let attempt = 0; attempt < 2; attempt++) {',
      "                    await sleepRandom(1000, 1500);",
      "                    await ensureChatListReady(page, 'unread');",
      '                    items = await readGeekItems(page);',
      '                    if (items.some((it) => it.unreadCount > 0)) break;',
      '                }',
      '            }',
      ''
    ].join('\n');
    text = text.slice(0, block.a) + replacement + text.slice(candidates);
  }
  fs.writeFileSync(target, text, 'utf8');
}

function patchList() {
  const f = file('toolset/list.js');
  let s = fs.readFileSync(f, 'utf8');
  if (!s.includes('async function scrollChatListToLoadMore')) {
    const marker = 'async function clickChatFilterTab(page, label) {';
    if (!s.includes(marker)) throw new Error('list.js: 找不到插入滚动函数的位置');
    const fn = [
      'async function scrollChatListToLoadMore(page, opts = {}) {',
      '    const maxRounds = Number(opts.maxRounds || 30);',
      '    const timeoutMs = Number(opts.timeoutMs || 60000);',
      '    const started = Date.now();',
      '    let previous = -1;',
      '    let stable = 0;',
      '    let rounds = 0;',
      '    while (Date.now() - started < timeoutMs && rounds < maxRounds && stable < 2) {',
      '        rounds++;',
      '        const before = await page.evaluate(`(() => {',
      '            const el = document.querySelector(".user-list");',
      '            const count = document.querySelectorAll(".geek-item").length;',
      '            if (!el) return { count, scrollable: false };',
      '            const scrollable = el.scrollHeight > el.clientHeight;',
      '            el.scrollTop = el.scrollHeight;',
      '            el.dispatchEvent(new Event("scroll", { bubbles: true }));',
      '            return { count, scrollable };',
      '        })()`);',
      '        await sleepRandom(opts.pollMsMin || LIST_POLL_MS.min, opts.pollMsMax || LIST_POLL_MS.max);',
      '        const after = await page.evaluate(`(() => document.querySelectorAll(".geek-item").length)()`);',
      '        if (after === before.count && (!before.scrollable || after === previous)) stable++;',
      '        else { stable = 0; previous = after; }',
      '    }',
      '}',
      '',
    ].join('\n');
    s = s.replace(marker, fn + marker);
  }
  if (!s.includes('const remoteId = norm(el.getAttribute("data-id")')) {
    s = s.replace('            const name = norm(el.querySelector(".geek-name")?.textContent);', '            const remoteId = norm(el.getAttribute("data-id") || el.getAttribute("data-geekid") || "");\n            const name = norm(el.querySelector(".geek-name")?.textContent);');
  }
  s = s.replace('return { name, job, time, message, unreadCount };', 'return { remoteId, name, job, time, message, unreadCount };');
  if (!s.includes('it.remoteId ?')) {
    s = s.replace('                const meta = [\n                    it.unreadCount > 0', '                const meta = [\n                    it.remoteId ? `id:${it.remoteId}` : \'\',\n                    it.unreadCount > 0');
  }
  s = s.replace('    await waitForChatFilterTabSelected(page, filterLabel);\n    await waitForCandidateListSettled(page, {', '    await waitForChatFilterTabSelected(page, filterLabel);\n    await scrollChatListToLoadMore(page);\n    await waitForCandidateListSettled(page, {');
  s = patchListEmptyRetry(s);
  fs.writeFileSync(f, s, 'utf8');
}

function patchRecommend() {
  const f = file('toolset/recommend.js');
  let s = fs.readFileSync(f, 'utf8');
  if (s.includes('const allCards = Array.from(document.querySelectorAll(cardSel));')) return;
  // 0.6.6 起缩进是 6 空格（模板字符串内），旧补丁按 4 空格匹配会静默失效。
  // 用行首缩进正则兜住任意缩进，并替换全部出现（读列表 / greet 定位 / preview 定位都受益）。
  const re = /^([ \t]*)const cards = Array\.from\(document\.querySelectorAll\(cardSel\)\);$/gm;
  let hit = 0;
  s = s.replace(re, (line, indent) => {
    hit++;
    return [
      `${indent}const allCards = Array.from(document.querySelectorAll(cardSel));`,
      `${indent}const cards = allCards.filter((item) => !allCards.some((other) => other !== item && other.contains(item)));`,
    ].join('\n');
  });
  if (!hit) throw new Error('recommend.js: 没找到卡片选择语句，版本可能又变了');
  fs.writeFileSync(f, s, 'utf8');
  console.log(`recommend.js: 去重补丁已应用到 ${hit} 处`);
}

function patchPreviewNavigate() {
  const f = file('toolset/preview.js');
  let s = fs.readFileSync(f, 'utf8');
  if (s.includes('PREVIEW_AUTO_NAV_PATCH')) return;
  const old = `            else {
                throw new Error('当前不在推荐列表页、深度搜索页或常规搜索页，无法预览候选人。');
            }`;
  const neu = `            else {
                // PREVIEW_AUTO_NAV_PATCH：每条命令都是独立进程，页面常落在 /web/chat/index；
                // 先导航到推荐页再读，否则 preview 永远拿不到「当前已在推荐页」的前置状态。
                await page.goto('https://www.zhipin.com/web/chat/recommend', { waitUntil: 'load', timeout: 60000 });
                const frame = await assertRecommendPageReadyForPreview(page);
                jobLine = '当前岗位：当前推荐列表';
                savedOriginal = await snapshotBossPageViewport(page);
                opened = await openRecommendResumePreview(frame, target);
            }`;
  if (!s.includes(old)) throw new Error('preview.js: 未找到「不在列表页」的回退分支，版本可能又变了');
  fs.writeFileSync(f, s.replace(old, neu), 'utf8');
  console.log('preview.js: 已支持自动导航到推荐页（原为直接报错）');
}

function patchPreviewByIndex() {
  const f = file('toolset/recommend.js');
  let s = fs.readFileSync(f, 'utf8');
  if (s.includes('PREVIEW_BY_INDEX_PATCH')) return;
  const old = `    const targetCard = cards.find((item) => {
      const name =
        norm(item.querySelector(".name-wrap .name")?.textContent) ||
        norm(item.querySelector(".name")?.textContent);
      return name === raw || name.includes(raw);
    }) ?? null;`;
  const neu = `    let targetCard = null;
    // PREVIEW_BY_INDEX_PATCH：推荐列表跨命令会重排，按姓名不可靠；支持 "#1" 按位置取卡片
    const isIdx = raw.length > 1 && raw[0] === "#" && /^[0-9]+$/.test(raw.slice(1));
    if (isIdx) {
      targetCard = cards[Number(raw.slice(1)) - 1] ?? null;
    } else {
      targetCard = cards.find((item) => {
        const name =
          norm(item.querySelector(".name-wrap .name")?.textContent) ||
          norm(item.querySelector(".name")?.textContent);
        return name === raw || name.includes(raw);
      }) ?? null;
    }`;
  if (!s.includes(old)) throw new Error('recommend.js: 未找到按姓名取卡片的代码块');
  fs.writeFileSync(f, s.replace(old, neu), 'utf8');
  console.log('recommend.js: preview 支持 "#N" 按位置读取');
}

function patchChatById() {
  const indexFile = file('toolset/index.js');
  let index = fs.readFileSync(indexFile, 'utf8');
  if (!index.includes('        id: params.id,')) {
    index = index.replace('        index: params.index,\n        filter:', '        index: params.index,\n        id: params.id,\n        filter:');
    fs.writeFileSync(indexFile, index, 'utf8');
  }

  const routerFile = file('cli/cliRouter.js');
  let router = fs.readFileSync(routerFile, 'utf8');
  router = router.replace('boss chat [姓名] --index <序号> [--unread] [--strict]', 'boss chat [姓名] --index <序号>|--id <稳定ID> [--unread] [--strict]');
  router = router.replace("const allowedOpts = new Set(['index', 'i', 'action', 'remark']);", "const allowedOpts = new Set(['index', 'i', 'id', 'action', 'remark']);");
  if (!router.includes('const idRaw = (opts.id ??')) {
    router = router.replace("        const indexRaw = (opts.index ?? opts.i ?? '').trim();\n        if (indexRaw) {", "        const indexRaw = (opts.index ?? opts.i ?? '').trim();\n        const idRaw = (opts.id ?? '').trim();\n        if (indexRaw && idRaw) die('chat 不能同时使用 --index 和 --id');\n        if (idRaw) {\n            if (!/^[A-Za-z0-9_-]+$/.test(idRaw)) die('chat --id 只允许字母、数字、下划线和短横线');\n            return implOpenChatByIndex({ id: idRaw, unreadOnly: flags.has('unread'), expectedName: nameArg || undefined, exact });\n        }\n        if (indexRaw) {");
  }
  fs.writeFileSync(routerFile, router, 'utf8');

  const chatFile = file('toolset/chat.js');
  let chat = fs.readFileSync(chatFile, 'utf8');
  if (!chat.includes('const targetId = params.id?.trim()')) {
    const old = 'export async function runOpenCandidateChatByIndex(page, params) {\n    if (!Number.isInteger(params.index) || params.index < 1) {';
    const neu = 'export async function runOpenCandidateChatByIndex(page, params) {\n    const targetId = params.id?.trim() ?? \'\';\n    if (!targetId && (!Number.isInteger(params.index) || params.index < 1)) {';
    if (!chat.includes(old)) throw new Error('chat.js: 找不到 chat by index 函数');
    chat = chat.replace(old, neu);
    chat = chat.replace("    const expectedName = params.expectedName?.trim() ?? '';\n    const exact = params.exact === true;\n    await ensureChatListReady(page, filter);", "    const expectedName = params.expectedName?.trim() ?? '';\n    const exact = params.exact === true;\n    if (targetId && !/^[A-Za-z0-9_-]+$/.test(targetId)) throw new Error('聊天列表稳定 ID 格式无效');\n    await ensureChatListReady(page, filter);");
  }
  chat = chat.replace('    const rowInfo = (await page.evaluate(`((rowIndex) => {', '    const rowInfo = (await page.evaluate(`((params) => {');
  chat = chat.replace('    const wrap = wraps[rowIndex - 1];', '    const wrap = params.id ? wraps.find((w) => (w.querySelector(".geek-item") || w).getAttribute("data-id") === params.id) : wraps[params.index - 1];\n    const rowIndex = wrap ? wraps.indexOf(wrap) + 1 : params.index;');
  chat = chat.replace('    if (!wrap) return { total, name: "", job: "", message: "", time: "", x: 0, y: 0 };', '    if (!wrap) return { total, index: params.index, name: "", job: "", message: "", time: "", x: 0, y: 0 };');
  chat = chat.replace('      total,\n      name: norm(wrap.querySelector(".geek-name")?.textContent),', '      total,\n      index: rowIndex,\n      name: norm(wrap.querySelector(".geek-name")?.textContent),');
  chat = chat.replace('    })(${JSON.stringify(params.index)})`));', '    })(${JSON.stringify({ index: params.index, id: targetId })})`));');
  fs.writeFileSync(chatFile, chat, 'utf8');
}

function main() {
  // 每个补丁独立生效：上游改版导致某一段匹配不上时，不应该阻塞其余补丁。
  const steps = [
    ['滚动加载', patchList],
    ['列表虚拟化', patchListVirtualization],
    ['推荐去重', patchRecommend],
    ['预览自动导航', patchPreviewNavigate],
    ['预览按位置', patchPreviewByIndex],
    ['稳定 ID', patchChatById],
  ];
  const failed = [];
  for (const [name, fn] of steps) {
    try { fn(); } catch (e) { failed.push(`${name}：${e.message || e}`); }
  }
  if (failed.length) {
    console.error('以下补丁未应用（上游代码结构可能已变，其余补丁不受影响）：');
    for (const f of failed) console.error('  - ' + f);
    process.exitCode = 1;
  }
  console.log(`boss-cli 补丁完成：${steps.length - failed.length}/${steps.length} 项生效`);
}

try {
  main();
} catch (e) {
  console.error(String(e.message || e));
  process.exitCode = 1;
}
