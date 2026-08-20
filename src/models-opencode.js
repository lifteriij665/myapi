// opencode Zen 的模型表：id → 免费/付费 + 展示名。
//
// 为什么要一张静态表：Zen 的 /v1/models 只给 id/object/created/owned_by，
// 没有价格；价格在文档页（https://opencode.ai/docs/zen/）的表格里。
// 而"免费还是付费"正是本项目的门禁依据，不能靠猜。
//
// 免费判定不能只看名字里有没有 free —— big-pickle 是免费的，名字里却没有 free
// （参考实现 opencode2api 只按名字判断，就会把它当付费）。所以这里显式列名单，
// 名字带 -free 的再兜一层底。
//
// 名单来源：文档 Pricing 表里标 Free 的那几行，2026-08-20 逐个发过真实请求验证。
export const OPENCODE_FREE = new Set([
  'big-pickle',
  'mimo-v2.5-free',
  'hy3-free',
  'nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free',
  'deepseek-v4-flash-free',
  'laguna-s-2.1-free',
  'muse-spark-1.2-contributor-free',
]);

// 上游按出口地区挡掉的模型：key 是好的，但这个模型在当前机房调不通。
// 实测 muse-spark-1.2-contributor-free 回 403 RegionError。
export const OPENCODE_REGION_LOCKED = new Set(['muse-spark-1.2-contributor-free']);

const DISPLAY = {
  'big-pickle': 'Big Pickle（匿名试验模型）',
  'mimo-v2.5-free': 'MiMo V2.5 Free',
  'hy3-free': 'Hy3 Free',
  'nemotron-3-ultra-free': 'Nemotron 3 Ultra Free',
  'nemotron-3.5-lightning-free': 'Nemotron 3.5 Lightning Free',
  'deepseek-v4-flash-free': 'DeepSeek V4 Flash Free',
  'laguna-s-2.1-free': 'Laguna S 2.1 Free',
  'muse-spark-1.2-contributor-free': 'Muse Spark 1.2 Contributor Free',
};

// 免费模型的数据留存说明。上游文档写得很清楚：免费期内的数据可能被用来训练模型，
// 这跟"我自己存聊天记录"完全是两回事，得让用户在控制台上看得见。
const RETENTION = {
  'big-pickle': '免费期内上游可能用你的数据改进模型',
  'mimo-v2.5-free': '免费期内上游可能用你的数据改进模型',
  'hy3-free': '免费期内上游可能用你的数据改进模型',
  'nemotron-3-ultra-free': 'NVIDIA 试用端点：会被记录，别发敏感内容',
  'nemotron-3.5-lightning-free': 'NVIDIA 试用端点：会被记录，别发敏感内容',
  'muse-spark-1.2-contributor-free': '以"允许用于训练"换来的免费额度',
};

/**
 * 每个模型的「原生协议」。
 *
 * Zen 是按模型钉协议的，不是按端点：实测把 chat 原生的 mimo-v2.5-free POST 到
 * /v1/messages 或 /v1/responses，一律 400 `Input required: specify "prompt" or "messages"`。
 * 端点只决定 Zen 怎么解析 body，解析完照样原样转给上游厂商。
 * 所以发请求前必须先知道这个模型的原生协议，再决定发到哪个端点、body 要不要转。
 *
 * 归属来自官方文档的 Endpoints 表（https://opencode.ai/docs/zen/），
 * 名字前缀是兜底（上游一直按厂商前缀分）。
 */
export function nativeProtocol(modelId) {
  const m = stripPrefix(modelId).toLowerCase();
  // 这个 id 名字里有 flash 但走 chat 原生（参考实现里也单独列了它）
  if (m === 'deepseek-v4-flash-free') return 'chat';
  if (m.startsWith('claude-') || m.startsWith('qwen')) return 'anthropic';
  if (m.startsWith('gemini-')) return 'google';
  if (m.startsWith('gpt-') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4') || m.startsWith('grok-') || m.startsWith('muse-')) {
    return 'responses';
  }
  return 'chat';
}

/**
 * 本网关能不能承接这个模型。
 * 只支持 chat 和 anthropic 两种原生协议 —— 这两个正好覆盖全部免费模型（除了
 * muse-spark 那个 responses 原生 + 地区受限的）和全部 Claude / Qwen。
 * OpenAI Responses 和 Google generateContent 是另外两套 body 格式，
 * 没实现就别把模型列出去，免得客户端拿到一个必然 400 的 id。
 */
export function isSupportedProtocol(modelId) {
  const p = nativeProtocol(modelId);
  return p === 'chat' || p === 'anthropic';
}

export function protocolNote(modelId) {
  const p = nativeProtocol(modelId);
  if (p === 'responses') return '上游原生协议是 OpenAI Responses（/v1/responses），本网关还没实现这套 body 格式';
  if (p === 'google') return '上游原生协议是 Google generateContent，本网关还没实现这套 body 格式';
  return '';
}

/** 本项目对外暴露 opencode 模型时统一加前缀，避免和 freebuff 的 id 撞车 */
export const OPENCODE_PREFIX = 'opencode/';

export function isOpencodeModel(modelId) {
  return String(modelId || '').startsWith(OPENCODE_PREFIX);
}

/** 'opencode/mimo-v2.5-free' → 'mimo-v2.5-free'（发给上游时要去掉前缀） */
export function stripPrefix(modelId) {
  const s = String(modelId || '');
  return s.startsWith(OPENCODE_PREFIX) ? s.slice(OPENCODE_PREFIX.length) : s;
}

export function withPrefix(bareId) {
  const s = String(bareId || '');
  return s.startsWith(OPENCODE_PREFIX) ? s : OPENCODE_PREFIX + s;
}

/** 免费？传裸 id 或带前缀的都行 */
export function isFreeOpencodeModel(modelId) {
  const bare = stripPrefix(modelId);
  if (OPENCODE_FREE.has(bare)) return true;
  // 名单之外的新模型：名字里带 free 就先当免费（上游一直用这个命名约定）
  return /(^|[-_])free([-_]|$)/i.test(bare);
}

export function opencodeDisplayName(modelId) {
  const bare = stripPrefix(modelId);
  return DISPLAY[bare] || '';
}

export function opencodeNote(modelId) {
  const bare = stripPrefix(modelId);
  const proto = protocolNote(bare);
  if (proto) return `opencode Zen：${proto}，所以暂时不对外提供`;
  if (OPENCODE_REGION_LOCKED.has(bare)) {
    return `opencode Zen 免费模型；上游按地区限制，当前机房可能回 403（${RETENTION[bare] || ''}）`;
  }
  if (isFreeOpencodeModel(bare)) {
    const extra = RETENTION[bare];
    return `opencode Zen 免费模型：不花钱，没有 key 也能用${extra ? `。注意：${extra}` : ''}`;
  }
  return 'opencode Zen 按量计费模型：会真的扣你 Zen 账户余额，需要在 key 上勾选「允许付费」';
}

/**
 * 从上游 /v1/models 的 id 列表构造目录条目。
 * 拉不到就退回静态免费名单 —— 免费模型是这个号池的主要用途，
 * 不能因为一次网络抖动就让控制台里一个 opencode 模型都不剩。
 */
export function buildOpencodeCatalog(liveIds) {
  const ids = Array.isArray(liveIds) && liveIds.length ? liveIds : [...OPENCODE_FREE];
  return ids.map((bare) => ({
    id: withPrefix(bare),
    bare,
    free: isFreeOpencodeModel(bare),
    displayName: opencodeDisplayName(bare),
    note: opencodeNote(bare),
    regionLocked: OPENCODE_REGION_LOCKED.has(bare),
    protocol: nativeProtocol(bare),
    supported: isSupportedProtocol(bare),
  }));
}

/** 没配默认模型时，opencode 号池用哪个（挑一个不受地区限制的免费模型） */
export function defaultOpencodeModel() {
  for (const id of ['mimo-v2.5-free', 'nemotron-3.5-lightning-free', 'big-pickle']) {
    if (!OPENCODE_REGION_LOCKED.has(id)) return withPrefix(id);
  }
  return withPrefix('mimo-v2.5-free');
}
