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
  const lp = path.join(root, 'config.local.json');
  const local = fs.existsSync(lp) ? JSON.parse(fs.readFileSync(lp, 'utf8')) : {};
  cfg.ai = { ...(cfg.ai || {}), ...(local.ai || {}) };
  // dataHome 允许本地覆盖：仓库默认指向仓库上一级，但每个人的招聘工作区位置不同
  // （本机在 <仓库父目录>/recruiting）。写在 config.local.json 里，不入库。
  cfg.dataHome = path.resolve(root, local.dataHome || cfg.dataHome);
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
          {
            role: 'user',
            // 传了图片就发多模态消息（视觉模型直接看简历截图），否则走纯文本
            content: o.imageBase64
              ? [
                { type: 'text', text: o.prompt },
                {
                  type: 'image_url',
                  image_url: { url: 'data:' + (o.imageMime || 'image/jpeg') + ';base64,' + o.imageBase64 },
                },
              ]
              : o.prompt,
          },
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
function extractRules(contextMd, notesMd) {
  const m = String(contextMd).match(/##\s*三、[\s\S]*?(?=\n##\s*五、)/);
  const rules = m ? m[0].trim() : String(contextMd);
  // 命脉技能写在对内笔记（01-jd/_internal/<role>.md）里，是初筛的一票否决依据。
  // 必须一起喂给模型——否则"命脉是否命中"只能答「无法判断」。
  const vital = String(notesMd || '').match(/##\s*命脉技能[\s\S]*?(?=\n##\s)/);
  return vital ? rules + '\n\n' + vital[0].trim() : rules;
}

/** 初筛建议：给一个人的材料，要一个带依据的判断 */
async function screen({ context, notes, person, signal }) {
  const ctx = extractRules(context, notes);
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

/**
 * 多模态复核：把简历截图直接交给视觉模型，专抓 OCR 引文看不出的语义假信号
 * （"参与"型、方向漂移、短任期贴金）。
 * 只作**抽样复核**，不替代 OCR 主流程——文本可缓存、可审计、可被日报引用，
 * 图片每次都要重传且没有文字可引用。imagePath 建议用压缩后的 JPEG（宽 640 左右）。
 */
async function vision({ system, prompt, imagePath, signal }) {
  const cfg = loadCfg();
  const ai = cfg.ai || {};
  if (!ai.apiKey) return { ok: false, error: '还没配 API key（写在 config.local.json）' };
  if (!imagePath || !fs.existsSync(imagePath)) return { ok: false, error: '截图不存在: ' + imagePath };
  const ext = /\.png$/i.test(imagePath) ? 'png' : 'jpeg';
  const b64 = fs.readFileSync(imagePath).toString('base64');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ai.timeoutMs || 180000);
  const t0 = Date.now();
  try {
    const r = await fetch(endpoint(ai.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ai.apiKey },
      body: JSON.stringify({
        model: ai.model,
        temperature: ai.temperature ?? 0.2,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:image/${ext};base64,${b64}` } },
            ],
          },
        ],
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const d = await r.json();
    if (!r.ok || d.error) {
      return { ok: false, error: (d.error && (d.error.message || JSON.stringify(d.error))) || ('HTTP ' + r.status) };
    }
    return {
      ok: true,
      content: (d.choices?.[0]?.message?.content) || '',
      usage: d.usage || {},
      model: ai.model,
      ms: Date.now() - t0,
    };
  } catch (e) {
    return {
      ok: false,
      cancelled: !!signal?.aborted,
      error: signal?.aborted ? '已取消' : e.name === 'AbortError' ? '调用超时' : String(e.message || e),
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { chat, screen, vision, loadCfg };
