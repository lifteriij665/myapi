// 上游注册表：内置两个（freebuff / opencode）+ 用户自己加的任意多个。
//
// 「自定义上游」= 一个 base URL + 一种协议格式 + 一堆 API key。
// key 不单独存一张表，而是复用账号池（account.provider = 上游 id）——
// 这样启停、探活、状态回写、换号策略全都直接沿用，不用再写一套。
//
// 协议格式只有四种，对应 src/protocols/ 下的适配器：
//   chat      OpenAI Chat Completions   /chat/completions
//   responses OpenAI Responses API      /responses
//   anthropic Anthropic Messages        /messages
//   gemini    Gemini generateContent    /models/{model}:generateContent
// 内部一律以 chat 为中枢格式，进出各翻一次（见 src/protocols/index.js）。
import { store, providerOf } from './store.js';
import { nowIso, randomId } from './util.js';

export const FORMATS = ['chat', 'responses', 'anthropic', 'gemini'];

export const FORMAT_LABEL = {
  chat: 'OpenAI Chat Completions',
  responses: 'OpenAI Responses API',
  anthropic: 'Anthropic Messages',
  gemini: 'Gemini Native generateContent',
};

// 换号策略。用户要的五种，每个上游各配一份、互不干扰。
export const ROTATION_MODES = ['roundrobin', 'random', 'exhaust', 'onerror', 'single'];

export const ROTATION_LABEL = {
  roundrobin: '轮询',
  random: '随机',
  exhaust: '额度用完才换',
  onerror: '一出错就换',
  single: '单号（只手动切）',
};

export const ROTATION_HINT = {
  roundrobin: '每个请求依次用下一个号，均摊压力',
  random: '每个请求随机挑一个号开始',
  exhaust: '钉住一个号用到额度耗尽或凭据失效才换（最省 session 额度）',
  onerror: '只要这次请求失败就换下一个号（含上游 5xx、网络错误）',
  single: '只用你指定的那一个号，失败也不换，直接把错误抛给客户端',
};

export const BUILTIN = {
  freebuff: {
    id: 'freebuff',
    name: 'freebuff',
    builtin: true,
    format: 'chat',
    baseUrl: '',
    note: '走随包引擎 vendor/worker.js，凭据是登录拿到的 authToken',
    credentialLabel: 'authToken',
    defaultRotation: 'exhaust',
  },
  opencode: {
    id: 'opencode',
    name: 'opencode Zen',
    builtin: true,
    format: 'chat',
    baseUrl: '',
    note: '直连 opencode.ai/zen，凭据是 Zen 的 API key',
    credentialLabel: 'Zen API key',
    defaultRotation: 'exhaust',
  },
};

export function isBuiltin(id) {
  return Object.hasOwn(BUILTIN, String(id || ''));
}

function customList() {
  if (!Array.isArray(store.data.upstreams)) store.data.upstreams = [];
  return store.data.upstreams;
}

/** 所有上游（内置在前，自定义按创建顺序） */
export function listUpstreams() {
  return [...Object.values(BUILTIN), ...customList()];
}

export function getUpstream(id) {
  const key = String(id || '');
  if (isBuiltin(key)) return BUILTIN[key];
  return customList().find((u) => u.id === key) || null;
}

/** 这个上游存在且启用？内置的永远算启用（它们的开关是"有没有号"） */
export function upstreamEnabled(id) {
  const u = getUpstream(id);
  if (!u) return false;
  return u.builtin ? true : u.enabled !== false;
}

/** base URL 校验：必须是 http(s)，且不能指向内网 / 云元数据（防 SSRF） */
export function normalizeBaseUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) throw Object.assign(new Error('接口地址不能为空'), { statusCode: 400 });
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw Object.assign(new Error('接口地址不是合法 URL'), { statusCode: 400 });
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw Object.assign(new Error('只支持 http / https'), { statusCode: 400 });
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const privateHost =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === 'metadata' ||
    host.endsWith('.internal') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^(fe80:|fc|fd)/i.test(host);
  // 自定义上游是管理员自己填的，但这个服务通常跑在公网容器里 ——
  // 填一个内网地址就等于把网关变成打内网的跳板
  if (privateHost && !/^(1|true|yes|on)$/i.test(process.env.ALLOW_PRIVATE_UPSTREAM || '')) {
    throw Object.assign(
      new Error('接口地址指向内网或云元数据地址，已拒绝（确实需要的话设 ALLOW_PRIVATE_UPSTREAM=true）'),
      { statusCode: 400 }
    );
  }
  // 末尾斜杠统一去掉，拼路径时才不会出现 //
  return u.toString().replace(/\/+$/, '');
}

/**
 * 上游名会被收敛成模型 id 的前缀（`My Relay` → `my-relay/`），所以判重必须
 * 按 **slug** 而不是原名 —— 否则「My Relay」和「my-relay」能同时存在，
 * 它们的模型 id 一模一样，upstreamForModel 只会命中先建的那个，
 * 后建的那个上游的模型永远调不通，而且报错还看不出原因。
 * 这个函数必须和 models.js 的 upstreamSlug 保持一致。
 */
export function slugOf(name) {
  return (
    String(name || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'upstream'
  );
}

function assertNameFree(label, exceptId) {
  const slug = slugOf(label);
  // 前缀不能和内置上游撞：opencode/ 是 Zen 的命名空间，freebuff 的模型是 厂商/模型 形态
  if (slug === 'opencode' || slug === 'freebuff') {
    throw Object.assign(new Error(`「${label}」和内置上游的名字冲突，换一个`), { statusCode: 400 });
  }
  const clash = customList().find((u) => u.id !== exceptId && slugOf(u.name) === slug);
  if (clash) {
    throw Object.assign(
      new Error(
        clash.name === label
          ? `已经有一个叫「${label}」的上游了，换个名字`
          : `「${label}」和已有的「${clash.name}」会生成同一个模型前缀 ${slug}/，换个名字`
      ),
      { statusCode: 400 }
    );
  }
}

export function addUpstream({ name, format, baseUrl, note = '', models = [], defaultTier = 'paid' }) {
  const fmt = FORMATS.includes(format) ? format : null;
  if (!fmt) throw Object.assign(new Error('协议格式必须是 chat / responses / anthropic / gemini 之一'), { statusCode: 400 });
  const clean = normalizeBaseUrl(baseUrl);
  const label = String(name || '').trim() || new URL(clean).hostname;
  assertNameFree(label, null);
  const up = {
    id: 'up_' + randomId(4),
    name: label,
    format: fmt,
    baseUrl: clean,
    note: String(note || '').slice(0, 200),
    enabled: true,
    // 自定义上游的模型算免费还是付费：默认按付费（fail-closed，别让没勾付费的 key
    // 拿着别人的商业 key 随便刷）
    defaultTier: defaultTier === 'free' ? 'free' : 'paid',
    models: dedupeModels(models),
    modelsFetchedAt: null,
    createdAt: nowIso(),
  };
  customList().push(up);
  store.save();
  return up;
}

function dedupeModels(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const id = String(raw?.id ?? raw ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function updateUpstream(id, patch) {
  const up = getUpstream(id);
  if (!up) return null;
  if (up.builtin) throw Object.assign(new Error('内置上游不能改'), { statusCode: 400 });
  if ('name' in patch) {
    const label = String(patch.name || '').trim();
    if (label && label !== up.name) {
      assertNameFree(label, id);
      // 改名会改掉模型前缀，所以要把旧前缀的下架/分类覆盖一起迁过去，
      // 不然用户之前的手动设置会变成指向一个不存在的 id 的死数据
      renamePrefix(slugOf(up.name), slugOf(label), up.models || []);
      up.name = label;
    }
  }
  if ('baseUrl' in patch) up.baseUrl = normalizeBaseUrl(patch.baseUrl);
  if ('format' in patch && FORMATS.includes(patch.format)) up.format = patch.format;
  if ('note' in patch) up.note = String(patch.note || '').slice(0, 200);
  if ('enabled' in patch) up.enabled = Boolean(patch.enabled);
  if ('defaultTier' in patch) up.defaultTier = patch.defaultTier === 'free' ? 'free' : 'paid';
  if ('models' in patch) up.models = dedupeModels(patch.models);
  up.updatedAt = nowIso();
  store.save();
  return up;
}

/** 改名 / 删上游时，把设置里指向老模型 id 的那些条目一起搬走或清掉 */
function renamePrefix(oldSlug, newSlug, models) {
  if (oldSlug === newSlug) return;
  const s = store.data.settings;
  const map = (id) => (id.startsWith(oldSlug + '/') ? newSlug + '/' + id.slice(oldSlug.length + 1) : id);
  if (Array.isArray(s.disabledModels)) s.disabledModels = s.disabledModels.map(map);
  if (s.modelTierOverrides && typeof s.modelTierOverrides === 'object') {
    const next = {};
    for (const [id, tier] of Object.entries(s.modelTierOverrides)) next[map(id)] = tier;
    s.modelTierOverrides = next;
  }
  // 实测状态也跟着搬，不然改个名字所有模型都变回"未验证"
  if (store.data.modelStatus && typeof store.data.modelStatus === 'object') {
    const next = {};
    for (const [id, st] of Object.entries(store.data.modelStatus)) next[map(id)] = st;
    store.data.modelStatus = next;
  }
  // key 上的模型白名单也是按 id 存的
  for (const k of store.data.keys || []) {
    if (Array.isArray(k.models) && k.models.length) k.models = k.models.map(map);
  }
  void models;
}

/** 删上游：连它名下的号一起删（留着也没有上游可用） */
export function removeUpstream(id) {
  const idx = customList().findIndex((u) => u.id === id);
  if (idx < 0) return false;
  const [gone] = customList().splice(idx, 1);
  const before = store.data.accounts.length;
  store.data.accounts = store.data.accounts.filter((a) => providerOf(a) !== id);
  const removedAccounts = before - store.data.accounts.length;
  if (store.data.settings.activeAccountId && !store.data.accounts.some((a) => a.id === store.data.settings.activeAccountId)) {
    store.data.settings.activeAccountId = null;
  }
  const rules = { ...(store.data.settings.rotationRules || {}) };
  delete rules[id];
  store.data.settings.rotationRules = rules;
  // 把指向它那些模型的设置也清掉：留着就是永远匹配不上的死数据，
  // 而且以后有人重新建一个同名上游会莫名继承这些设置
  const prefix = slugOf(gone?.name) + '/';
  const s = store.data.settings;
  if (Array.isArray(s.disabledModels)) s.disabledModels = s.disabledModels.filter((m) => !m.startsWith(prefix));
  if (s.modelTierOverrides && typeof s.modelTierOverrides === 'object') {
    for (const key of Object.keys(s.modelTierOverrides)) if (key.startsWith(prefix)) delete s.modelTierOverrides[key];
  }
  if (store.data.modelStatus && typeof store.data.modelStatus === 'object') {
    for (const key of Object.keys(store.data.modelStatus)) if (key.startsWith(prefix)) delete store.data.modelStatus[key];
  }
  for (const k of store.data.keys || []) {
    if (Array.isArray(k.models) && k.models.length) k.models = k.models.filter((m) => !m.startsWith(prefix));
  }
  resetCursor(id);
  store.saveNow();
  return { removedAccounts };
}

/** 往上游的模型清单里补几个（手动添加 / 拉取回来的合并） */
export function addUpstreamModels(id, models, { replace = false } = {}) {
  const up = getUpstream(id);
  if (!up || up.builtin) return null;
  const incoming = dedupeModels(models);
  up.models = replace ? incoming : dedupeModels([...up.models, ...incoming]);
  up.modelsFetchedAt = nowIso();
  up.updatedAt = nowIso();
  store.save();
  return up;
}

export function removeUpstreamModel(id, modelId) {
  const up = getUpstream(id);
  if (!up || up.builtin) return null;
  up.models = up.models.filter((m) => m !== modelId);
  up.updatedAt = nowIso();
  store.save();
  return up;
}

// ─────────────────────────── 换号策略（每个上游一份）

/**
 * 老数据文件里只有全局的 autoSwitch 开关，这里翻译成新的 mode：
 * 关掉自动切换＝单号；开着＝原来的"钉住用到失败"，语义上就是 exhaust。
 */
function legacyMode() {
  return store.data.settings?.autoSwitch === false ? 'single' : 'exhaust';
}

export function rotationRule(providerId) {
  const rules = store.data.settings?.rotationRules || {};
  const raw = rules[providerId];
  const mode = ROTATION_MODES.includes(raw?.mode) ? raw.mode : legacyMode();
  // 这个上游有没有自己表过态？`activeAccountId: null` 是"用户明确说了放开指定"，
  // 和"从来没设过"是两件事 —— 前者不该再回落到全局值，否则清空按钮点了没反应。
  const declared = raw && Object.hasOwn(raw, 'activeAccountId');
  return {
    mode,
    // 从没设过时回落到全局的"当前账号"，这样从旧版本升上来的部署行为不变
    activeAccountId: declared ? raw.activeAccountId : store.data.settings?.activeAccountId ?? null,
  };
}

export function setRotationRule(providerId, patch) {
  const rules = { ...(store.data.settings?.rotationRules || {}) };
  const cur = rules[providerId] || {};
  const next = { ...cur };
  if ('mode' in patch) {
    if (!ROTATION_MODES.includes(patch.mode)) {
      throw Object.assign(new Error(`换号策略只能是 ${ROTATION_MODES.join(' / ')}`), { statusCode: 400 });
    }
    next.mode = patch.mode;
  }
  if ('activeAccountId' in patch) next.activeAccountId = patch.activeAccountId || null;
  rules[providerId] = next;
  store.updateSettings({ rotationRules: rules });
  return rotationRule(providerId);
}

/** 批量设置：一次把同一个策略应用到多个上游（控制台的「一键应用」） */
export function setRotationRules(providerIds, mode) {
  if (!ROTATION_MODES.includes(mode)) {
    throw Object.assign(new Error(`换号策略只能是 ${ROTATION_MODES.join(' / ')}`), { statusCode: 400 });
  }
  const ids = Array.isArray(providerIds) && providerIds.length ? providerIds : listUpstreams().map((u) => u.id);
  const rules = { ...(store.data.settings?.rotationRules || {}) };
  for (const id of ids) {
    if (!getUpstream(id)) continue;
    rules[id] = { ...(rules[id] || {}), mode };
  }
  store.updateSettings({ rotationRules: rules });
  return ids.filter((id) => Boolean(getUpstream(id)));
}

/** 轮询指针：进程内存里就够（重启从头开始不影响正确性） */
const cursors = new Map();

export function nextCursor(providerId, size) {
  if (size <= 0) return 0;
  const cur = cursors.get(providerId) || 0;
  cursors.set(providerId, (cur + 1) % size);
  return cur % size;
}

export function resetCursor(providerId) {
  cursors.delete(providerId);
}

/** 控制台展示用：每个上游 + 它的号数 + 当前策略 */
export function upstreamViews() {
  return listUpstreams().map((u) => {
    const accounts = store.data.accounts.filter((a) => providerOf(a) === u.id);
    return {
      id: u.id,
      name: u.name,
      builtin: Boolean(u.builtin),
      format: u.format,
      formatLabel: FORMAT_LABEL[u.format] || u.format,
      baseUrl: u.baseUrl || '',
      note: u.note || '',
      enabled: u.builtin ? true : u.enabled !== false,
      defaultTier: u.defaultTier || 'paid',
      credentialLabel: u.credentialLabel || 'API key',
      models: u.builtin ? [] : [...(u.models || [])],
      modelsFetchedAt: u.modelsFetchedAt || null,
      rotation: rotationRule(u.id),
      accounts: accounts.length,
      accountsEnabled: accounts.filter((a) => a.enabled !== false).length,
    };
  });
}
