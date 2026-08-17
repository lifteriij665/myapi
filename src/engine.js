// 引擎适配层：把 Node 请求转成 vendor/worker.js 的 fetch(request, env) 调用。
//
// 关键点：env 是每个请求现算的 —— FREEBUFF_TOKEN 只放「这个模型这个 key 允许使用」
// 的账号 token，顺序即优先级。worker.js 内部的 parseAccounts/pickToken 会照着这个
// 池子做会话复用和冷却轮换，所以多账号、免费/付费分池不需要改动 worker.js 一行代码。
import worker from '../vendor/worker.js';
import { config } from './config.js';
import { store } from './store.js';
import { checkModelAccess, filterModelList, resolveModelId, tierOf } from './models.js';
import { readBody } from './util.js';

const ANTHROPIC_PATHS = new Set(['/v1/messages', '/messages', '/v1/messages/count_tokens', '/messages/count_tokens']);
const MODEL_LIST_PATHS = new Set(['/v1/models', '/models']);
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization, x-api-key, x-freebuff-instance-id, anthropic-version, anthropic-beta',
};

export function extractPresentedKey(req) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  if (req.headers['x-api-key']) return String(req.headers['x-api-key']).trim();
  const apiKeyHeader = req.headers['api-key'];
  if (apiKeyHeader) return String(apiKeyHeader).trim();
  return '';
}

function rank(account, tier) {
  // 付费模型：优先「付费专用」号；免费模型：优先「仅免费」号，尽量不动付费号
  if (tier === 'paid') return account.pool === 'paid' ? 0 : 1;
  if (account.pool === 'free') return 0;
  if (account.pool === 'any') return 1;
  return 2;
}

/** 选出可用于该模型的账号（顺序 = 优先级） */
export function eligibleAccounts(modelId) {
  const tier = modelId ? tierOf(modelId) : 'free';
  const enabled = store.accounts.filter((a) => a.enabled && a.token && a.token.length > 8);
  const dead = new Set(['token_invalid', 'banned']);
  const healthy = enabled.filter((a) => !dead.has(a.status?.state));
  const base = healthy.length ? healthy : enabled; // 全被标记失效时仍然放行，让上游自己说话
  const usable = tier === 'paid' ? base.filter((a) => a.pool === 'any' || a.pool === 'paid') : base;
  return [...usable].sort((a, b) => rank(a, tier) - rank(b, tier));
}

function buildEnv(tokens, presentedKey) {
  return {
    // 换行分隔：token 里不会有换行，比逗号更安全
    FREEBUFF_TOKEN: tokens.join('\n'),
    // worker 内部要求请求头里的 key 等于 env 里的 key；这里直接把校验通过的 key 传进去，
    // 多 key 管理由本层负责
    FREEBUFF_API_KEY: presentedKey || 'internal-key',
    FREEBUFF_DEBUG: config.workerDebug ? 'true' : 'false',
  };
}

function errorBody(pathname, message, status) {
  if (ANTHROPIC_PATHS.has(pathname)) {
    const type =
      status === 401
        ? 'authentication_error'
        : status === 403
          ? 'permission_error'
          : status >= 500
            ? 'api_error'
            : 'invalid_request_error';
    return { type: 'error', error: { type, message } };
  }
  const type =
    status === 401
      ? 'auth_error'
      : status === 403
        ? 'permission_error'
        : status === 503
          ? 'service_unavailable'
          : status >= 500
            ? 'api_error'
            : 'invalid_request_error';
  return { error: { message, type } };
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

/** 内部调用 worker（管理后台探活、模型列表都用这个），不经过 Node socket */
export async function callWorker(pathname, { method = 'GET', tokens = [], key = 'internal-key', body = null, headers = {} } = {}) {
  const request = new Request(`http://internal${pathname}`, {
    method,
    headers: new Headers({ authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers }),
    body: body === null ? null : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return worker.fetch(request, buildEnv(tokens, key));
}

/**
 * 处理 /v1/* 这类对外 API 请求。返回 true 表示已经接管并响应。
 */
export async function handleApiRequest(req, res, url) {
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const presented = extractPresentedKey(req);
  const keyRecord = store.findKey(presented);
  if (!keyRecord || !keyRecord.enabled) {
    const message = keyRecord && !keyRecord.enabled ? 'API key 已被停用' : 'Invalid API key';
    send(res, 401, errorBody(pathname, message, 401));
    return;
  }

  let raw = Buffer.alloc(0);
  if (req.method === 'POST') {
    try {
      raw = await readBody(req, 32 * 1024 * 1024);
    } catch (err) {
      send(res, err.statusCode || 400, errorBody(pathname, err.message, 400));
      return;
    }
  }

  // 取出请求模型，用于免费/付费门禁和账号池筛选
  let requestedModel = '';
  if (raw.length) {
    try {
      const parsed = JSON.parse(raw.toString('utf8'));
      requestedModel = resolveModelId(parsed?.model, ANTHROPIC_PATHS.has(pathname));
    } catch {
      /* 交给 worker 自己报 Invalid JSON */
    }
  }

  if (requestedModel) {
    const verdict = checkModelAccess(keyRecord, requestedModel);
    if (!verdict.ok) {
      send(res, verdict.status, errorBody(pathname, verdict.message, verdict.status));
      return;
    }
  }

  const accounts = eligibleAccounts(requestedModel);
  const isModelList = MODEL_LIST_PATHS.has(pathname) && req.method === 'GET';
  if (!accounts.length && !isModelList) {
    const tier = requestedModel ? tierOf(requestedModel) : 'free';
    const hint = store.accounts.length
      ? tier === 'paid'
        ? '账号池里没有可承接付费(Premium)模型的账号（检查账号的「用途」设置是否被限制为仅免费）'
        : '账号池里没有可用账号（可能都被停用或已标记失效）'
      : '账号池是空的，请先打开控制台添加账号';
    send(res, 503, errorBody(pathname, hint, 503));
    return;
  }

  const request = new Request(`${url.origin || 'http://internal'}${pathname}${url.search}`, {
    method: req.method,
    headers: new Headers({
      authorization: `Bearer ${presented}`,
      'content-type': req.headers['content-type'] || 'application/json',
      ...(req.headers['anthropic-version'] ? { 'anthropic-version': String(req.headers['anthropic-version']) } : {}),
      ...(req.headers['anthropic-beta'] ? { 'anthropic-beta': String(req.headers['anthropic-beta']) } : {}),
    }),
    body: raw.length ? raw : null,
  });

  const env = buildEnv(accounts.map((a) => a.token), presented);
  store.touchKey(keyRecord.id);

  let response;
  try {
    response = await worker.fetch(request, env);
  } catch (err) {
    console.error(`[engine] worker 异常 ${pathname}: ${err.message}`);
    send(res, 502, errorBody(pathname, `上游调用失败: ${err.message}`, 502));
    return;
  }

  // 模型列表要按 key 权限过滤，先收完再改写
  if (isModelList) {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed?.data)) {
        parsed.data = filterModelList(keyRecord, parsed.data);
      }
      send(res, response.status, parsed, {
        'x-myapi-key-allow-paid': keyRecord.allowPaid ? '1' : '0',
      });
    } catch {
      res.writeHead(response.status, { 'content-type': 'application/json; charset=utf-8', ...CORS });
      res.end(text);
    }
    return;
  }

  const headers = {};
  for (const [k, v] of response.headers.entries()) {
    if (['content-encoding', 'content-length', 'transfer-encoding'].includes(k.toLowerCase())) continue;
    headers[k] = v;
  }
  headers['x-myapi-accounts'] = String(accounts.length);
  if (requestedModel) headers['x-myapi-model-tier'] = tierOf(requestedModel);

  res.writeHead(response.status, { ...CORS, ...headers });
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && !res.writableEnded) res.write(Buffer.from(value));
    }
  } catch (err) {
    // 客户端断流是常态，不当错误处理
  } finally {
    if (!res.writableEnded) res.end();
  }
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
