// opencode Zen 号池：直连 https://opencode.ai/zen/v1，不经过 vendor/worker.js。
//
// 和 freebuff 那条路的关键区别：
//   * freebuff 要先建 session 再聊，所以必须借 worker.js 里那套逻辑；
//     Zen 就是标准的 OpenAI / Anthropic 接口，一个 fetch 就够，透传即可。
//   * 凭据就是一个 API key（用户去 https://opencode.ai/zen 登录后复制），
//     没有 token 刷新，也没有"账号"概念。
//
// 必须带 x-opencode-* 那组头（2026-08-20 对着线上验过）：
// 只带 Authorization 的话免费模型会被当成普通匿名流量，直接回 429 FreeUsageLimitError；
// 补上这组头之后同一个请求就是 200。参考实现 jasonxu114514/opencode2api 也是这么做的。
import { createHash, randomBytes } from 'node:crypto';
import { config } from './config.js';
import { nativeProtocol } from './models-opencode.js';

// 官方 CLI 在没配 key 时用的公共凭据。上游把它当匿名请求，按出口 IP 给免费模型限流。
export const ANON_KEY = 'public';
// 跟着官方 CLI 的 UA 走。上游拿它区分"编程 agent"和普通 API 流量。
const USER_AGENT = 'opencode/1.18.18 (linux x64; node)';

/** ses_/prj_ 这类 id 要在同一会话内稳定，所以用内容哈希而不是随机数 */
function stableId(prefix, seed) {
  return prefix + '_' + createHash('sha256').update(prefix + '\0' + String(seed)).digest('hex').slice(0, 24);
}

function randomLabel(prefix) {
  return prefix + '_' + randomBytes(16).toString('hex');
}

/**
 * 从请求体里找一个"同一场对话不变、不同对话不同"的种子。
 * 用第一条 user 消息：多轮聊天里历史会变长但第一条不变，正好符合会话语义。
 */
function conversationSeed(body) {
  if (typeof body?.input === 'string' && body.input) return body.input;
  for (const field of ['messages', 'input']) {
    const list = Array.isArray(body?.[field]) ? body[field] : [];
    for (const item of list) {
      if (item?.role !== 'user') continue;
      const encoded = JSON.stringify(item.content ?? null);
      if (encoded && encoded !== 'null') return encoded;
    }
  }
  return '';
}

/** 客户端显式指定的会话 id 优先，其次按第一条 user 消息推导 */
export function deriveIds(req, body) {
  const explicit =
    req?.headers?.['x-opencode-session'] ||
    req?.headers?.['x-session-id'] ||
    req?.headers?.['conversation-id'] ||
    body?.conversation_id ||
    body?.metadata?.session_id ||
    '';
  const seed = String(explicit || conversationSeed(body) || '').trim();
  const projectSeed = req?.headers?.['x-opencode-project'] || body?.metadata?.project_id || 'myapi:default';
  return {
    session: seed ? stableId('ses', seed) : randomLabel('ses'),
    request: randomLabel('req'),
    project: stableId('prj', projectSeed),
  };
}

/**
 * Zen 的 Anthropic 端点收 x-api-key，OpenAI / Responses 端点收 Authorization: Bearer。
 * 两个都带上最省事，上游只认它需要的那个。
 */
function authHeaders(token) {
  const key = token || ANON_KEY;
  return { authorization: `Bearer ${key}`, 'x-api-key': key };
}

export function upstreamHeaders(req, body, token) {
  const ids = deriveIds(req, body);
  return {
    'content-type': 'application/json',
    accept: req?.headers?.accept || 'application/json',
    'user-agent': USER_AGENT,
    'x-opencode-client': 'cli',
    'x-opencode-session': ids.session,
    'x-opencode-request': ids.request,
    'x-opencode-project': ids.project,
    ...authHeaders(token),
    // Anthropic 端点要版本号，客户端没给就补一个
    ...(req?.headers?.['anthropic-version'] ? { 'anthropic-version': req.headers['anthropic-version'] } : {}),
  };
}

/**
 * 把网关自己的路径映射到 Zen 的路径。
 *
 * 关键：**按模型的原生协议选端点，不是按客户端用了哪个端点**。
 * Zen 只是照端点解析 body，然后原样转给上游厂商 —— 实测把 chat 原生的
 * mimo-v2.5-free 发到 /messages 或 /responses，一律 400
 * `Input required: specify "prompt" or "messages"`。
 * body 的格式转换由 engine 那边负责（src/anthropic-bridge.js）。
 */
export function upstreamPath(pathname, modelId) {
  if (/\/models$/.test(pathname)) return '/models';
  return nativeProtocol(modelId) === 'anthropic' ? '/messages' : '/chat/completions';
}

/** 一次上游调用；返回原生 WHATWG Response，好让上层的流式/头部处理完全复用 */
export async function callOpencode({ pathname, method = 'POST', body, req, token, signal, modelId }) {
  const url = config.opencodeBase + upstreamPath(pathname, modelId || body?.model);
  const headers = upstreamHeaders(req, body, token);
  return fetch(url, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body ?? {}),
    signal,
    redirect: 'follow',
  });
}

/**
 * 拉一次 Zen 的模型清单。这个接口免鉴权，所以没有号也能拿到。
 * 只返回 id 列表，价格另有静态表（见 models-opencode.js）。
 */
export async function fetchOpencodeModels(timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(config.opencodeBase + '/models', {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const ids = Array.isArray(data?.data) ? data.data.map((m) => m?.id).filter(Boolean) : [];
    return ids.length ? ids : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Zen 的错误信封是统一的 {"type":"error","error":{"type":"…","message":"…"}}，
 * 直接按 error.type 归类，比在正文里正则捞字符串准得多。
 */
export function classifyOpencodeFailure(status, text) {
  let type = '';
  try {
    type = JSON.parse(text)?.error?.type || '';
  } catch {
    /* 正文不是 JSON 就只看状态码 */
  }
  if (type === 'AuthError' || status === 401) return 'token_invalid';
  if (type === 'RegionError') return 'country_blocked';
  if (type === 'FreeUsageLimitError' || status === 429) return 'rate_limited';
  if (/insufficient|balance|credit/i.test(text || '')) return 'no_credit';
  if (status === 403) return 'blocked';
  return 'upstream_error';
}

/**
 * 校验一个 Zen API key 能不能用。
 * 上游没有"查余额"接口，所以拿一个免费模型发最小请求探活：
 * 200 = 好号；401 = key 无效；429 = key 有效但被限流（仍然算可用）。
 */
export async function probeOpencodeKey(token, { timeoutMs = 30000, model = 'mimo-v2.5-free' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const body = { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false };
  try {
    const resp = await fetch(config.opencodeBase + '/chat/completions', {
      method: 'POST',
      headers: upstreamHeaders(null, body, token),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    if (resp.ok) return { state: 'ok', verdict: '可用', detail: `免费模型 ${model} 实测通过`, httpStatus: 200 };
    const kind = classifyOpencodeFailure(resp.status, text);
    if (kind === 'rate_limited') {
      return {
        state: 'rate_limited',
        verdict: '暂时限流',
        detail: 'key 有效，但上游正在限流（免费模型按出口 IP 计量）',
        httpStatus: resp.status,
      };
    }
    if (kind === 'country_blocked') {
      return {
        state: 'ok',
        verdict: '可用',
        detail: `key 有效；${model} 在当前出口地区不可用，换别的免费模型即可`,
        httpStatus: resp.status,
      };
    }
    const verdict = kind === 'token_invalid' ? 'key 无效' : '上游拒绝';
    return { state: kind, verdict, detail: `HTTP ${resp.status}：${String(text).slice(0, 160)}`, httpStatus: resp.status };
  } catch (err) {
    return {
      state: 'unknown',
      verdict: '探测失败',
      detail: err.name === 'AbortError' ? '探测超时' : err.message,
      httpStatus: 0,
    };
  } finally {
    clearTimeout(timer);
  }
}
