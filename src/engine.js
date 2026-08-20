// 引擎适配层：把 Node 请求转成 vendor/worker.js 的 fetch(request, env) 调用。
//
// 账号选择在这一层做，不交给 worker：
//   worker 内部的 pickToken 是轮询（每次调用都推进 accountIdx），一个请求里会挨个
//   试完整个池子。用户要的是"钉住一个号，用到失败才换下一个"，所以这里每次只把
//   一个 token 放进 env —— worker 的池子里只有一个号，自然没法轮询 —— 失败了由
//   这一层决定要不要换号重试。手动模式下连重试都不做。
import worker from '../vendor/worker.js';
import { config } from './config.js';
import { store } from './store.js';
import {
  checkModelAccess,
  filterModelList,
  resolveModelId,
  tierOf,
  isKnownModel,
  looksLikeClaude,
  recordModelResult,
  defaultModel,
  DEFAULT_MODEL,
} from './models.js';
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
  const enabled = store.accounts.filter((a) => a.enabled && a.token && a.token.length > 8);
  const dead = new Set(['token_invalid', 'banned']);
  const healthy = enabled.filter((a) => !dead.has(a.status?.state));
  const base = healthy.length ? healthy : enabled; // 全被标记失效时仍然放行，让上游自己说话
  const usable = tier === 'paid' ? base.filter((a) => a.pool === 'any' || a.pool === 'paid') : base;
  return [...usable].sort((a, b) => rank(a, tier) - rank(b, tier));
}

/**
 * 决定这次请求按什么顺序用号。
 * 自动模式：从当前钉住的号开始，失败再往后顺延（顺延也只在失败时发生）。
 * 手动模式：只有钉住的那一个，失败就直接报错。
 */
export function selectOrder(modelId) {
  const eligible = eligibleAccounts(modelId);
  const manual = store.settings.autoSwitch === false;
  const activeId = store.settings.activeAccountId;
  if (manual) {
    const pinned = eligible.find((a) => a.id === activeId);
    return { order: pinned ? [pinned] : [], manual, eligible };
  }
  const tier = modelId ? tierOf(modelId) : 'free';
  const idx = eligible.findIndex((a) => a.id === activeId);
  // 钉住的号只在"和最优先那一档同级"时才当起点：否则一次付费请求把指针挪到
  // 付费专用号上之后，后面的免费流量会一直去啃那个号
  const sticky = idx >= 0 && rank(eligible[idx], tier) === rank(eligible[0], tier);
  const order = sticky ? [...eligible.slice(idx), ...eligible.slice(0, idx)] : eligible;
  return { order, manual, eligible };
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
  blocked: '上游拒绝',
  upstream_error: '上游失败',
};

/** 只有这些状态码值得换个号再试 */
function worthNextAccount(status) {
  return status === 429 || status === 401 || status === 403 || (status >= 500 && status <= 599);
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
  if (needsModelAuth && !requestedModel) requestedModel = defaultModel();

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

  // 模型列表和 count_tokens 都不碰上游、不占额度，不需要账号
  if (isModelList || isCountTokens) {
    const resp = await worker.fetch(makeRequest(), buildEnv([], presented));
    const text = await resp.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {}
    if (isModelList && Array.isArray(payload?.data)) {
      payload.data = filterModelList(keyRecord, payload.data);
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

  const { order, manual, eligible } = selectOrder(requestedModel);
  if (!order.length) {
    const tier = requestedModel ? tierOf(requestedModel) : 'free';
    let hint;
    if (!store.accounts.length) hint = '账号池是空的，先去控制台添加账号';
    else if (manual)
      hint = eligible.length
        ? '手动模式下还没指定要用哪个账号（或者指定的账号不能用于这个模型），去控制台「账号池」点「设为当前」'
        : '手动模式下指定的账号已停用或不能承接这个模型，去控制台换一个';
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
  for (const acct of order) {
    let resp;
    try {
      resp = await worker.fetch(makeRequest(), buildEnv([acct.token], presented));
    } catch (err) {
      console.error(`[engine] worker 异常 ${pathname} (${acct.id}): ${err.message}`);
      last = { status: 502, text: `worker 异常: ${err.message}`, acct, state: 'upstream_error' };
      tried.push(`${acct.id}:exception`);
      if (manual) break;
      continue;
    }
    if (resp.status < 400 || CLIENT_ERRORS.has(resp.status)) {
      hit = { acct, response: resp };
      break;
    }
    const text = await resp.text().catch(() => '');
    const state = classifyFailure(resp.status, text);
    recordModelResult(requestedModel, { ok: false, status: resp.status, text });
    store.setAccountStatus(acct.id, {
      state,
      verdict: FAILURE_TEXT[state] || '上游失败',
      detail: `HTTP ${resp.status}：${String(text).slice(0, 200)}`,
      quota: acct.status?.quota || '',
      source: 'request',
    });
    last = { status: resp.status, text, acct, state };
    tried.push(`${acct.id}:${state}`);
    if (manual || !worthNextAccount(resp.status)) break;
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
      'x-myapi-accounts-tried': String(tried.length),
      ...(status === 429 ? { 'retry-after': '60' } : {}),
    });
    return;
  }

  const { acct: used, response } = hit;
  store.setActiveAccount(used.id);
  if (used.status && used.status.state !== 'ok' && response.status < 400) {
    store.setAccountStatus(used.id, { state: 'ok', verdict: '存活', detail: '刚刚成功承接了一次请求', quota: used.status.quota || '', source: 'request' });
  }

  // 白名单透传：上游头里可能有 set-cookie / access-control-* 之类，
  // 原样转出去等于让上游在本网关域名下写 cookie、改 CORS 策略
  const headers = {};
  for (const [k, v] of response.headers.entries()) {
    if (PASS_HEADERS.has(k.toLowerCase())) headers[k] = v;
  }
  headers['x-myapi-rotation'] = manual ? 'manual' : 'sticky';
  if (tried.length) headers['x-myapi-accounts-tried'] = String(tried.length);
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
    const usageInfo = payload ? usageFromJson(payload) : null;
    const ok = response.status < 400;
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
    if (payload && isAnthropic) {
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

  const patcher = isAnthropic ? createAnthropicStreamPatcher() : null;
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
      const text = decoder.decode(value, { stream: true });
      sniffer.push(text);
      const chunk = patcher ? patcher.push(text) : Buffer.from(value);
      if (!chunk || (patcher && !chunk.length)) continue;
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
    if (patcher && !aborted && !res.writableEnded) {
      const rest = patcher.flush();
      if (rest) res.write(rest);
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
  const tokens = store.accounts.filter((a) => a.enabled).map((a) => a.token);
  const resp = await callWorker('/healthz', { tokens });
  try {
    return await resp.json();
  } catch {
    return null;
  }
}
