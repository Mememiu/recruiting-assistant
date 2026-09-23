'use strict';
/**
 * AI 调用封装 —— 只做一件事：把话发给模型，把回答带回来
 *
 * 三条纪律（省钱的要点，也是可靠性的要点）：
 *  1. **能用代码干的活绝不调 AI** —— 筛选、统计、解析都在本地算完了再喂给它。
 *  2. **按配置选模型**：要判断的用 model，机械整理用 cheapModel。
 *  3. **AI 只给建议，不直接改数据** —— 它返回结论，写不写进台账由人决定。
 */

const fs = require('fs');
const path = require('path');

function loadCfg() {
  const root = path.join(__dirname, '..');
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  cfg.dataHome = path.resolve(root, cfg.dataHome);
  const lp = path.join(root, 'config.local.json');
  if (fs.existsSync(lp)) {
    cfg.ai = { ...(cfg.ai || {}), ...(JSON.parse(fs.readFileSync(lp, 'utf8')).ai || {}) };
  }
  if (cfg.ai && cfg.ai.apiKey) cfg.ai.enabled = true;
  return cfg;
}

function endpoint(baseUrl) {
  const b = String(baseUrl).replace(/\/+$/, '');
  return b.endsWith('/v1') ? b + '/chat/completions' : b + '/v1/chat/completions';
}

/**
 * @param {object} o
 * @param {string} o.prompt   用户指令
 * @param {string} [o.system] 系统提示
 * @param {boolean} [o.cheap] 用便宜模型（机械活）
 */
/** 每次调用的用量记一行 jsonl，供「费用统计」页汇总。写不进去没关系，不影响主流程。 */
function recordUsage(cfg, row) {
  try {
    const dir = path.join(cfg.dataHome, 'runtime');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'ai-usage.jsonl'), JSON.stringify(row) + '\n', 'utf8');
  } catch { /* 用量记录失败不能拖垮主流程 */ }
}

async function chat(o) {
  const cfg = loadCfg();
  const ai = cfg.ai || {};
  if (!ai.apiKey) return { ok: false, error: '还没配 API key（写在 config.local.json）' };
  if (!ai.baseUrl || !ai.model) return { ok: false, error: '请在 config.local.json 中配置 AI 服务地址和模型。' };

  const model = o.cheap ? (ai.cheapModel || ai.model) : ai.model;
  const ctrl = new AbortController();
  if (o.signal?.aborted) return { ok: false, cancelled: true, error: '已取消' };
  const abort = () => ctrl.abort();
  o.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), ai.timeoutMs || 120000);
  const t0 = Date.now();

  try {
    const r = await fetch(endpoint(ai.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + ai.apiKey,
      },
      body: JSON.stringify({
        model,
        temperature: ai.temperature ?? 0.2,
        ...(ai.reasoningEffort ? { reasoning_effort: ai.reasoningEffort } : {}),
        messages: [
          ...(o.system ? [{ role: 'system', content: o.system }] : []),
          { role: 'user', content: o.prompt },
        ],
        ...(o.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const d = await r.json();
    if (!r.ok || d.error) {
      return { ok: false, error: (d.error && (d.error.message || JSON.stringify(d.error))) || ('HTTP ' + r.status) };
    }
    const usage = d.usage || {};
    recordUsage(cfg, {
      ts: new Date().toISOString(),
      model,
      kind: o.kind || (o.cheap ? 'cheap' : 'judge'),
      prompt: usage.prompt_tokens || 0,
      completion: usage.completion_tokens || 0,
      total: usage.total_tokens || 0,
      ms: Date.now() - t0,
    });
    return {
      ok: true,
      content: (d.choices?.[0]?.message?.content) || '',
      usage,
      model,
      ms: Date.now() - t0,
    };
  } catch (e) {
    return { ok: false, cancelled: !!o.signal?.aborted,
      error: o.signal?.aborted ? '已取消' : e.name === 'AbortError' ? '调用超时' : String(e.message || e) };
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', abort);
  }
}

/**
 * 从 CONTEXT.md 里只挑 AI 需要的那两节（硬规则 + 在招岗位）。
 * 整份文件喂进去会多花一倍 token —— 公司背景、术语表、决策记录对判断没用。
 * 找不到对应章节就退回全文，宁可多花也别少给。
 */
function extractRules(contextMd) {
  const m = String(contextMd).match(/##\s*三、[\s\S]*?(?=\n##\s*五、)/);
  return m ? m[0].trim() : String(contextMd);
}

/** 初筛建议：给一个人的材料，要一个带依据的判断 */
async function screen({ context, person, signal }) {
  const ctx = extractRules(context);
  const system = '你是招聘初筛助手。判断要克制、要讲证据：每条结论都必须引用材料里的原话作依据。'
    + '材料里看不出来的，就写「无法判断」，不许猜。输出中文。';
  const prompt = [
    '## 岗位标准（唯一依据，不得自行发明标准）',
    ctx,
    '',
    '## 候选人材料',
    person,
    '',
    '## 你要回答的',
    '1. 硬门槛（年龄/学历/届别/在读）：通过 / 不符 / 无法判断，并写出依据原话',
    '2. 命脉技能是否命中：命中 / 未命中 / 无法判断，并写出依据原话',
    '3. 是否存在排除信号：有 / 无 / 无法判断',
    '4. 建议评级：⭐ / ⭐⭐ / ⭐⭐⭐（命脉强且硬门槛过才给三星）',
    '5. **待验证点**：材料里看不出、但会影响录用的事（如项目真实性、岗位意向）。岗位标准标明默认具备的事项，不得仅因简历未写就扣分或列为待验证点。列 1-3 条',
    '',
    '严格按这 5 条输出，每条不超过 60 字。',
  ].join('\n');
  return chat({ system, prompt, signal });
}

module.exports = { chat, screen, loadCfg };
