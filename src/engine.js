// 引擎适配层：把 Node 请求转成 vendor/worker.js 的 fetch(request, env) 调用。
//
// 账号选择在这一层做，不交给 worker：
//   worker 内部的 pickToken 是轮询（每次调用都推进 accountIdx），一个请求里会挨个
//   试完整个池子。用户要的是"钉住一个号，用到失败才换下一个"，所以这里每次只把
//   一个 token 放进 env —— worker 的池子里只有一个号，自然没法轮询 —— 失败了由
//   这一层决定要不要换号重试。手动模式下连重试都不做。
import worker from '../vendor/worker.js';
import { config } from './config.js';
import { store, providerOf } from './store.js';
import {
  checkModelAccess,
  filterModelList,
  resolveModelId,
  tierOf,
  isKnownModel,
  looksLikeClaude,
  recordModelResult,
  defaultModel,
  providerForModel,
  opencodeModelList,
  upstreamForModel,
  stripUpstreamPrefix,
  customModelList,
  DEFAULT_MODEL,
} from './models.js';
import { callOpencode, classifyOpencodeFailure, ANON_KEY } from './opencode.js';
import { isOpencodeModel, stripPrefix, withPrefix, nativeProtocol } from './models-opencode.js';
import { adapterFor, callUpstreamApi, classifyUpstreamFailure } from './protocols/index.js';
import { rotationRule, nextCursor, setRotationRule } from './upstreams.js';
import {
  anthropicToChat,
  chatToAnthropic,
  createChatToAnthropicStream,
  chatToAnthropicRequest,
  anthropicToChatResponse,
  createAnthropicToChatStream,
  countTokensReply,
} from './anthropic-bridge.js';
import { usage, usageFromJson, createUsageSniffer } from './usage.js';
import { appendChat } from './chatlog.js';
import { readBody, randomId, createRateLimiter, createGate, clientIp } from './util.js';

// 同时在处理的 /v1 请求数上限：每个请求都可能带几 MB body + 一条上游流
const apiGate = createGate(config.maxInflightApi);
// key 认证失败的按 IP 限流：不然可以无限次拿 key 去撞
const keyFailLimiter = createRateLimiter({ windowMs: 5 * 60 * 1000, max: 30 });
// 只往外透传这些响应头，其余（包括上游可能带的 set-cookie / access-control-*）一律丢掉
const PASS_HEADERS = new Set([
  'content-type',
  'cache-control',
  'retry-after',
  'x-freebuff2api-version',
  'openai-organization',
  'openai-processing-ms',
  'openai-version',
  'anthropic-version',
  'anthropic-organization-id',
]);

const ANTHROPIC_PATHS = new Set(['/v1/messages', '/messages', '/v1/messages/count_tokens', '/messages/count_tokens']);
const COUNT_TOKENS_PATHS = new Set(['/v1/messages/count_tokens', '/messages/count_tokens']);
const MODEL_LIST_PATHS = new Set(['/v1/models', '/models']);
const CHAT_PATHS = new Set(['/v1/chat/completions', '/chat/completions']);
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization, x-api-key, x-freebuff-instance-id, anthropic-version, anthropic-beta',
};
// 这些状态码是"客户端自己请求写错了"，换号也没用
const CLIENT_ERRORS = new Set([400, 404, 413, 422]);

export function extractPresentedKey(req) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  if (req.headers['x-api-key']) return String(req.headers['x-api-key']).trim();
  if (req.headers['api-key']) return String(req.headers['api-key']).trim();
  return '';
}

function rank(account, tier) {
  // 付费模型：优先「付费专用」号；免费模型：优先「仅免费」号，尽量不动付费号
  if (tier === 'paid') return account.pool === 'paid' ? 0 : 1;
  if (account.pool === 'free') return 0;
  if (account.pool === 'any') return 1;
  return 2;
}

/** 能用于该模型的账号（已排好优先级，不含"当前钉住哪个"的逻辑） */
export function eligibleAccounts(modelId) {
  const tier = modelId ? tierOf(modelId) : 'free';
  // 上游必须对得上：opencode 的 key 塞进 freebuff 的 worker 里毫无意义，
  // 反过来也一样。这一步要在"全失效就放行"之前做，否则 fail-open 会把
  // 另一个上游的号捞回来，拿着错的凭据去撞。
  const want = modelId ? providerForModel(modelId) : 'freebuff';
  const mine = store.accounts.filter((a) => providerOf(a) === want);
  const enabled = mine.filter((a) => a.enabled && a.token && a.token.length > 8);
  const dead = new Set(['token_invalid', 'banned']);
  const healthy = enabled.filter((a) => !dead.has(a.status?.state));
  const base = healthy.length ? healthy : enabled; // 全被标记失效时仍然放行，让上游自己说话
  const usable = tier === 'paid' ? base.filter((a) => a.pool === 'any' || a.pool === 'paid') : base;
  return [...usable].sort((a, b) => rank(a, tier) - rank(b, tier));
}

/**
 * 决定这次请求按什么顺序用号。**每个上游一套策略，互不干扰**
 * （设置在 settings.rotationRules[providerId]，见 src/upstreams.js）。
 *
 *   exhaust     钉住当前号，只有失败才顺延 —— 最省 session 额度，内置上游的默认值
 *   onerror     和 exhaust 用同一个顺序，区别在 engine 那边：连"换号也没用"的
 *               错误也照样换（worthNextAccount 会放宽）
 *   roundrobin  每个请求从下一个号开始（指针在内存里）
 *   random      每个请求随机挑一个起点
 *   single      只用指定的那一个号，失败也不换
 *
 * 返回的 order 是"这次可以依次尝试的号"，第一个是起点。single 模式下只有一个。
 */
export function selectOrder(modelId) {
  const eligible = eligibleAccounts(modelId);
  const provider = modelId ? providerForModel(modelId) : 'freebuff';
  const rule = rotationRule(provider);
  const mode = rule.mode;
  const manual = mode === 'single';

  if (manual) {
    // 没显式指定就退到全局的"当前账号"，都没有时用第一个可用的 ——
    // 否则刚建好一个单号上游会直接 503，用户还得先去点一下"设为当前"
    const pinned = eligible.find((a) => a.id === rule.activeAccountId) || eligible[0] || null;
    return { order: pinned ? [pinned] : [], manual, mode, provider, eligible };
  }

  if (!eligible.length) return { order: [], manual, mode, provider, eligible };

  const rotate = (idx) => [...eligible.slice(idx), ...eligible.slice(0, idx)];

  if (mode === 'roundrobin') {
    return { order: rotate(nextCursor(provider, eligible.length)), manual, mode, provider, eligible };
  }
  if (mode === 'random') {
    return { order: rotate(Math.floor(Math.random() * eligible.length)), manual, mode, provider, eligible };
  }

  // exhaust / onerror：从钉住的号开始
  const tier = modelId ? tierOf(modelId) : 'free';
  const activeId = rule.activeAccountId;
  const idx = eligible.findIndex((a) => a.id === activeId);
  // 钉住的号只在"和最优先那一档同级"时才当起点：否则一次付费请求把指针挪到
  // 付费专用号上之后，后面的免费流量会一直去啃那个号
  const sticky = idx >= 0 && rank(eligible[idx], tier) === rank(eligible[0], tier);
  return { order: sticky ? rotate(idx) : eligible, manual, mode, provider, eligible };
}

/**
 * 记住这个上游"现在用哪个号"。每个上游各记一份（rotationRules[provider]），
 * 同时也更新全局的 activeAccountId 让老的控制台字段继续有意义。
 *
 * 只在真的换了号时才写：这个函数在**每次成功请求**后都会被调用，
 * 而 setRotationRule → updateSettings 会把整个 rotationRules 对象重建一遍再触发落盘。
 * 钉住同一个号跑一万次请求，本来会重建一万次。
 */
function setActiveForProvider(provider, accountId) {
  if (rotationRule(provider).activeAccountId === accountId) return;
  try {
    setRotationRule(provider, { activeAccountId: accountId });
  } catch {
    /* 策略写入失败不能影响这次响应 */
  }
  store.setActiveAccount(accountId);
}

function buildEnv(tokens, presentedKey) {
  return {
    FREEBUFF_TOKEN: tokens.join('\n'),
    // worker 内部要求请求头里的 key 等于 env 里的 key；这里直接把校验通过的 key 传进去，
    // 多 key 管理由本层负责
    FREEBUFF_API_KEY: presentedKey || 'internal-key',
    FREEBUFF_DEBUG: config.workerDebug ? 'true' : 'false',
  };
}

function errorBody(pathname, message, status, type) {
  if (ANTHROPIC_PATHS.has(pathname)) {
    const t =
      type ||
      (status === 401
        ? 'authentication_error'
        : status === 403
          ? 'permission_error'
          : status === 404
            ? 'not_found_error'
            : status === 429
              ? 'rate_limit_error'
              : status >= 500
                ? 'api_error'
                : 'invalid_request_error');
    return { type: 'error', error: { type: t, message } };
  }
  const t =
    type ||
    (status === 401
      ? 'auth_error'
      : status === 403
        ? 'permission_error'
        : status === 404
          ? 'not_found_error'
          : status === 429
            ? 'rate_limit_error'
            : status === 503
              ? 'service_unavailable'
              : status >= 500
                ? 'api_error'
                : 'invalid_request_error');
  return { error: { message, type: t } };
}

function send(res, status, obj, extra = {}) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    ...CORS,
    ...extra,
  });
  res.end(body);
}

/** 上游/账号级失败的归类，用来回写账号状态 */
function classifyFailure(status, text) {
  const t = String(text || '');
  // token_invalid / banned 会把号从池子里剔掉，所以只在上游明确用 401/403 拒绝时才下这个结论。
  // 否则模型正文或者别的报错里出现一句 "unauthorized" 就会把好号误杀。
  if (status === 401 || status === 403) {
    if (/banned/i.test(t)) return 'banned';
    if (/country_blocked/i.test(t)) return 'country_blocked';
    if (/(create session failed:\s*401|invalid api key|token_invalid|unauthorized)/i.test(t)) return 'token_invalid';
    return 'blocked';
  }
  if (status === 429 || /\b429\b|quota|rate.?limit|额度/i.test(t)) return 'rate_limited';
  if (/create session failed:\s*401/i.test(t)) return 'token_invalid';
  return 'upstream_error';
}

const FAILURE_TEXT = {
  banned: '已封禁',
  token_invalid: 'token 失效',
  country_blocked: '地区受限',
  rate_limited: '额度用完',
  no_credit: '余额不足',
  blocked: '上游拒绝',
  upstream_error: '上游失败',
};

/**
 * 这次失败值不值得换个号再试。
 *
 * 默认（exhaust / roundrobin / random）只在"换号可能有用"时换：额度、凭据、
 * 上游 5xx。400/404 这类是请求本身写错了，换一百个号也一样。
 * onerror 模式是用户明确要求"一出错就换"，所以放宽到所有失败 —— 但仍然排除
 * CLIENT_ERRORS，那些换号纯属白烧额度。
 */
function worthNextAccount(status, mode) {
  if (CLIENT_ERRORS.has(status)) return false;
  if (mode === 'onerror') return true;
  return status === 429 || status === 401 || status === 403 || status === 402 || (status >= 500 && status <= 599);
}

// ───────────────────────────── Anthropic 协议补齐 ─────────────────────────────
// 上游/worker 返回的 message id 是裸 UUID，Anthropic 规范里是 msg_ 前缀；严格一点的
// SDK 和检测工具会认为 schema 不合规。usage 也补上 cache_* 字段（值恒为 0：上游
// 没有 prompt caching），避免客户端读到 undefined。

export function ensureMessageId(id) {
  const raw = String(id || '').trim();
  if (raw.startsWith('msg_')) return raw;
  return 'msg_' + (raw ? raw.replace(/-/g, '') : randomId(12));
}

export function normalizeAnthropicUsage(usage) {
  const u = usage && typeof usage === 'object' ? { ...usage } : {};
  if (typeof u.input_tokens !== 'number') u.input_tokens = 0;
  if (typeof u.output_tokens !== 'number') u.output_tokens = 0;
  if (u.cache_creation_input_tokens === undefined) u.cache_creation_input_tokens = 0;
  if (u.cache_read_input_tokens === undefined) u.cache_read_input_tokens = 0;
  return u;
}

export function patchAnthropicMessage(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (obj.type === 'message') {
    obj.id = ensureMessageId(obj.id);
    obj.usage = normalizeAnthropicUsage(obj.usage);
  }
  return obj;
}

/**
 * SSE 流补丁器：按空行切完整事件，只改写 message_start 里的 message.id / usage，
 * 其它字节原样透传。解析失败一律回退到原文，坏不了流。
 */
export function createAnthropicStreamPatcher() {
  let buf = '';
  let done = false;
  const patchEvent = (chunk) => {
    if (done || !chunk.includes('"message_start"')) return chunk;
    // 逐行替换：(.*) 不跨行，事件之间的空行原样留着 —— 吃掉 \n\n 会让所有 SSE 客户端解析不出事件
    return chunk.replace(/^data: (.*)$/gm, (whole, json) => {
      if (done) return whole;
      try {
        const obj = JSON.parse(json);
        if (obj?.type === 'message_start' && obj.message) {
          obj.message.id = ensureMessageId(obj.message.id);
          obj.message.usage = normalizeAnthropicUsage(obj.message.usage);
          done = true;
          return 'data: ' + JSON.stringify(obj);
        }
        return whole;
      } catch {
        return whole;
      }
    });
  };
  return {
    push(text) {
      buf += text;
      // 兜底：万一上游给出一段永远没有事件边界的内容，别把它无限攒在内存里
      if (buf.length > 1024 * 1024) {
        const out = buf;
        buf = '';
        done = true;
        return out;
      }
      let out = '';
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        out += patchEvent(buf.slice(0, idx + 2));
        buf = buf.slice(idx + 2);
      }
      return out;
    },
    flush() {
      const rest = buf;
      buf = '';
      return rest;
    },
  };
}

/** 请求体基本校验：写错的请求就地返回 400，不要浪费一次 session 额度 */
function validateRequest(pathname, parsed) {
  const isAnthropic = ANTHROPIC_PATHS.has(pathname);
  const needsMessages = CHAT_PATHS.has(pathname) || isAnthropic;
  if (!needsMessages) return null;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 400, message: '请求体必须是一个 JSON 对象' };
  }
  if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) {
    return { status: 400, message: 'messages 必须是非空数组' };
  }
  if ('model' in parsed && (typeof parsed.model !== 'string' || !parsed.model.trim())) {
    return { status: 400, message: 'model 必须是非空字符串' };
  }
  if (isAnthropic && 'max_tokens' in parsed && typeof parsed.max_tokens !== 'number') {
    return { status: 400, message: 'max_tokens 必须是数字' };
  }
  return null;
}

/**
 * 请求体过大时的收尾。分两种：
 *  - 只是稍微超（声明大小在上限 4 倍以内）：把它读完丢掉再回 413，
 *    这样客户端能干净地看到状态码，keep-alive 连接也还能复用；
 *  - 大得离谱或者不声明长度：回完就关连接，不给人白占带宽的机会
 *    （这种情况下客户端可能只看到连接被关，这是 HTTP 的固有含糊之处）。
 */
async function rejectTooLarge(req, res, pathname, message, status = 413) {
  const declared = Number(req.headers['content-length'] || 0);
  const drainBudget = config.maxBodyBytes * 4;
  if (Number.isFinite(declared) && declared > 0 && declared <= drainBudget) {
    try {
      for await (const _chunk of req) {
        /* 丢掉 */
      }
    } catch {
      /* 客户端自己断了也无所谓 */
    }
    send(res, status, errorBody(pathname, message, status));
    return;
  }
  send(res, status, errorBody(pathname, message, status), { connection: 'close' });
  req.resume();
  const timer = setTimeout(() => {
    if (!req.destroyed) req.destroy();
  }, 2000);
  req.once('end', () => clearTimeout(timer));
  req.once('error', () => clearTimeout(timer));
}

/** 内部调用 worker（管理后台探活、模型列表、自检都用这个），不经过 Node socket */
export async function callWorker(pathname, { method = 'GET', tokens = [], key = 'internal-key', body = null, headers = {} } = {}) {
  const request = new Request(`http://internal${pathname}`, {
    method,
    headers: new Headers({ authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers }),
    body: body === null ? null : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return worker.fetch(request, buildEnv(tokens, key));
}

/** 处理对外 API 请求（/v1/*）。外面套一层在飞计数闸门。 */
export async function handleApiRequest(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  if (!apiGate.tryEnter()) {
    console.warn(`[engine] 在飞请求已达上限 ${config.maxInflightApi}，拒掉 ${url.pathname}`);
    send(res, 503, errorBody(url.pathname, '网关正忙（同时处理的请求已达上限），稍后重试', 503), { 'retry-after': '5' });
    return;
  }
  try {
    await dispatchApi(req, res, url);
  } finally {
    apiGate.leave();
  }
}

async function dispatchApi(req, res, url) {
  const pathname = url.pathname;
  const isAnthropic = ANTHROPIC_PATHS.has(pathname);

  const presented = extractPresentedKey(req);
  const keyRecord = store.findKey(presented);
  if (!keyRecord || !keyRecord.enabled) {
    // 存在但被停用 / 完全不存在，对外都只说一句 Invalid API key —— 区分开来
    // 等于给攻击者一个"这个 key 存在"的探测口
    const ip = clientIp(req, config.trustProxyHops);
    const gate = keyFailLimiter.check(`key:${ip}`);
    keyFailLimiter.hit(`key:${ip}`);
    if (!gate.ok) {
      send(res, 429, errorBody(pathname, '认证失败次数过多，稍后再试', 429), { 'retry-after': '60' });
      return;
    }
    if (keyRecord && !keyRecord.enabled) console.warn(`[engine] 停用的 key 被使用（${keyRecord.id}）from ${ip}`);
    send(res, 401, errorBody(pathname, 'Invalid API key', 401));
    return;
  }

  let raw = Buffer.alloc(0);
  if (req.method === 'POST') {
    // 先看 Content-Length，超了就不用把字节读进来了
    const declared = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(declared) && declared > config.maxBodyBytes) {
      await rejectTooLarge(req, res, pathname, `请求体过大（上限 ${Math.round(config.maxBodyBytes / 1024 / 1024)}MB）`);
      return;
    }
    try {
      raw = await readBody(req, config.maxBodyBytes);
    } catch (err) {
      // 没读完的请求体会让这条 keep-alive 连接没法复用，所以明确关连接
      await rejectTooLarge(req, res, pathname, err.message, err.statusCode || 400);
      return;
    }
  }

  let parsed = null;
  let parseFailed = false;
  if (raw.length) {
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      parseFailed = true;
    }
  }
  if (parseFailed) {
    send(res, 400, errorBody(pathname, '请求体不是合法 JSON', 400));
    return;
  }
  if (raw.length) {
    const bad = validateRequest(pathname, parsed);
    if (bad) {
      send(res, bad.status, errorBody(pathname, bad.message, bad.status));
      return;
    }
  }

  const isModelList = MODEL_LIST_PATHS.has(pathname) && req.method === 'GET';
  const isCountTokens = COUNT_TOKENS_PATHS.has(pathname);
  // 会真正打上游、要花额度的路径 —— 这些请求必须过模型门禁
  const needsModelAuth = !isModelList && !isCountTokens && req.method === 'POST';

  // 模型解析：Anthropic 客户端常发 claude-xxx，映射到上游免费模型；
  // 既不是已知模型、也不像 Claude 系的名字，就按 404 报错，而不是悄悄换个模型跑
  const rawModel = parsed && typeof parsed.model === 'string' ? parsed.model.trim() : '';
  let requestedModel = rawModel ? resolveModelId(rawModel, isAnthropic) : '';
  if (rawModel && requestedModel !== rawModel && !isKnownModel(rawModel) && !looksLikeClaude(rawModel) && requestedModel === DEFAULT_MODEL) {
    send(res, 404, errorBody(pathname, `模型 ${rawModel} 不存在；GET /v1/models 可以看当前可用的模型`, 404));
    return;
  }
  // 没写 model 的请求：按当前"不限量"那一档挑一个（见 models.defaultModel），
  // 并且照样过门禁 —— 否则"不带 model"就成了绕开 key 白名单和已下架模型的口子。
  // 解析出来的 id 会写回请求体，所以引擎拿到的是这里定下来的模型，不是它自己的默认值。
  // 池子里一个 freebuff 号都没有时挑 opencode 的免费模型，不然必然 503。
  if (needsModelAuth && !requestedModel) {
    const hasFreebuff = store.accounts.some((a) => a.enabled && providerOf(a) === 'freebuff');
    requestedModel = defaultModel({ hasFreebuff });
  }

  const protocol = isAnthropic ? 'anthropic' : pathname.endsWith('/responses') ? 'responses' : 'openai';
  const startedAt = Date.now();
  /** 记一条用量 + 可选的聊天记录；任何异常都不能影响响应本身 */
  const track = ({ acct, status, ok, usageInfo, bytesOut, ttfbMs, error, replyText }) => {
    try {
      usage.record({
        ts: startedAt,
        keyId: keyRecord.id,
        keyName: keyRecord.name,
        accountId: acct?.id || '',
        provider: requestedModel ? providerForModel(requestedModel) : '',
        model: requestedModel || '',
        tier: requestedModel ? tierOf(requestedModel) : '',
        protocol,
        stream: Boolean(parsed?.stream),
        status,
        ok,
        latencyMs: Date.now() - startedAt,
        ttfbMs: ttfbMs || 0,
        usage: usageInfo || null,
        bytesIn: raw.length,
        bytesOut: bytesOut || 0,
        error: error || null,
      });
      appendChat({
        model: requestedModel,
        provider: requestedModel ? providerForModel(requestedModel) : '',
        tier: requestedModel ? tierOf(requestedModel) : '',
        protocol,
        stream: Boolean(parsed?.stream),
        status,
        ok,
        latencyMs: Date.now() - startedAt,
        keyId: keyRecord.id,
        keyName: keyRecord.name,
        accountId: acct?.id || '',
        usage: usageInfo || null,
        request: parsed,
        response: replyText ?? null,
        error: error || null,
      });
    } catch (err) {
      console.error(`[engine] 记录用量失败：${err.message}`);
    }
  };

  if (needsModelAuth) {
    const verdict = checkModelAccess(keyRecord, requestedModel);
    if (!verdict.ok) {
      track({ status: verdict.status, ok: false, error: 'model_denied' });
      send(res, verdict.status, errorBody(pathname, verdict.message, verdict.status));
      return;
    }
    // 把解析后的模型 id 写回请求体：判定用的是这个 id，转发给引擎的也必须是这个 id，
    // 不然两边的模型表一旦分叉，就可能"按免费判定、按付费执行"
    if (parsed && requestedModel && parsed.model !== requestedModel) {
      parsed.model = requestedModel;
      raw = Buffer.from(JSON.stringify(parsed));
    }
  }

  const makeRequest = () =>
    new Request(`${url.origin || 'http://internal'}${pathname}${url.search}`, {
      method: req.method,
      headers: new Headers({
        authorization: `Bearer ${presented}`,
        'content-type': req.headers['content-type'] || 'application/json',
        ...(req.headers['anthropic-version'] ? { 'anthropic-version': String(req.headers['anthropic-version']) } : {}),
        ...(req.headers['anthropic-beta'] ? { 'anthropic-beta': String(req.headers['anthropic-beta']) } : {}),
      }),
      body: raw.length ? raw : null,
    });

  /**
   * 一次上游调用。三条路返回的都是 WHATWG Response，所以下游的
   * 状态判定 / 头部白名单 / 流式处理完全共用。
   *
   * opencode 那条路还要补协议差：Zen 是**按模型**钉协议的（chat 原生的模型
   * 只认 chat 格式，claude-* 只认 Anthropic 格式），跟客户端用了哪个端点无关。
   * 客户端协议和模型原生协议对不上时，就在这一层翻一次 body、回来再翻一次响应。
   *   bridge = 'a2c'：Anthropic 客户端 → chat 原生模型（免费模型全在这一档）
   *   bridge = 'c2a'：OpenAI 客户端   → Anthropic 原生模型（claude-* / qwen*）
   *
   * 自定义上游则统一以 chat 为中枢：客户端说 Anthropic 就先翻成 chat（a2c），
   * 再由 src/protocols 的适配器翻成那个上游要的格式。所以四种协议两两组合
   * 都不用单独写代码。opencode 的 gpt-* / gemini-* 也走这套适配器。
   */
  const customUp = requestedModel ? upstreamForModel(requestedModel) : null;
  // opencode 上这个模型的原生协议（chat / anthropic / responses / google）
  const ocNative = requestedModel && isOpencodeModel(requestedModel) ? nativeProtocol(requestedModel) : null;
  let bridge = null;
  if (ocNative) {
    if (isAnthropic && ocNative !== 'anthropic') bridge = 'a2c';
    else if (!isAnthropic && ocNative === 'anthropic') bridge = 'c2a';
  } else if (customUp && isAnthropic) {
    // 客户端发的是 Anthropic，内部一律先归一到 chat
    bridge = 'a2c';
  }
  // responses / google 这两种没有直接的 chat↔它 的桥，统一走 protocols 适配器：
  // 先把请求归一成 chat，再由适配器翻过去（回来的响应同理）
  const ocAdapter = ocNative === 'responses' || ocNative === 'google' ? adapterFor(ocNative) : null;
  const callUpstream = (acct) => {
    const prov = providerOf(acct);
    if (prov === 'freebuff') return worker.fetch(makeRequest(), buildEnv([acct.token], presented));
    if (prov === 'opencode') {
      // 发给 Zen 的模型名不能带我们自己的 opencode/ 前缀
      const bare = stripPrefix(requestedModel || parsed?.model || '');
      if (ocAdapter) {
        const chatBody = isAnthropic ? anthropicToChat(parsed || {}, bare) : { ...(parsed || {}), model: bare };
        const body = ocAdapter.requestFromChat(chatBody, bare);
        // Gemini 的 stream 标记在路径上不在 body 里，单独带过去
        if (chatBody.stream) body.__stream = true;
        return callOpencode({ pathname, method: req.method, body, req, token: acct.token, modelId: bare });
      }
      const body =
        bridge === 'a2c'
          ? anthropicToChat(parsed || {}, bare)
          : bridge === 'c2a'
            ? chatToAnthropicRequest(parsed || {}, bare)
            : { ...(parsed || {}), model: bare };
      return callOpencode({ pathname, method: req.method, body, req, token: acct.token, modelId: bare });
    }
    // 自定义上游：账号的 provider 必须正好是这次模型所属的那个上游。
    // 对不上就直接失败，**绝不能落到下面的 worker.fetch** —— 那等于把用户的
    // 第三方 API key 发给 freebuff 的引擎。理论上 eligibleAccounts 已经按上游筛过了，
    // 这里是第二道闸。
    if (!customUp || prov !== customUp.id) {
      const err = new Error(`账号 ${acct.id} 属于上游 ${prov}，和模型 ${requestedModel} 要求的上游对不上`);
      err.mismatch = true;
      throw err;
    }
    const bare = stripUpstreamPrefix(requestedModel, customUp);
    // 归一到中枢格式，再交给适配器翻成上游协议
    const chatBody = isAnthropic ? anthropicToChat(parsed || {}, bare) : { ...(parsed || {}), model: bare };
    return callUpstreamApi(customUp, { chatBody, model: bare, apiKey: acct.token });
  };

  // 模型列表和 count_tokens 都不碰上游、不占额度，不需要账号
  if (isModelList || isCountTokens) {
    // Zen 没有 count_tokens 接口，模型 id 也不在 worker 的表里（丢给它会被判无效模型），
    // 所以 opencode 的模型自己在本地粗算一个数
    if (isCountTokens && parsed?.model && isOpencodeModel(resolveModelId(String(parsed.model), true))) {
      store.touchKey(keyRecord.id);
      send(res, 200, countTokensReply(parsed), { 'request-id': `req_${randomId(12)}` });
      return;
    }
    const resp = await worker.fetch(makeRequest(), buildEnv([], presented));
    const text = await resp.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {}
    if (isModelList && Array.isArray(payload?.data)) {
      // 所有上游的模型合成一张表对外给出去
      payload.data = filterModelList(keyRecord, [...payload.data, ...opencodeModelList(), ...customModelList()]);
    }
    store.touchKey(keyRecord.id);
    if (payload) {
      send(res, resp.status, payload, isAnthropic ? { 'request-id': `req_${randomId(12)}` } : {});
    } else {
      res.writeHead(resp.status, { 'content-type': 'application/json; charset=utf-8', ...CORS });
      res.end(text);
    }
    return;
  }

  const { order, manual, mode, eligible } = selectOrder(requestedModel);
  // opencode 的免费模型有一条不需要账号的路：官方 CLI 在没配 key 时用的 `public`
  // 匿名凭据。一个 opencode 号都没有时用它兜底，用户就能先把免费模型跑起来，
  // 不用非得先去注册。上游按出口 IP 限流，所以有真号的时候一定优先用真号。
  const anonOpencode =
    !order.length &&
    config.opencodeAnonymous &&
    requestedModel &&
    isOpencodeModel(requestedModel) &&
    tierOf(requestedModel) === 'free';
  if (anonOpencode) {
    order.push({ id: 'anon', token: ANON_KEY, provider: 'opencode', pool: 'free', anonymous: true });
  }
  if (!order.length) {
    const tier = requestedModel ? tierOf(requestedModel) : 'free';
    const wantOpencode = requestedModel && isOpencodeModel(requestedModel);
    let hint;
    if (wantOpencode && !store.accounts.some((a) => providerOf(a) === 'opencode')) {
      hint = tier === 'paid'
        ? '这是 opencode Zen 的付费模型，必须先在控制台添加一个 opencode 号（去 https://opencode.ai/zen 登录后复制 API key）'
        : '号池里没有 opencode 账号，而匿名模式是关着的（OPENCODE_ANONYMOUS=false）：去控制台添加一个 opencode 号';
    } else if (!store.accounts.length) hint = '账号池是空的，先去控制台添加账号';
    else if (manual)
      hint = eligible.length
        ? '手动模式下还没指定要用哪个账号（或者指定的账号不能用于这个模型），去控制台「账号池」点「设为当前」'
        : '手动模式下指定的账号已停用或不能承接这个模型，去控制台换一个';
    else if (wantOpencode) hint = 'opencode 号都被停用或已标记失效了，去控制台看看账号状态';
    else if (tier === 'paid') hint = '没有能承接付费(Premium)模型的账号：检查账号的「用途」是不是被限制成了仅免费';
    else hint = '账号池里没有可用账号（可能都被停用或已标记失效）';
    track({ status: 503, ok: false, error: 'no_account' });
    send(res, 503, errorBody(pathname, hint, 503));
    return;
  }

  store.touchKey(keyRecord.id);

  let hit = null; // { acct, response }
  let last = null; // { status, text, acct, state }
  const tried = [];
  // 真正发出去了几次。tried 只记失败，所以成功/客户端错误那一次不在里面 ——
  // 但 x-myapi-accounts-tried 要的是"这次用了几个号"，得单独数
  let attempts = 0;
  for (const acct of order) {
    let resp;
    attempts++;
    try {
      resp = await callUpstream(acct);
    } catch (err) {
      console.error(`[engine] 上游异常 ${pathname} (${acct.id}): ${err.message}`);
      last = { status: 502, text: `上游异常: ${err.message}`, acct, state: 'upstream_error' };
      tried.push(`${acct.id}:exception`);
      if (manual) break;
      continue;
    }
    if (resp.status < 400 || CLIENT_ERRORS.has(resp.status)) {
      hit = { acct, response: resp };
      break;
    }
    const text = await resp.text().catch(() => '');
    const prov = providerOf(acct);
    const state =
      prov === 'opencode'
        ? classifyOpencodeFailure(resp.status, text)
        : prov === 'freebuff'
          ? classifyFailure(resp.status, text)
          : classifyUpstreamFailure(resp.status, text);
    recordModelResult(requestedModel, { ok: false, status: resp.status, text });
    // 匿名那条路不是真账号，别往库里写状态
    if (!acct.anonymous) {
      store.setAccountStatus(acct.id, {
        state,
        verdict: FAILURE_TEXT[state] || '上游失败',
        detail: `HTTP ${resp.status}：${String(text).slice(0, 200)}`,
        quota: acct.status?.quota || '',
        source: 'request',
      });
    }
    last = { status: resp.status, text, acct, state };
    tried.push(`${acct.id}:${state}`);
    if (manual || !worthNextAccount(resp.status, mode)) break;
  }

  if (!hit) {
    // 对外只给归类结论，不回上游原文 —— 原文里可能带账号/内部细节，
    // 完整内容写进服务端日志和账号状态列
    const reason = last ? FAILURE_TEXT[last.state] || '上游失败' : '没有可用账号';
    const suffix = manual
      ? '（手动模式：不会自动换号，去控制台换一个账号或打开自动切换）'
      : order.length > 1
        ? `（已依次试过 ${order.length} 个账号）`
        : '';
    console.warn(
      `[engine] ${pathname} 全部账号失败：${tried.join(', ')}${last ? ` | 最后一条：HTTP ${last.status} ${String(last.text).slice(0, 300)}` : ''}`
    );
    const status = last?.status === 429 ? 429 : 502;
    track({
      acct: last?.acct,
      status,
      ok: false,
      error: last ? `${last.state}: HTTP ${last.status}` : 'no_account',
    });
    send(res, status, errorBody(pathname, `上游调用失败（${reason}）${suffix}，详情见控制台的账号状态`, status), {
      'x-myapi-accounts-tried': String(attempts),
      ...(status === 429 ? { 'retry-after': '60' } : {}),
    });
    return;
  }

  const { acct: used, response } = hit;
  if (!used.anonymous) {
    // 只有"钉住一个号"那两种策略才需要记指针：
    //   single   是用户手动钉的，请求不该悄悄改掉
    //   轮询/随机 每次都换起点，记指针没意义，写了还会跟游标打架
    if (mode === 'exhaust' || mode === 'onerror') setActiveForProvider(providerOf(used), used.id);
    if (used.status && used.status.state !== 'ok' && response.status < 400) {
      store.setAccountStatus(used.id, { state: 'ok', verdict: '存活', detail: '刚刚成功承接了一次请求', quota: used.status.quota || '', source: 'request' });
    }
  }

  // 白名单透传：上游头里可能有 set-cookie / access-control-* 之类，
  // 原样转出去等于让上游在本网关域名下写 cookie、改 CORS 策略
  const headers = {};
  for (const [k, v] of response.headers.entries()) {
    if (PASS_HEADERS.has(k.toLowerCase())) headers[k] = v;
  }
  headers['x-myapi-rotation'] = used.anonymous ? 'anonymous' : mode;
  headers['x-myapi-provider'] = providerOf(used);
  if (attempts) headers['x-myapi-accounts-tried'] = String(attempts);
  if (requestedModel) headers['x-myapi-model-tier'] = tierOf(requestedModel);
  if (isAnthropic) headers['request-id'] = `req_${randomId(12)}`;

  const contentType = String(response.headers.get('content-type') || '');
  const isSse = contentType.includes('text/event-stream');
  const wantChat = Boolean(store.settings?.chatLogEnabled);

  // 非流式（JSON 一整段）：读完再发，顺手取 usage、补 Anthropic 的 id
  if (!isSse) {
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {}
    const ok = response.status < 400;
    // 随包引擎自己有一份硬编码的"暂停名单"（vendor/worker.js 的 PAUSED_MODELS），
    // 命中就回一句干巴巴的 `unsupported_model`。那是**引擎本地**在拒，不是真上游 ——
    // 我们不改 vendor 文件，但至少把这句话翻译清楚，别让用户对着它猜。
    if (!ok && payload?.error?.type === 'unsupported_model' && providerOf(used) === 'freebuff' && isKnownModel(requestedModel)) {
      payload = errorBody(
        pathname,
        `随包引擎 vendor/worker.js 在本地把 ${requestedModel} 列进了暂停名单，所以这一步没发到上游（不是上游拒的）。` +
          `跑 npm run update-worker 升级引擎可能就恢复了；也可以先换一个模型。`,
        response.status,
        'unsupported_model'
      );
    }
    // 自定义上游 / opencode 的非 chat 原生模型，先归一到中枢格式：后面的 usage
    // 统计、聊天记录、协议回翻全都按 chat 的字段读，翻早一点这些就都不用再分情况
    if (payload && ok && customUp && providerOf(used) === customUp.id) {
      payload = adapterFor(customUp.format).responseToChat(payload, requestedModel);
    } else if (payload && ok && ocAdapter && providerOf(used) === 'opencode') {
      payload = ocAdapter.responseToChat(payload, requestedModel);
    }
    const usageInfo = payload ? usageFromJson(payload) : null;
    recordModelResult(requestedModel, { ok, status: response.status, text: ok ? '' : text });
    track({
      acct: used,
      status: response.status,
      ok,
      usageInfo,
      bytesOut: Buffer.byteLength(text),
      replyText: wantChat ? replyTextFrom(payload) : null,
      error: ok ? null : `HTTP ${response.status}`,
    });
    // 走过桥的：上游给的是对面那套格式，这里翻回客户端要的。
    // 错误响应不翻 —— 错误信封两边形状本来就差不多，翻反而容易丢信息。
    if (payload && ok && bridge === 'a2c') {
      send(res, response.status, chatToAnthropic(payload, requestedModel), headers);
    } else if (payload && ok && bridge === 'c2a') {
      send(res, response.status, anthropicToChatResponse(payload, requestedModel), headers);
    } else if (payload && isAnthropic) {
      send(res, response.status, patchAnthropicMessage(payload), headers);
    } else if (payload) {
      send(res, response.status, payload, headers);
    } else {
      res.writeHead(response.status, { 'content-type': 'application/json; charset=utf-8', ...CORS, ...headers });
      res.end(text);
    }
    return;
  }

  res.writeHead(response.status, { ...CORS, ...headers });
  if (!response.body) {
    track({ acct: used, status: response.status, ok: false, error: 'empty_body' });
    res.end();
    return;
  }

  // 流式要经过两级：
  //   inbound  自定义上游的原生流 → 中枢 chat 流（chat 格式的上游返回 null，不用转）
  //   patcher  中枢流 → 客户端要的协议
  // 串起来正好覆盖"任意上游协议 × 任意客户端协议"，不用为每种组合单独写。
  const inbound =
    customUp && providerOf(used) === customUp.id
      ? adapterFor(customUp.format).createStreamToChat(requestedModel)
      : ocAdapter && providerOf(used) === 'opencode'
        ? ocAdapter.createStreamToChat(requestedModel)
        : null;
  const patcher =
    bridge === 'a2c'
      ? createChatToAnthropicStream(requestedModel)
      : bridge === 'c2a'
        ? createAnthropicToChatStream(requestedModel)
        : isAnthropic
          ? createAnthropicStreamPatcher()
          : null;
  const sniffer = createUsageSniffer({ collectText: wantChat });
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let bytesOut = 0;
  let ttfbMs = 0;
  // 客户端一断开就把上游流也取消掉：不取消的话上游会继续把整段输出生成完，
  // 那条 session 也一直占着 —— 相当于让人用"发出即断"白烧号池额度
  let aborted = false;
  const onClientGone = () => {
    aborted = true;
    reader.cancel().catch(() => {});
  };
  res.once('close', onClientGone);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (aborted || res.writableEnded || res.destroyed) break;
      if (!value) continue;
      if (!ttfbMs) ttfbMs = Date.now() - startedAt;
      const raw = decoder.decode(value, { stream: true });
      // 先归一到中枢格式，usage 嗅探和补丁器读到的就都是 chat 的字段
      const text = inbound ? inbound.push(raw) : raw;
      if (inbound && !text) continue;
      sniffer.push(text);
      const chunk = patcher ? patcher.push(text) : inbound ? text : Buffer.from(value);
      if (!chunk || ((patcher || inbound) && !chunk.length)) continue;
      bytesOut += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      // 尊重背压：写不动的时候等 drain，否则慢客户端会把内存撑起来
      if (!res.write(chunk)) {
        await new Promise((resolve) => {
          const done2 = () => resolve();
          res.once('drain', done2);
          res.once('close', done2);
        });
      }
    }
    if (!aborted && !res.writableEnded) {
      // 收尾也要按同样的顺序过一遍：inbound 的尾巴要能再喂给 patcher
      const tail = inbound ? inbound.flush() : '';
      if (tail) {
        sniffer.push(tail);
        const out = patcher ? patcher.push(tail) : tail;
        if (out) res.write(out);
      }
      if (patcher) {
        const rest = patcher.flush();
        if (rest) res.write(rest);
      }
    }
  } catch {
    // 客户端断流是常态，不当错误处理
  } finally {
    res.off('close', onClientGone);
    if (!aborted) reader.cancel().catch(() => {});
    if (!res.writableEnded) res.end();
    recordModelResult(requestedModel, { ok: !aborted, status: response.status, text: '' });
    track({
      acct: used,
      status: response.status,
      ok: !aborted,
      usageInfo: sniffer.result(),
      bytesOut,
      ttfbMs,
      replyText: wantChat ? sniffer.text : null,
      error: aborted ? 'client_aborted' : null,
    });
  }
}

/** 从非流式响应里抽出模型正文（只给聊天记录用） */
function replyTextFrom(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload.content)) {
    return payload.content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
  }
  const choice = payload.choices?.[0];
  if (choice?.message?.content) return String(choice.message.content);
  if (typeof payload.output_text === 'string') return payload.output_text;
  return null;
}

/** 取 worker 视角的账号健康快照（不额外调上游，只读 worker 内存里的观测结果） */
export async function workerHealth() {
  // 只把 freebuff 的 token 交给 worker：opencode 的 key 塞进 FREEBUFF_TOKEN
  // 既没意义，也等于把它送去一个用不着它的上游
  const tokens = store.accounts.filter((a) => a.enabled && providerOf(a) === 'freebuff').map((a) => a.token);
  const resp = await callWorker('/healthz', { tokens });
  try {
    return await resp.json();
  } catch {
    return null;
  }
}
