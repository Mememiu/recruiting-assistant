/* 招聘工作台 前端逻辑 —— 零构建，改完刷新即可 */

const $ = (s) => document.querySelector(s);
const PALETTE = ['#6366f1', '#818cf8', '#4f46e5', '#a5b4fc', '#10b981', '#f59e0b',
  '#3b82f6', '#ef4444', '#8b5cf6', '#06b6d4', '#94a3b8', '#c7d2fe'];

const CORE_COLS = ['序号', '姓名', '应聘岗位', '硬门槛', '命脉命中', '评级', '状态',
  '待验证点', '处理结果', '归因原因'];
const NO_EDIT = ['序号', '姓名', '应聘岗位'];

let HEADER = [], ROWS = [], HIDDEN = new Set(), FILTER = { role: '', status: '', hard: '', q: '' };
let charts = {};
let SORT = { col: null, dir: 1 };   // 排序状态：col=列名，dir=1升序/-1降序

// ── 工具

const tag = (v) => {
  if (!v) return '';
  const cls = /通过|符合|^✓/.test(v) ? 't-ok'
    : /不符|排除|超限/.test(v) ? 't-no'
      : /待核|待定|存疑/.test(v) ? 't-wait'
        : /未填/.test(v) ? 't-gray' : 't-pri';
  return `<span class="tag ${cls}">${esc(v)}</span>`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── 数据加载

async function load() {
  const cfg = await (await fetch('/api/config')).json();
  $('#dataHome').textContent = cfg.dataHome;

  const led = await (await fetch('/api/ledger')).json();
  if (!led.ok) { $('#stats').innerHTML = `<div class="alert alert-danger">${led.error}</div>`; return; }
  HEADER = led.header; ROWS = led.rows;

  HIDDEN = new Set(HEADER.filter((h) => !CORE_COLS.includes(h)));
  buildColPanel();
  buildFilters();
  render();
  loadStats();
  loadCandidates();
  initCharts();
  loadTasks();
  loadFreshness();
  loadUsage();
  loadReports();
  loadToday();
  await loadInbox();
  await refreshRunStatus();
}

// ── 今日看板

async function loadToday() {
  const today = new Date();
  const stamp = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  const iSrc = HEADER.indexOf('来源轮次'), iStatus = HEADER.indexOf('状态');
  const iVer = HEADER.indexOf('待验证点'), iAi = HEADER.indexOf('AI建议');
  const iName = HEADER.indexOf('姓名'), iRating = HEADER.indexOf('评级');
  const iRole = HEADER.indexOf('应聘岗位'), iHard = HEADER.indexOf('硬门槛');

  const todayNew = ROWS.filter((r) => (r[iSrc] || '').includes(stamp)).length;
  const pending = ROWS.filter((r) => (r[iVer] || '').trim());
  const aiPending = ROWS.filter((r) => (r[iAi] || '').trim() && r[iStatus] === '待初筛');
  const toScreen = ROWS.filter((r) => r[iStatus] === '待初筛' && !r[iHard]).length;

  const cards = [
    ['今日新增', todayNew],
    ['待初筛', ROWS.filter((r) => r[iStatus] === '待初筛').length],
    ['初筛通过', ROWS.filter((r) => r[iStatus] === '初筛通过' || r[iStatus] === '面试中').length],
    ['硬门槛空缺', toScreen],
    ['AI 建议待看', aiPending.length],
  ];
  $('#todayStats').innerHTML = cards.map(([l, n]) =>
    `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');

  $('#todayPending').innerHTML = pending.length
    ? pending.map((r) => `<div style="padding:6px 0;border-bottom:1px solid var(--gray-100);font-size:13px">
        <b>${esc(r[iName])}</b> ${esc(r[iRating] || '')} <span style="color:var(--gray-500)">· ${esc((r[iRole] || '').replace('（日常实习）', ''))}</span><br>
        <span style="color:var(--gray-600)">${esc(r[iVer])}</span></div>`).join('')
    : '<div class="empty">暂无</div>';

  $('#todayAi').innerHTML = aiPending.length
    ? `<div class="empty" style="padding:12px">有 ${aiPending.length} 条 AI 建议待你过目 —— 去台账打开「AI建议」列</div>`
    : `<div class="empty" style="padding:12px">还没有 AI 建议 —— 去「任务」页跑「批量 AI 初筛」<br><span style="font-size:12px">（只花 token，不碰 BOSS）</span></div>`;
}

// ── 数据新鲜度：这份数据是几点抓的？（不知道会造成误判）

async function loadFreshness() {
  const r = await (await fetch('/api/freshness')).json();
  const bar = $('#freshBar');
  if (!r.lastPull) {
    bar.textContent = '还没从 BOSS 拉过数据 —— 去「任务」页点「拉取今日未读」';
    bar.className = 'fresh';
    bar.hidden = false;
    return;
  }
  const d = new Date(r.lastPull);
  const p2 = (n) => String(n).padStart(2, '0');
  const when = `${d.getMonth() + 1}月${d.getDate()}日 ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const stale = r.hoursAgo > 6;
  bar.textContent = `数据拉取于 ${when}（${r.hoursAgo} 小时前）`
    + (stale ? ' —— 已经过了一阵子，要不要去「任务」页重新拉一次？' : '');
  bar.className = 'fresh' + (stale ? '' : ' ok');
  bar.hidden = false;
}

// ── AI 用量

async function loadUsage() {
  const r = await (await fetch('/api/ai/usage')).json();
  if (!r.ok) return;
  const models = Object.entries(r.byModel || {}).map(([m, t]) => `${m} ${t}t`).join(' · ') || '—';
  $('#usageBody').innerHTML = `
    <div class="usage-line">
      <div>调用 <b>${r.calls}</b> 次</div>
      <div>合计 <b>${r.totalTokens}</b> token</div>
    </div>
    <div style="font-size:12px;color:var(--gray-400);margin-top:8px">按模型：${esc(models)}</div>`;
}

// ── 日报

async function loadReports() {
  const r = await (await fetch('/api/report/list')).json();
  const items = r.items || [];
  if (!items.length) {
    $('#repList').innerHTML = '<div class="empty">还没有日报</div>';
    $('#repBody').innerHTML = '<div class="empty">去「任务」页点「生成今日日报」</div>';
    return;
  }
  $('#repList').innerHTML = items.map((c, i) => `
    <div class="cand-item ${i === 0 ? 'active' : ''}" data-name="${esc(c.name)}">
      <div class="n">${esc(c.name)}</div><div class="d">${esc(c.mtime)}</div></div>`).join('');
  $('#repList').onclick = (e) => {
    const it = e.target.closest('.cand-item');
    if (!it) return;
    $('#repList').querySelectorAll('.cand-item').forEach((x) => x.classList.remove('active'));
    it.classList.add('active');
    openReport(it.dataset.name);
  };
  openReport(items[0].name);
}

async function openReport(name) {
  const r = await (await fetch('/api/report/read?name=' + encodeURIComponent(name))).json();
  $('#repBody').innerHTML = r.ok ? md(r.content) : `<div class="empty">${esc(r.error)}</div>`;
}

async function loadStats() {
  const s = await (await fetch('/api/stats')).json();
  if (!s.ok) return;
  const pick = (arr, key) => (arr.find((x) => x[0] === key) || [0, 0])[1];
  const cards = [
    ['候选人总数', s.total],
    ['待初筛', pick(s.byStatus, '待初筛')],
    ['初筛通过', pick(s.byStatus, '初筛通过') + pick(s.byStatus, '面试中')],
    ['已排除', pick(s.byStatus, '已排除')],
    ['硬门槛待核', pick(s.byHardGate, '待核')],
  ];
  $('#stats').innerHTML = cards.map(([l, n]) =>
    `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');
}

function buildFilters() {
  const iRole = HEADER.indexOf('应聘岗位'), iStatus = HEADER.indexOf('状态');
  const roles = [...new Set(ROWS.map((r) => r[iRole]).filter(Boolean))].sort();
  const sts = [...new Set(ROWS.map((r) => r[iStatus]).filter(Boolean))].sort();
  $('#fRole').innerHTML = '<option value="">全部岗位</option>' +
    roles.map((r) => `<option>${esc(r)}</option>`).join('');
  $('#fStatus').innerHTML = '<option value="">全部状态</option>' +
    sts.map((r) => `<option>${esc(r)}</option>`).join('');
}

function buildColPanel() {
  $('#colsPanel').innerHTML = HEADER.map((h) =>
    `<label><input type="checkbox" data-col="${esc(h)}" ${HIDDEN.has(h) ? '' : 'checked'}> ${esc(h)}</label>`
  ).join('');
  $('#colsPanel').addEventListener('change', (e) => {
    const col = e.target.dataset.col;
    if (!col) return;
    if (e.target.checked) HIDDEN.delete(col); else HIDDEN.add(col);
    render();
  });
  $('#colsBtn').addEventListener('click', () => $('#colsPanel').classList.toggle('open'));
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.cols-toggle')) $('#colsPanel').classList.remove('open');
  });
}

// ── 表格渲染

function visibleRows() {
  const iRole = HEADER.indexOf('应聘岗位'), iStatus = HEADER.indexOf('状态');
  const iHard = HEADER.indexOf('硬门槛');
  return ROWS.filter((r) => {
    if (FILTER.role && r[iRole] !== FILTER.role) return false;
    if (FILTER.status && r[iStatus] !== FILTER.status) return false;
    if (FILTER.hard && r[iHard] !== FILTER.hard) return false;
    if (FILTER.q) {
      const hay = r.join(' ').toLowerCase();
      if (!hay.includes(FILTER.q.toLowerCase())) return false;
    }
    return true;
  });
}

function render() {
  const cols = HEADER.filter((h) => !HIDDEN.has(h));
  $('table thead').innerHTML = '<tr>' + cols.map((h) => {
    const arrow = SORT.col === h ? (SORT.dir === 1 ? ' ▲' : ' ▼') : '';
    const cls = SORT.col === h ? ' style="color:var(--primary-600);cursor:pointer"' : ' style="cursor:pointer"';
    return `<th${cls} data-sort="${esc(h)}">${esc(h)}${arrow}</th>`;
  }).join('') + '</tr>';

  let rows = visibleRows();

  // 排序：点击过表头就按该列排；中文用 localeCompare，星级按 ⭐ 个数
  if (SORT.col) {
    const i = HEADER.indexOf(SORT.col);
    const star = (s) => ((s || '').match(/⭐/g) || []).length;
    rows = [...rows].sort((a, b) => {
      const va = a[i] || '', vb = b[i] || '';
      if (SORT.col === '评级') return (star(va) - star(vb)) * SORT.dir;
      if (SORT.col === '序号') return (parseInt(va) - parseInt(vb)) * SORT.dir;
      return va.localeCompare(vb, 'zh-Hans-CN') * SORT.dir;
    });
  }

  $('#rowCount').textContent = `显示 ${rows.length} / ${ROWS.length} 人`
    + (SORT.col ? ` · 按「${SORT.col}」${SORT.dir === 1 ? '升' : '降'}序` : '');

  $('table tbody').innerHTML = rows.map((r) => {
    return '<tr>' + cols.map((h) => {
      const i = HEADER.indexOf(h);
      const v = r[i] || '';
      const canEdit = !NO_EDIT.includes(h);
      let inner;
      if (h === '评级') inner = v ? `<span class="star">${esc(v)}</span>` : '';
      else if (['硬门槛', '处理结果', '状态'].includes(h)) inner = tag(v);
      else if (h === '归因原因') inner = v ? tag(v) : '';
      else if (h === '备注') inner = `<div class="note-cell">${esc(v)}</div>`;
      else inner = esc(v);
      return `<td class="${canEdit ? 'editable' : ''}" data-col="${esc(h)}" data-id="${esc(r[HEADER.indexOf('序号')])}" data-name="${esc(r[1])}">${inner}</td>`;
    }).join('') + '</tr>';
  }).join('');
}

// ── 单元格编辑（点一下改，失焦保存）

/** 枚举列：点击出下拉而不是自由输入 —— 自由文本没法统计，归因就白做了 */
const ENUMS = {
  '处理结果': ['通过', '排除', '待核'],
  '归因原因': ['资格不符', '关键能力不足', '履历待核', '岗位意向不符',
    '薪资不符', '地点不符', '候选人放弃', '岗位暂停', '未响应', '其他'],
};
const CLEAR = '__clear__', CUSTOM = '__custom__';

$('table tbody').addEventListener('click', (e) => {
  const td = e.target.closest('td.editable');
  if (!td || td.querySelector('input') || td.querySelector('select')) return;
  const col = td.dataset.col, name = td.dataset.name;
  const row = ROWS.find((r) => r[HEADER.indexOf('序号')] === td.dataset.id);
  const old = row ? row[HEADER.indexOf(col)] : '';

  // 枚举列 → 下拉
  if (ENUMS[col]) {
    const opts = [...ENUMS[col]];
    if (old && !opts.includes(old)) opts.unshift(old);   // 现值不在枚举里也保留可选
    td.innerHTML = `<select style="width:100%;border:0;font:inherit;background:transparent;outline:none">
      <option value="">(清空)</option>
      ${opts.map((o) => `<option ${o === old ? 'selected' : ''}>${esc(o)}</option>`).join('')}
      <option value="${CUSTOM}">(自定义…)</option></select>`;
    const sel = td.querySelector('select');
    sel.focus();
    sel.addEventListener('change', () => {
      if (sel.value === CUSTOM) {
        const v = prompt(`自定义「${col}」（${name}）—— 尽量用枚举，方便统计`, old);
        if (v === null) { render(); return; }
        save(name, col, v.trim(), td);
      } else {
        save(name, col, sel.value, td);
      }
    });
    sel.addEventListener('blur', () => { if (td.querySelector('select')) render(); });
    return;
  }

  const isLong = col === '备注' || col === '现职/背景' || col === '待验证点' || col === 'AI建议';

  if (isLong) {
    const next = prompt(`编辑「${col}」（${name}）`, old);
    if (next === null || next === old) return;
    save(name, col, next, td);
  } else {
    td.dataset.old = old;
    td.innerHTML = `<input value="${esc(old)}">`;
    const inp = td.querySelector('input');
    inp.focus();
    inp.select();
    const commit = () => save(name, col, inp.value, td);
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); inp.blur(); }
      if (ev.key === 'Escape') { td.textContent = td.dataset.old; }
    });
  }
});

async function save(name, col, value, td) {
  const r = await (await fetch('/api/ledger/cell', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, col, value, id: td.dataset.id }),
  })).json();
  if (!r.ok) { alert('保存失败：' + r.error); load(); return; }
  const row = ROWS.find((x) => x[HEADER.indexOf('序号')] === td.dataset.id);
  row[HEADER.indexOf(col)] = value;
  const flash = td;
  if (flash) { flash.style.background = '#d1fae5'; setTimeout(() => { flash.style.background = ''; }, 600); }
  render();
  loadStats();
}

// ── 筛选与排序

['fRole', 'fStatus', 'fHard', 'fSearch'].forEach((id) => {
  const key = { fRole: 'role', fStatus: 'status', fHard: 'hard', fSearch: 'q' }[id];
  $('#' + id).addEventListener('input', (e) => { FILTER[key] = e.target.value; render(); });
});

// 点表头排序：第一次升序，再点降序，第三次恢复原序
$('table thead').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-sort]');
  if (!th) return;
  const col = th.dataset.sort;
  if (SORT.col !== col) SORT = { col, dir: 1 };
  else if (SORT.dir === 1) SORT.dir = -1;
  else SORT = { col: null, dir: 1 };   // 第三次点 = 取消排序
  render();
});

// ── 图表

async function initCharts() {
  const s = await (await fetch('/api/stats')).json();
  if (!s.ok) return;
  bar('cRole', s.byRole, '人数');
  pie('cStatus', s.byStatus);
  pie('cHard', s.byHardGate);
  pie('cReason', s.byReason.filter((x) => x[0] !== '(未填)'));
  // 来源归类：20260922boss未读 → 投递；boss推荐/boss搜索 → 主动寻源
  const src = {};
  for (const [k, v] of s.bySource) {
    const key = /推荐/.test(k) ? '推荐牛人（主动）' : /搜索/.test(k) ? '搜索池（主动）' : '主动投递（未读）';
    src[key] = (src[key] || 0) + v;
  }
  bar('cSource', Object.entries(src).sort((a, b) => b[1] - a[1]), '人数');
}

function mk(id) {
  if (charts[id]) return charts[id];
  charts[id] = echarts.init(document.getElementById(id));
  return charts[id];
}
function bar(id, data, name) {
  const c = mk(id);
  c.setOption({
    grid: { left: 8, right: 20, top: 16, bottom: 8, containLabel: true },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'value', splitLine: { lineStyle: { color: '#f1f5f9' } } },
    yAxis: { type: 'category', data: data.map((d) => d[0]).reverse(),
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { fontSize: 12, width: 150, overflow: 'truncate' } },
    series: [{
      type: 'bar', name, data: data.map((d) => d[1]).reverse(),
      itemStyle: { color: '#6366f1', borderRadius: [0, 4, 4, 0] }, barWidth: '55%',
      label: { show: true, position: 'right', fontSize: 12 },
    }],
  });
}
function pie(id, data) {
  const c = mk(id);
  c.setOption({
    tooltip: { trigger: 'item' },
    legend: { bottom: 0, itemWidth: 10, itemHeight: 10, textStyle: { fontSize: 12 } },
    series: [{
      type: 'pie', radius: ['42%', '68%'], center: ['50%', '44%'],
      data: data.map((d, i) => ({ name: d[0], value: d[1] })),
      itemStyle: { borderColor: '#fff', borderWidth: 2 },
      label: { fontSize: 12, formatter: '{b} {c}' },
      color: PALETTE,
    }],
  });
}

// ── 档案

async function loadCandidates() {
  const r = await (await fetch('/api/candidates')).json();
  const list = r.items || [];
  if (!list.length) {
    $('#candList').innerHTML = '<div class="empty">还没有档案</div>';
    return;
  }
  $('#candList').innerHTML = list.map((c, i) =>
    `<div class="cand-item ${i === 0 ? 'active' : ''}" data-name="${esc(c.name)}">
       <div class="n">${esc(c.name)}</div><div class="d">更新于 ${esc(c.mtime)}</div></div>`).join('');
  // 用 onclick 覆盖式赋值（不是 addEventListener）——load() 会被多次调用，
  // 用 addEventListener 会一次叠一层，点一下触发好几个
  $('#candList').onclick = (e) => {
    const it = e.target.closest('.cand-item');
    if (!it) return;
    $('#candList').querySelectorAll('.cand-item').forEach((x) => x.classList.remove('active'));
    it.classList.add('active');
    openCandidate(it.dataset.name);
  };
  openCandidate(list[0].name);
}

async function openCandidate(name) {
  const r = await (await fetch('/api/candidate?name=' + encodeURIComponent(name))).json();
  $('#candBody').innerHTML = r.ok ? md(r.content) : `<div class="empty">${esc(r.error)}</div>`;
  $('#candBar').hidden = !r.ok;
  $('#candName').textContent = r.ok ? name : '';
  $('#aiBox').hidden = true;
  $('#aiHint').textContent = '';
}

// AI 初筛建议：只给建议，不写台账 —— 采纳与否由人点
$('#aiBtn').addEventListener('click', async () => {
  const name = $('#candName').textContent;
  if (!name) return;
  const btn = $('#aiBtn');
  btn.disabled = true;
  btn.textContent = 'AI 判断中…';
  $('#aiHint').textContent = '（会花一点 token，约 10 秒）';
  try {
    const r = await (await fetch('/api/ai/screen', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })).json();
    if (!r.ok) { alert(r.error || '调用失败'); return; }
    $('#aiBox').innerHTML = md(r.content)
      + `<div class="ai-meta">模型 ${esc(r.model)} · 耗时 ${(r.ms / 1000).toFixed(1)}s · token ${r.usage && r.usage.total_tokens ? r.usage.total_tokens : '?'}</div>`;
    $('#aiBox').hidden = false;
    $('#aiHint').textContent = '';
  } finally {
    btn.disabled = false;
    btn.textContent = 'AI 初筛建议';
  }
});

/** 极简 Markdown 渲染（够读档案就行，不引第三方库） */
function md(src) {
  let s = esc(src);
  s = s.replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^\|(.+)\|$/gm, (m) => {
      const cells = m.slice(1, -1).split('|').map((c) => `<td>${c.trim()}</td>`).join('');
      return `<tr>${cells}</tr>`;
    });
  // 把连续的 <tr> 行包成表格
  s = s.replace(/(<tr>.*<\/tr>\n?)+/g, (m) => {
    const head = m.split('\n')[0].replace(/<td>/g, '<th>').replace(/<\/td>/g, '</th>');
    const body = m.split('\n').slice(2).join('');
    return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
  });
  s = s.replace(/^[-*] (.*)$/gm, '<li>$1</li>');
  s = s.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>');
  return '<p>' + s + '</p>';
}

// ── 视图切换

document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    $('#view-' + t.dataset.view).classList.add('active');
    if (t.dataset.view === 'charts') {
      Object.values(charts).forEach((c) => c.resize());
    }
  });
});

// ── 任务：预览 → 你确认 → 才执行（票据单次有效，不设「总是允许」）

let TOKEN = null;
let SELECTED_TASK = null;
let RUN_TIMER = null;

async function loadTasks() {
  const r = await (await fetch('/api/task/list')).json();
  if (!r.ok) return;
  const roles = [...new Set(ROWS.map((x) => x[HEADER.indexOf('应聘岗位')]).filter(Boolean))].sort();
  $('#taskList').innerHTML = (r.items || []).map((t) => `
    <div class="task-card">
      <h3>${esc(t.label)}</h3>
      <p>${esc(t.desc)}</p>
      ${t.id === 'search-pool' ? `
        <div class="tform">
          <input class="f-kw" placeholder="搜索关键词（必填）" style="min-width:210px">
          <select class="f-job">
            <option value="">不限岗位</option>
            ${roles.map((x) => `<option>${esc(x)}</option>`).join('')}
          </select>
          <input class="f-age" placeholder="年龄范围" style="width:104px">
          <input class="f-degree" placeholder="学历 如 本科" style="width:104px">
        </div>
        <div class="thint">筛选参数可留空。传错它会把可选项列出来，照着改就行。</div>` : ''}
      ${t.id === 'recommend-pool' ? `
        <div class="tform">
          <select class="f-job">
            <option value="">不切岗位（用当前筛选）</option>
            ${roles.map((x) => `<option>${esc(x)}</option>`).join('')}
          </select>
        </div>
        <div class="thint">拉列表免费；看完挑最对口的再花简历额度，别见一个开一个。</div>` : ''}
      <button class="btn btn-primary btn-sm" data-task="${esc(t.id)}">预览并确认</button>
    </div>`).join('');
}

$('#taskList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-task]');
  if (b) askRun(b.dataset.task);
});

async function askRun(task, suppliedOpts) {
  const btn = document.querySelector(`button[data-task="${task}"]`);
  if (btn) { btn.disabled = true; btn.textContent = '正在生成预览…'; }
  try {
    // 搜索池寻源要带参数：从卡片上的小表单收集
    let opts = suppliedOpts || {};
    if (task === 'search-pool' || task === 'recommend-pool') {
      const card = btn.closest('.task-card');
      opts = { job: card.querySelector('.f-job') ? card.querySelector('.f-job').value : '' };
      if (task === 'search-pool') {
        opts.keyword = card.querySelector('.f-kw').value.trim();
        opts.ageRange = card.querySelector('.f-age').value.trim();
        opts.degree = card.querySelector('.f-degree').value.trim();
        if (!opts.keyword) { alert('先填关键词，再预览'); return; }
      }
    }
    const r = await (await fetch('/api/task/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, targetRole: suppliedOpts ? '' : FILTER.role || '', opts }),
    })).json();
    if (!r.ok) { alert('无法执行：' + r.error); return; }
    if (!r.commands.length) {
      alert(FILTER.role
        ? `「${FILTER.role}」里没有需要跑的人 —— 这个字段都已经填过了。`
        : '没有需要跑的人 —— 要筛的字段都已经填过了。');
      return;
    }

    TOKEN = r.token;
    SELECTED_TASK = task;
    $('#mTitle').textContent = r.label + (!suppliedOpts && FILTER.role && task !== 'pull-unread' ? `（仅「${FILTER.role}」）` : '');
    $('#mDesc').textContent = r.desc;
    const shown = task === 'inbox-resume-role' ? r.commands : r.commands.slice(0, 12);
    $('#mCmds').innerHTML =
      `<div style="color:var(--primary-600)">共 ${r.commands.length} 条命令，预计约 ${r.estimateSec} 秒</div>` +
      shown.map((c) => `<div>${esc(c)}</div>`).join('') +
      (r.commands.length > shown.length ? `<div>… 其余 ${r.commands.length - shown.length} 条同类命令</div>` : '');
    $('#modal').hidden = false;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '预览并确认'; }
  }
}

$('#mCancel').addEventListener('click', () => { $('#modal').hidden = true; TOKEN = null; });
$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') { $('#modal').hidden = true; TOKEN = null; }
});

$('#mGo').addEventListener('click', async () => {
  $('#modal').hidden = true;
  const token = TOKEN;
  const task = SELECTED_TASK;
  TOKEN = null;
  showView('task');
  $('#runBox').hidden = false;
  $('#runTitle').textContent = '执行中…';
  $('#runLog').textContent = '任务已提交，正在等待结果…';
  watchRun();
  try {
    const r = await (await fetch('/api/task/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, confirm: true }),
    })).json();
    await refreshRunStatus();
    if (r.ok && task === 'pull-unread') { $('#inboxFilter').value = 'pending'; $('#inboxSearch').value = ''; }
    await load();
    if (task === 'pull-unread' || task === 'inbox-chat' || task === 'inbox-resume' || task === 'inbox-resume-role') {
      showView('inbox');
      inboxNotice(r.ok ? (task === 'pull-unread' ? '已整理最新未读，可按岗位查看候选人。' : task === 'inbox-resume' ? '在线简历已保存，可查看原图和线索。' : task === 'inbox-resume-role' ? '本岗简历查看已完成，请查看各人原图与线索；失败名单在任务日志中。' : '完整沟通已更新。')
        : (r.error || '拉取未完成，请到任务页查看执行日志。'), !r.ok);
    } else if (!r.ok && !r.result?.cancelled) alert(r.error || '执行失败，请查看日志。');
  } catch (e) {
    $('#runTitle').textContent = '连接中断';
    $('#runLog').textContent += '\n无法取得任务结果，请刷新检查任务状态，避免重复提交。';
  }
});

function watchRun() {
  if (!RUN_TIMER) RUN_TIMER = setInterval(refreshRunStatus, 1200);
}

async function refreshRunStatus() {
  try {
    const s = await (await fetch('/api/task/status')).json();
    if (!s.task) return;
    $('#runBox').hidden = false;
    $('#runLog').textContent = (s.logs || []).join('\n');
    $('#runProg').textContent = s.total ? `${s.current} / ${s.total}` : '';
    $('#runTitle').textContent = s.cancelled ? '已取消' : s.done ? (s.ok ? '完成' : '执行失败')
      : s.cancelRequested ? '正在取消…' : s.paused ? '已暂停'
        : s.pauseRequested ? '暂停中…' : '执行中…';
    const controllable = s.running && s.task === 'ai-screen-batch' && s.controllable;
    $('#runActions').hidden = !controllable;
    $('#runPause').textContent = s.pauseRequested ? '继续' : '暂停';
    $('#runPause').disabled = !controllable || s.cancelRequested;
    $('#runCancel').disabled = !controllable || s.cancelRequested;
    if (s.running) watchRun();
    else if (RUN_TIMER) { clearInterval(RUN_TIMER); RUN_TIMER = null; }
  } catch { $('#runProg').textContent = '正在重新连接…'; }
}

async function controlRun(action, button) {
  button.disabled = true;
  try {
    const r = await (await fetch('/api/task/control', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })).json();
    if (!r.ok) alert(r.error || '操作失败');
  } catch { alert('连接中断，请刷新检查任务状态。'); }
  finally { await refreshRunStatus(); }
}

$('#runPause').addEventListener('click', (e) =>
  controlRun(e.currentTarget.textContent === '继续' ? 'resume' : 'pause', e.currentTarget));
$('#runCancel').addEventListener('click', (e) => controlRun('cancel', e.currentTarget));

// ── 未读待办：消息、台账关联与跟进，不自动发消息或作录用判断。
let INBOX = { items: [], preview: [] }, INBOX_SELECTED = null;
let INBOX_DRAFTS = {};
let INBOX_SAVED_ROLE = '';
try { INBOX_SAVED_ROLE = localStorage.getItem('inbox-role') || ''; } catch { /* Storage is optional. */ }
try { INBOX_DRAFTS = JSON.parse(sessionStorage.getItem('inbox-drafts') || '{}'); } catch { /* Storage is optional. */ }
function persistInboxDrafts() {
  try { sessionStorage.setItem('inbox-drafts', JSON.stringify(INBOX_DRAFTS)); } catch { /* Keep in-memory drafts. */ }
}

function showView(view) {
  document.querySelector(`.tab[data-view="${view}"]`).click();
}
function inboxNotice(text, error = false) {
  $('#inboxNotice').textContent = text;
  $('#inboxNotice').className = error ? 'error' : '';
}
function inboxItems() {
  if (INBOX.needsImport) return (INBOX.preview || []).map((i) => ({ ...i, previewOnly: true }));
  return INBOX.items || [];
}
async function loadInbox() {
  try {
    const data = await (await fetch('/api/inbox')).json();
    if (!data.ok) throw new Error(data.error);
    INBOX = data;
    $('#inboxImportBar').hidden = !data.needsImport;
    const source = data.latest || data.source || '';
    const day = source ? `${source.slice(0, 4)}-${source.slice(4, 6)}-${source.slice(6, 8)}` : '';
    $('#inboxImportHint').textContent = `${day} 的抓取结果尚未整理，可直接接着处理，无需重新访问 BOSS。`;
    const pendingItems = inboxItems().filter((i) => !i.handled);
    if (INBOX_SAVED_ROLE && pendingItems.length && !pendingItems.some((i) => i.role === INBOX_SAVED_ROLE)
        && $('#inboxFilter').value === 'pending') {
      INBOX_SAVED_ROLE = '';
      $('#inboxRole').value = '';
      try { localStorage.removeItem('inbox-role'); } catch {}
    }
    const pending = pendingItems.length;
    $('#inboxCount').textContent = pending ? String(pending) : '';
    $('#inboxEntrySummary').textContent = pending ? `${pending} 位候选人待处理，点击查看消息和下一步。` : '暂无本地待办，可拉取最新未读。';
    inboxNotice(data.warning || (day ? `最近抓取：${day}。待办只显示本次未读，过往记录仍保存在本地。` : '还没有抓取记录，点击「拉取最新未读」开始。'), !!data.warning);
    renderInbox();
  } catch (e) {
    inboxNotice('未能加载待办：' + e.message + '。请刷新重试。', true);
    $('#inboxEntrySummary').textContent = '待办加载失败，请刷新重试。';
  }
}
function renderInbox() {
  const all = inboxItems();
  const roles = [...new Set(all.map((i) => i.role || '').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh'));
  const roleSelect = $('#inboxRole');
  const selectedRole = roleSelect.value || INBOX_SAVED_ROLE;
  roleSelect.innerHTML = '<option value="">全部岗位</option>' + roles.map((role) => {
    const count = all.filter((i) => i.role === role && !i.handled).length;
    return `<option value="${esc(role)}">${esc(role)}（${count} 待处理）</option>`;
  }).join('');
  roleSelect.value = roles.includes(selectedRole) ? selectedRole : '';
  INBOX_SAVED_ROLE = roleSelect.value;
  const resumeTargets = all.filter((i) => i.role === roleSelect.value && !i.handled && !i.resume && !i.chatBlocked && !i.previewOnly);
  $('#inboxRoleResumes').disabled = !roleSelect.value || !resumeTargets.length;
  $('#inboxRoleResumes').textContent = resumeTargets.length ? `批量查看本岗简历（${resumeTargets.length}）` : '批量查看本岗简历';
  const q = $('#inboxSearch').value.trim().toLowerCase();
  const filter = $('#inboxFilter').value;
  const items = all.filter((i) => (filter === 'all' || (filter === 'done' ? i.handled : !i.handled))
    && (!roleSelect.value || i.role === roleSelect.value)
    && `${i.name} ${i.role} ${i.message}`.toLowerCase().includes(q));
  $('#inboxSummary').textContent = `待处理 ${all.filter((i) => !i.handled).length} · 已处理 ${all.filter((i) => i.handled).length} · 当前显示 ${items.length}`;
  if (!items.some((i) => i.id === INBOX_SELECTED)) INBOX_SELECTED = items[0]?.id || null;
  $('#inboxList').innerHTML = items.length ? items.map((i) => `<button class="inbox-row" data-id="${i.id}" aria-pressed="${i.id === INBOX_SELECTED}">
    <span class="inbox-row-top"><strong>${esc(i.name)}</strong><small>${i.handled ? '已处理' : `${i.unread} 条未读`}</small></span>
    <span class="role">${esc(i.role || '岗位待核实')} · ${esc(i.time)}</span>
    <span class="preview">${esc(i.message || '无消息摘要，请读取完整沟通')}</span></button>`).join('')
    : '<div class="empty">没有符合条件的待办。可切换到「全部」或拉取最新未读。</div>';
  renderInboxDetail(items.find((i) => i.id === INBOX_SELECTED));
}
function renderInboxDetail(item) {
  if (!item) { $('#inboxDetail').innerHTML = '<p>选择一位候选人查看消息。</p>'; return; }
  const c = item.candidate;
  const disabled = item.previewOnly || item.chatBlocked;
  $('#inboxDetail').innerHTML = `
    <h3>${esc(item.name)}</h3><p class="meta">${esc(item.role || '岗位待核实')} · ${esc(item.time)} · ${item.handled ? '已处理' : '待处理'}</p>
    <p class="meta">${c ? `已关联台账 #${esc(c['序号'])} · 当前状态：${esc(c['状态'])} ${esc(c['评级'])}` : '尚未入账'}${item.previewOnly ? ' · 待整理此批未读' : ''}</p>
    ${item.conflict ? `<p class="inbox-next">${esc(item.conflict)}</p>` : ''}
    <h4>最新消息摘要</h4><p class="inbox-message">${esc(item.message || '本次列表没有返回消息摘要。')}</p>
    <h4>下一步</h4><p class="inbox-next">${esc(item.next)}</p>
    <div class="inbox-actions">
      <button class="btn btn-primary" data-inbox-action="chat" ${disabled ? 'disabled' : ''}>${item.chat ? '更新完整沟通' : '读取完整沟通'}</button>
      <button class="btn btn-outline-primary" data-inbox-action="resume" ${disabled ? 'disabled' : ''}>${item.resume ? '重新查看在线简历' : '查看在线简历'}</button>
      ${c ? '<button class="btn btn-outline-primary" data-inbox-action="ledger">查看台账与筛选结果</button>' : ''}
      ${item.hasProfile ? '<button class="btn btn-outline-primary" data-inbox-action="profile">查看已有简历评估</button>' : ''}
    </div>
    ${disabled ? `<p class="meta">${esc(item.previewOnly ? '先点上方「整理这批未读并关联台账」，即可读取沟通和保存跟进。' : item.chatBlocked)}</p>` : '<p class="meta">打开会话可能使 BOSS 消息变为已读；本地待办会继续保留。</p>'}
    ${item.chat ? `<h4>完整沟通</h4><p class="meta">读取于 ${esc(new Date(item.chat.fetchedAt).toLocaleString())}</p><pre class="inbox-chat">${esc(item.chat.text)}</pre>` : ''}
    ${item.resume ? `<h4>在线简历</h4><p class="meta">原图保存于 ${esc(new Date(item.resume.fetchedAt).toLocaleString())}；文字识别可能有误，请对照原图。</p>
      <a href="/api/inbox/resume/image?id=${encodeURIComponent(item.id)}&signature=${encodeURIComponent(item.signature)}" target="_blank" rel="noopener">在新窗口查看原图</a>
      <div class="inbox-resume-viewport"><img class="inbox-resume" loading="lazy" alt="${esc(item.name)}的在线简历截图" src="/api/inbox/resume/image?id=${encodeURIComponent(item.id)}&signature=${encodeURIComponent(item.signature)}"></div>
      ${item.resume.text ? `<details><summary>查看识别出的简历文字</summary><pre class="inbox-chat">${esc(item.resume.text)}</pre></details>
        <div class="inbox-actions"><button class="btn btn-outline-primary" data-inbox-action="review">${item.resume.review ? '更新本地初筛线索' : '提取本地初筛线索'}</button></div>`
        : '<p class="meta">未能可靠提取文字，暂不生成自动评估；请查看原图。</p>'}
      ${item.resume.review ? `<h4>本地初筛线索</h4><p class="meta">${esc(new Date(item.resume.review.at).toLocaleString())} · 依据本次简历识别文字</p><div class="inbox-review">${esc(item.resume.review.text)}</div>` : ''}` : ''}
    ${c ? `<details><summary>查看已有判断与待验证信息</summary><p class="inbox-message">${esc(['硬门槛：' + (c['硬门槛'] || '未判断'), '待验证点：' + (c['待验证点'] || '未填写'), '备注：' + (c['备注'] || '无')].join('\n\n'))}</p></details>` : ''}
    <h4>记录本次跟进</h4>
    <label class="form-label" for="inboxNote">处理记录</label>
    <textarea id="inboxNote" maxlength="3000" placeholder="例如：已在 BOSS 回复，等待补充简历；已核实岗位意向，准备初筛。" ${item.previewOnly ? 'disabled' : ''}>${esc(INBOX_DRAFTS[item.id] || '')}</textarea>
    <div class="inbox-actions"><button class="btn btn-outline-primary" data-inbox-action="save" ${item.previewOnly ? 'disabled' : ''}>保存记录，继续待办</button>
      <button class="btn btn-primary" data-inbox-action="done" ${item.previewOnly ? 'disabled' : ''}>保存并标记已处理</button>
      ${item.handled ? '<button class="btn btn-outline-secondary" data-inbox-action="reopen">重新待办</button>' : ''}</div>
    <p class="meta">记录保存到本地，已关联人选也会追加到台账备注；不会发送消息或改变候选人筛选状态。</p>
    ${(item.history || []).length ? `<details><summary>历史跟进（${item.history.length}）</summary><ul class="inbox-history">${item.history.slice().reverse().map((h) => `<li>${esc(new Date(h.at).toLocaleString())} · ${h.handled ? '已处理' : '待处理'}<br>${esc(h.note || '重新加入待办')}</li>`).join('')}</ul></details>` : ''}`;
}
$('#openInbox').onclick = () => showView('inbox');
$('#inboxPull').onclick = () => askRun('pull-unread').catch((e) => inboxNotice(e.message, true));
$('#inboxFilter').onchange = renderInbox;
$('#inboxRole').onchange = () => { INBOX_SAVED_ROLE = $('#inboxRole').value; try { localStorage.setItem('inbox-role', INBOX_SAVED_ROLE); } catch {} renderInbox(); };
$('#inboxRoleResumes').onclick = () => askRun('inbox-resume-role', { role: $('#inboxRole').value }).catch((e) => inboxNotice(e.message, true));
$('#inboxSearch').oninput = renderInbox;
$('#inboxDetail').addEventListener('input', (e) => {
  if (e.target.id === 'inboxNote' && INBOX_SELECTED) {
    INBOX_DRAFTS[INBOX_SELECTED] = e.target.value; persistInboxDrafts();
  }
});
$('#inboxList').onclick = (e) => {
  const row = e.target.closest('[data-id]');
  if (row) { INBOX_SELECTED = row.dataset.id; renderInbox(); }
};
$('#inboxImport').onclick = async () => {
  const b = $('#inboxImport'); b.disabled = true;
  try {
    const r = await (await fetch('/api/inbox/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: INBOX.latest }) })).json();
    if (!r.ok) throw new Error(r.error);
    await load();
    inboxNotice(`已整理 ${r.count} 人：新增 ${r.added} 人，关联已有 ${r.linked} 人${r.unresolved ? `，${r.unresolved} 人待核实` : ''}。选择候选人继续处理。`);
  } catch (e) { inboxNotice(e.message, true); }
  finally { b.disabled = false; }
};
$('#inboxDetail').onclick = async (e) => {
  const button = e.target.closest('[data-inbox-action]');
  if (!button) return;
  const item = inboxItems().find((i) => i.id === INBOX_SELECTED);
  if (!item) return;
  const action = button.dataset.inboxAction;
  if (action === 'profile') { await openCandidate(item.name); showView('cand'); return; }
  if (action === 'ledger') {
    FILTER = { role: item.candidate['应聘岗位'], status: '', hard: '', q: item.name };
    $('#fRole').value = FILTER.role; $('#fStatus').value = ''; $('#fHard').value = ''; $('#fSearch').value = item.name;
    render(); showView('ledger'); return;
  }
  button.disabled = true;
  try {
    if (action === 'chat') { await askRun('inbox-chat', { id: item.id, signature: item.signature }); return; }
    if (action === 'resume') { await askRun('inbox-resume', { id: item.id, signature: item.signature }); return; }
    if (action === 'review') {
      inboxNotice(`正在评估 ${item.name} 的简历，请稍候。`);
      const r = await (await fetch('/api/inbox/resume/review', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, signature: item.signature }) })).json();
      if (!r.ok) throw new Error(r.error);
      await loadInbox(); inboxNotice('评估建议已保存，候选人状态未改变。'); return;
    }
    const note = action === 'reopen' ? '' : $('#inboxNote').value.trim();
    if (!note && action !== 'reopen') throw new Error('请填写本次处理记录。');
    const r = await (await fetch('/api/inbox/followup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id, signature: item.signature, note, handled: action === 'done' }) })).json();
    if (!r.ok) throw new Error(r.error);
    if (action !== 'reopen') { delete INBOX_DRAFTS[item.id]; persistInboxDrafts(); }
    await load(); inboxNotice(action === 'done' ? '已记录处理结果，可继续处理下一位。' : '跟进记录已保存，待办保留。');
  } catch (e) { inboxNotice(e.message, true); }
  finally { button.disabled = false; }
};

load();
