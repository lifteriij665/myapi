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

const RELEASE_SOURCES = [
  'https://github.com/pingmike2/freebuff2api-wokers/releases/latest/download/freebuff-models.json',
  'https://cdn.jsdelivr.net/gh/pingmike2/freebuff2api-wokers@main/freebuff-models.json',
];
const REFRESH_MS = 6 * 60 * 60 * 1000;
// 与 worker.js 的 DEFAULT_MODEL 保持一致（客户端没指定模型时上游走它）
export const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';

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
    models.set(m.id, { id: m.id, agent: m.agent || '', session: m.session || m.id });
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
  return { premium, glm, standard, models, source, generatedAt: raw?.generatedAt || null };
}

/** 后台刷新模型表；失败静默保留旧表 */
export async function refreshCatalog(force = false) {
  if (!force && Date.now() - lastRefresh < REFRESH_MS) return table;
  if (refreshing) return refreshing;
  refreshing = (async () => {
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

export function noteOf(modelId) {
  if (table.glm.has(modelId)) return '独立额度池，需 referral / streak 资格';
  if (!table.models.has(modelId)) return '未在上游模型表中，分类默认按付费处理';
  if (table.premium.has(modelId)) return 'Premium 池：全账号共享 6 次 session/天';
  return '非 Premium 模型（Flash / MiMo 一类）';
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
    }))
    .sort((a, b) => (a.tier === b.tier ? a.id.localeCompare(b.id) : a.tier === 'free' ? -1 : 1));
}

export function catalogMeta() {
  return { source: table.source, generatedAt: table.generatedAt, lastRefresh, count: table.models.size };
}

/** 某个 API key 能不能用这个模型 */
export function checkModelAccess(keyRecord, modelId) {
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

/** 过滤 /v1/models 返回值：按 key 的权限 + 下架列表 */
export function filterModelList(keyRecord, list) {
  const disabled = new Set(store.settings?.disabledModels || []);
  const allow = keyRecord?.models?.length ? new Set(keyRecord.models) : null;
  return list.filter((m) => {
    const id = m?.id;
    if (!id || disabled.has(id)) return false;
    if (allow && !allow.has(id)) return false;
    if (!keyRecord?.allowPaid && tierOf(id) === 'paid') return false;
    return true;
  });
}
