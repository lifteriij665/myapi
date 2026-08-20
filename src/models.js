// 模型目录 + 免费/付费分类。
//
// 分类依据（与 vendor/worker.js 同源，逆向自官方 freebuff-models.ts 的额度池）：
//   premium 池：全账号共享 6 次 session/天 —— 本项目归类为「付费(Premium)」
//   standard 池：Flash / MiMo 这类非 premium 模型 ——「免费」
//   glm 池：独立额度池，需要 referral / streak 资格 —— 归类为「免费」但打资格标记
// 上游模型表会变，所以除了随包的 vendor/freebuff-models.json，还会定时拉取上游
// GitHub Release 里的最新 freebuff-models.json（拉不到就用随包副本，不影响服务）。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './config.js';
import { store } from './store.js';
import { fetchOfficialTable } from './model-source.js';

const RELEASE_SOURCES = [
  'https://github.com/pingmike2/freebuff2api-wokers/releases/latest/download/freebuff-models.json',
  'https://cdn.jsdelivr.net/gh/pingmike2/freebuff2api-wokers@main/freebuff-models.json',
];
const REFRESH_MS = 6 * 60 * 60 * 1000;
// 与 worker.js 的 DEFAULT_MODEL 保持一致（客户端没指定模型时上游走它）。
// worker 1.8.10 起是 mimo/mimo-v2.5 —— flash 被上游挪进 premium 池之后不再适合当默认值。
export const DEFAULT_MODEL = 'mimo/mimo-v2.5';

/** 客户端传的模型名看起来是不是 Claude 系（Anthropic 客户端会发 claude-xxx，需要别名兜底） */
export function looksLikeClaude(raw) {
  return /claude|sonnet|opus|haiku|anthropic|fable|mythos/i.test(String(raw || ''));
}

const bundled = JSON.parse(readFileSync(resolve(ROOT, 'vendor/freebuff-models.json'), 'utf8'));
// 随包表里的 premium 名单是"地板"：远端刷新只能往上加，不能把它们放宽成免费
const bundledPremium = new Set(bundled?.pools?.premium || []);

let table = normalize(bundled, 'bundled');
let lastRefresh = 0;
let refreshing = null;

function normalize(raw, source) {
  const pools = raw?.pools || {};
  const premium = new Set(pools.premium || []);
  const glm = new Set(pools.glm || []);
  const standard = new Set(pools.standard || []);
  const models = new Map();
  for (const m of raw?.models || []) {
    if (!m?.id) continue;
    models.set(m.id, {
      id: m.id,
      agent: m.agent || '',
      session: m.session || m.id,
      displayName: m.displayName || '',
      availability: m.availability || '',
      closedWindowUtc: m.closedWindowUtc || '',
      multimodal: Boolean(m.multimodal),
    });
  }
  // 池里出现但 models 里没有的 id 也补进来，保证分类查得到
  for (const id of [...premium, ...glm, ...standard]) {
    if (!models.has(id)) models.set(id, { id, agent: '', session: id });
  }
  // 远端表只允许把分类"收紧"：随包表里标成 premium 的，远端说是免费也不放宽。
  // 分类数据是从第三方可变 URL（latest / @main）拉的，没有签名；
  // 一旦那份文件被改，把 premium 说成 standard 就等于让没勾选付费的 key 去烧 Premium 额度。
  if (source !== 'bundled') {
    for (const id of bundledPremium) {
      if (!premium.has(id)) {
        premium.add(id);
        standard.delete(id);
        glm.delete(id);
        if (!models.has(id)) models.set(id, { id, agent: '', session: id });
      }
    }
  }
  return {
    premium,
    glm,
    standard,
    models,
    source,
    generatedAt: raw?.generatedAt || null,
    limits: { premium: 4, standard: 6, deepseek: 0, ...(raw?.limits || {}) },
    limitedOffer: new Set(raw?.limitedOffer || []),
    deepseekFamily: new Set(raw?.deepseekFamily || []),
  };
}

/** 后台刷新模型表；失败静默保留旧表 */
export async function refreshCatalog(force = false) {
  if (!force && Date.now() - lastRefresh < REFRESH_MS) return table;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    // 先试官方常量源码：它是第三方那份 JSON 的上游，没有"等人生成"的延迟
    try {
      const official = await fetchOfficialTable();
      if (official) {
        table = normalize(official, 'official');
        lastRefresh = Date.now();
        return table;
      }
    } catch (err) {
      console.warn(`[models] 官方常量源解析失败，回落到 release JSON：${err.message}`);
    }
    for (const url of RELEASE_SOURCES) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10000);
        const resp = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
        clearTimeout(timer);
        if (!resp.ok) continue;
        const raw = await resp.json();
        if (!raw?.models?.length) continue;
        table = normalize(raw, url.includes('jsdelivr') ? 'jsdelivr' : 'github-release');
        lastRefresh = Date.now();
        return table;
      } catch {
        /* 换下一个源 */
      }
    }
    lastRefresh = Date.now(); // 全失败也别每次请求都重试
    return table;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** 'paid' | 'free'（付费=premium 共享额度池；免费=standard / glm / 其它） */
export function tierOf(modelId) {
  const override = store.settings?.modelTierOverrides?.[modelId];
  if (override === 'free' || override === 'paid') return override;
  if (table.premium.has(modelId)) return 'paid';
  if (table.standard.has(modelId) || table.glm.has(modelId)) return 'free';
  // 未分类模型：保守当付费处理，免得没勾「允许付费」的 key 把 premium 额度烧掉。
  // 控制台「模型」里可以手动改成免费。
  return 'paid';
}

export function isKnownModel(modelId) {
  return table.models.has(modelId);
}

/**
 * 上游对 DeepSeek 家族（Flash + Pro）另外压了一道天花板：
 * 两个 id **共用**每天 1 次 session，而且这一次还照样扣 premium 池的额度
 * （官方常量 FREEBUFF_DEEPSEEK_SESSION_LIMIT = 1，注释写明"合用一份配额，
 * 免得来回换 id 就白拿两次"）。所以它比普通 premium 模型更紧张。
 */
export function isDeepSeekFamily(modelId) {
  if (table.deepseekFamily?.size) return table.deepseekFamily.has(modelId);
  return /^deepseek\//i.test(String(modelId || ''));
}

export function isLimitedOffer(modelId) {
  return Boolean(table.limitedOffer?.has(modelId));
}

export function noteOf(modelId) {
  const lim = table.limits || {};
  if (isDeepSeekFamily(modelId) && table.premium.has(modelId)) {
    return `DeepSeek 家族：Flash 和 Pro 共用每天 ${lim.deepseek || 1} 次 session，而且这一次还照样扣 Premium 额度 —— 全池里最紧的`;
  }
  const det = table.models.get(modelId);
  if (det?.availability === 'off_peak_only') {
    return `上游按时段关闭：UTC ${det.closedWindowUtc || '00:00-10:00'} 这段时间不可用（高峰期上游成本翻倍），其余时间照常`;
  }
  if (det?.availability === 'deployment_hours') return '上游只在部署时段开放';
  if (isLimitedOffer(modelId)) return '限量试用：上游放多少算多少，池子空了这个模型就整个消失';
  if (table.glm.has(modelId)) return '独立额度池，需 referral / streak 资格';
  if (!table.models.has(modelId)) return '未在上游模型表中，分类默认按付费处理';
  if (table.premium.has(modelId)) return `Premium 池：全账号共享 ${lim.premium || 4} 次 session/天`;
  return '非 Premium：这一档目前不限量（上游随时会调）';
}

/**
 * 上游模型表只说"官方有这个模型"，不代表你这些号现在真能用它。
 * 所以再叠一层实测状态，来源有三个（可信度从高到低）：
 *   1. 真实请求成功 / 因模型本身失败（unsupported_model、session_model_mismatch…）
 *   2. 0 消耗探活拿到的 rateLimitsByModel 快照（上游确实给这个号计量这个模型）
 *   3. 什么都没有 —— 只在表里，未验证
 * 只有模型自身的失败才会标不可用；429、token 失效这类是账号问题，不算模型的错。
 */
const MODEL_FAIL_RE = /unsupported_model|model not available|model_not_found|session_model_mismatch|no such model|not supported|invalid model|use the paid|paid slug/i;

/** 这次失败是"模型不行"还是"账号不行"？只有前者才该记到模型头上 */
export function isModelSpecificFailure(status, text) {
  const t = String(text || '');
  if (status === 429 || status === 401 || status === 403) return false;
  return MODEL_FAIL_RE.test(t);
}

/** 真实请求的结果回写到模型状态；连续 2 次模型级失败才判不可用 */
export function recordModelResult(modelId, { ok, status, text } = {}) {
  if (!modelId) return;
  if (ok) {
    const cur = store.modelStatus[modelId];
    if (!cur || cur.state !== 'ok' || cur.fails) {
      store.setModelStatus(modelId, { state: 'ok', detail: '实测调用成功', fails: 0, source: 'request' });
    }
    return;
  }
  if (!isModelSpecificFailure(status, text)) return;
  const cur = store.modelStatus[modelId] || { fails: 0 };
  const fails = (cur.fails || 0) + 1;
  store.setModelStatus(modelId, {
    state: fails >= 2 ? 'unavailable' : cur.state === 'ok' ? 'ok' : 'suspect',
    detail: `上游按模型本身拒绝（HTTP ${status}）：${String(text).slice(0, 160)}`,
    fails,
    source: 'request',
  });
}

/** 从 0 消耗探活的额度快照里学：出现在 rateLimitsByModel 里的模型 = 上游确实给这个号计量它 */
export function learnFromQuotaSnapshot(rateLimits, limitedOffers) {
  if (rateLimits && typeof rateLimits === 'object') {
    for (const [key, info] of Object.entries(rateLimits)) {
      if (!table.models.has(key)) continue; // 池名（premium/standard）不是模型，跳过
      const cur = store.modelStatus[key];
      if (cur?.state === 'ok' && !cur.fails) continue;
      const used = info?.recentCount;
      const limit = info?.limit;
      store.setModelStatus(key, {
        state: 'metered',
        detail: `上游额度快照里有它${used != null && limit != null ? `（已用 ${used}/${limit}）` : ''}`,
        fails: 0,
        source: 'probe',
      });
    }
  }
  for (const offer of Array.isArray(limitedOffers) ? limitedOffers : []) {
    const id = typeof offer === 'string' ? offer : offer?.modelId || offer?.model;
    if (id && table.models.has(id)) {
      store.setModelStatus(id, { state: 'metered', detail: '上游当前正在放这个限量试用', fails: 0, source: 'probe' });
    }
  }
}

/**
 * 引擎（vendor/worker.js）自己也有一份"上游已暂停"名单，1.8.10 起它会把那些模型
 * 从 /v1/models 里滤掉、请求时直接回 unsupported_model。
 * 这里不重复维护那份名单 —— 直接对比"我的表里有、引擎列表里没有"，
 * 这样以后 npm run update-worker 换了名单也自动跟上。
 */
const enginePaused = new Set();

export function noteEngineModelList(liveIds) {
  // 引擎拉不到动态表时只剩一个硬编码兜底模型，那种列表不能用来判断"被暂停"
  if (!Array.isArray(liveIds) || liveIds.length < 3) return enginePaused;
  const live = new Set(liveIds);
  enginePaused.clear();
  for (const id of table.models.keys()) if (!live.has(id)) enginePaused.add(id);
  return enginePaused;
}

export function isEnginePaused(modelId) {
  return enginePaused.has(modelId);
}

export function availabilityOf(modelId) {
  if (enginePaused.has(modelId)) {
    return {
      state: 'paused',
      detail: '引擎按上游"已暂停"名单屏蔽了它：不会出现在 /v1/models，请求会直接被拒（vendor/worker.js 的 PAUSED_MODELS）',
      at: null,
    };
  }
  const st = store.modelStatus?.[modelId];
  if (!st) return { state: 'unverified', detail: '只在上游模型表里出现过，还没实测', at: null };
  return { state: st.state || 'unverified', detail: st.detail || '', at: st.at || null, fails: st.fails || 0 };
}

/** 控制台用的完整目录（可传入 worker /v1/models 返回的 id 列表做合并） */
export function catalog(extraIds = []) {
  const ids = new Set([...table.models.keys(), ...extraIds]);
  const disabled = new Set(store.settings?.disabledModels || []);
  return [...ids]
    .map((id) => ({
      id,
      tier: tierOf(id),
      pool: table.premium.has(id) ? 'premium' : table.glm.has(id) ? 'glm' : table.standard.has(id) ? 'standard' : 'unknown',
      note: noteOf(id),
      agent: table.models.get(id)?.agent || '',
      enabled: !disabled.has(id),
      overridden: Boolean(store.settings?.modelTierOverrides?.[id]),
      availability: availabilityOf(id),
      limitedOffer: isLimitedOffer(id),
      deepseekFamily: isDeepSeekFamily(id),
      displayName: table.models.get(id)?.displayName || '',
      upstreamAvailability: table.models.get(id)?.availability || '',
      closedWindowUtc: table.models.get(id)?.closedWindowUtc || '',
    }))
    .sort((a, b) => (a.tier === b.tier ? a.id.localeCompare(b.id) : a.tier === 'free' ? -1 : 1));
}

export function catalogMeta() {
  return {
    source: table.source,
    generatedAt: table.generatedAt,
    lastRefresh,
    count: table.models.size,
    limits: table.limits || null,
  };
}

/**
 * 客户端没写 model 时用哪个。默认挑当前 standard 池里的第一个（也就是"不限量"那一档），
 * 而不是死写 flash —— 上游 2026-08-18 把 flash 挪进 premium 池之后，
 * 死写 flash 会让每个不带 model 的请求都去啃每天 1 次的 DeepSeek 额度。
 */
export function defaultModel() {
  const configured = store.settings?.defaultModel;
  if (configured && table.models.has(configured)) return configured;
  const disabled = new Set(store.settings?.disabledModels || []);
  const free = [...table.standard]
    .filter(
      (id) =>
        !disabled.has(id) &&
        tierOf(id) === 'free' &&
        !isLimitedOffer(id) && // 限量试用随时会整个消失，不能当默认
        !enginePaused.has(id) &&
        availabilityOf(id).state !== 'unavailable'
    )
    .sort();
  return free[0] || DEFAULT_MODEL;
}

/** 某个 API key 能不能用这个模型 */
export function checkModelAccess(keyRecord, modelId) {
  if (modelId && enginePaused.has(modelId)) {
    return {
      ok: false,
      status: 404,
      message: `模型 ${modelId} 已被上游暂停提供（引擎 vendor/worker.js 的 PAUSED_MODELS 里有它），换一个模型；GET /v1/models 是当前真正能用的列表`,
    };
  }
  const disabled = new Set(store.settings?.disabledModels || []);
  if (modelId && disabled.has(modelId)) {
    return { ok: false, status: 403, message: `模型 ${modelId} 已在控制台被下架` };
  }
  if (keyRecord?.models?.length && modelId && !keyRecord.models.includes(modelId)) {
    return { ok: false, status: 403, message: `当前 API key 未授权模型 ${modelId}` };
  }
  if (modelId && tierOf(modelId) === 'paid' && !keyRecord?.allowPaid) {
    const unknown = !isKnownModel(modelId);
    return {
      ok: false,
      status: 403,
      message: unknown
        ? `模型 ${modelId} 不在已知的免费模型池里，默认按付费(Premium)处理；当前 API key 没有勾选「允许付费模型」。如果确认它是免费模型，可在控制台「模型」里把它改成免费。`
        : `模型 ${modelId} 属于付费(Premium)额度池（全账号共享 6 次 session/天）；当前 API key 没有勾选「允许付费模型」，请在控制台勾上或换用免费模型。`,
    };
  }
  return { ok: true };
}

/**
 * 把客户端传来的模型名解析成上游模型 id（用于分类和选号）。
 * 逻辑对齐 worker.js：精确命中优先，其次去掉 anthropic/ 前缀做后缀匹配，
 * Anthropic 协议下匹配不到时按 worker 的 DEFAULT_MODEL 处理。
 */
export function resolveModelId(raw, isAnthropic = false) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (table.models.has(value)) return value;
  const short = value.replace(/^anthropic\//i, '').toLowerCase();
  for (const id of table.models.keys()) {
    if (id.toLowerCase().endsWith('/' + short)) return id;
  }
  return isAnthropic ? DEFAULT_MODEL : value;
}

/** 过滤 /v1/models 返回值：按 key 的权限 + 下架列表 + 实测不可用 */
export function filterModelList(keyRecord, list) {
  const disabled = new Set(store.settings?.disabledModels || []);
  const allow = keyRecord?.models?.length ? new Set(keyRecord.models) : null;
  const hideDead = store.settings?.hideUnavailableModels !== false;
  return list.filter((m) => {
    const id = m?.id;
    if (!id || disabled.has(id)) return false;
    if (allow && !allow.has(id)) return false;
    if (!keyRecord?.allowPaid && tierOf(id) === 'paid') return false;
    // 实测过、确认上游按模型本身拒绝的，默认不再对外提供 ——
    // 客户端拿到一份"里面有一半调不通"的模型列表毫无用处
    if (enginePaused.has(id)) return false;
    if (hideDead && availabilityOf(id).state === 'unavailable') return false;
    return true;
  });
}
