// 协议适配器注册表 + 自定义上游的 HTTP 客户端。
//
// 网关内部一律以 OpenAI Chat Completions 当中枢格式（门禁、用量、聊天记录都读
// chat 的字段）。每个上游声明自己说哪种协议，进出各翻一次：
//
//   客户端协议 --(翻成 chat)--> 门禁/日志 --(翻成上游协议)--> 上游
//                                          <--(翻回 chat)--
//
// 四种格式对应四个适配器。chat 是中枢，所以它的适配器是恒等变换。
import { config } from '../config.js';
import * as responses from './responses.js';
import * as gemini from './gemini.js';
import { anthropicToChat, chatToAnthropic, createChatToAnthropicStream, chatToAnthropicRequest, anthropicToChatResponse, createAnthropicToChatStream } from '../anthropic-bridge.js';

/** chat ↔ chat：恒等。只把 model 换成上游认的裸名 */
const chat = {
  FORMAT: 'chat',
  upstreamPath: () => '/chat/completions',
  authHeaders: (key) => ({ authorization: `Bearer ${key}` }),
  requestFromChat: (body, model) => ({ ...body, model }),
  responseToChat: (json) => json,
  createStreamToChat: () => null, // null = 不用转，原样透传
};

/** Anthropic Messages：复用已有的 anthropic-bridge（它本来就是围绕 chat 写的） */
const anthropic = {
  FORMAT: 'anthropic',
  upstreamPath: () => '/messages',
  // Anthropic 用 x-api-key，另外要带版本号
  authHeaders: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
  requestFromChat: (body, model) => chatToAnthropicRequest(body, model),
  responseToChat: (json, model) => anthropicToChatResponse(json, model),
  createStreamToChat: (model) => createAnthropicToChatStream(model),
  // 客户端方向（客户端发 Anthropic、内部转 chat）
  requestToChat: (body, model) => anthropicToChat(body, model),
  responseFromChat: (json, model) => chatToAnthropic(json, model),
  createStreamFromChat: (model) => createChatToAnthropicStream(model),
};

const ADAPTERS = { chat, responses, anthropic, gemini };

export function adapterFor(format) {
  return ADAPTERS[format] || chat;
}

export function knownFormat(format) {
  return Object.hasOwn(ADAPTERS, String(format || ''));
}

/**
 * 一次自定义上游调用。返回原生 WHATWG Response，让 engine 那边的
 * 状态判定 / 头部白名单 / 流式处理完全复用。
 *
 * chatBody 是中枢格式（chat），这里按上游协议翻一次再发。
 */
export async function callUpstreamApi(upstream, { chatBody, model, apiKey, signal, extraHeaders = {} }) {
  const ad = adapterFor(upstream.format);
  const stream = Boolean(chatBody?.stream);
  const body = ad.requestFromChat(chatBody, model);
  const url = upstream.baseUrl + ad.upstreamPath(model, stream);
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: stream ? 'text/event-stream' : 'application/json',
      ...ad.authHeaders(apiKey),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
    signal,
    redirect: 'follow',
  });
}

/**
 * 用一个 key 去问上游"你有哪些模型"。
 *
 * 四种协议的模型列表端点不一样，而且很多第三方中转只实现了 /v1/models，
 * 所以先按协议试它自己的，再退到 OpenAI 那个通用的。
 * 拉不到就返回 null —— 调用方会提示用户手动填模型名。
 */
export async function fetchUpstreamModels(upstream, apiKey, { timeoutMs = 15000 } = {}) {
  const ad = adapterFor(upstream.format);
  const paths = upstream.format === 'gemini' ? ['/models'] : ['/models', '/v1/models'];
  for (const path of paths) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(upstream.baseUrl + path, {
        headers: { accept: 'application/json', ...ad.authHeaders(apiKey) },
        signal: ctrl.signal,
        redirect: 'follow',
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      const ids = extractModelIds(data);
      if (ids.length) return ids;
    } catch {
      /* 换下一个路径 */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** 各家 /models 返回的形状不一样，能认的都认一遍 */
function extractModelIds(data) {
  const out = [];
  // OpenAI: {data:[{id}]}；Anthropic: {data:[{id}]}（同形）
  for (const m of Array.isArray(data?.data) ? data.data : []) {
    const id = m?.id || m?.model || m?.name;
    if (id) out.push(String(id));
  }
  // Gemini: {models:[{name:'models/gemini-x'}]}
  for (const m of Array.isArray(data?.models) ? data.models : []) {
    const raw = m?.name || m?.id;
    if (raw) out.push(String(raw).replace(/^models\//, ''));
  }
  // 有些中转直接返回一个字符串数组
  if (Array.isArray(data) && data.every((x) => typeof x === 'string')) out.push(...data);
  return [...new Set(out.filter(Boolean))];
}

/**
 * 探活一个 key：优先用模型列表（不花钱、不占额度）。
 * 列表拉不到就发一个 1 token 的最小请求 —— 这时才可能产生费用，所以放在后面。
 */
export async function probeUpstreamKey(upstream, apiKey, { model = '', timeoutMs = 20000 } = {}) {
  const ids = await fetchUpstreamModels(upstream, apiKey, { timeoutMs }).catch(() => null);
  if (ids?.length) {
    return { state: 'ok', verdict: '可用', detail: `模型列表拉到 ${ids.length} 个`, httpStatus: 200, models: ids };
  }
  const target = model || (upstream.models || [])[0];
  if (!target) {
    return {
      state: 'unknown',
      verdict: '无法判断',
      detail: '这个上游没有模型列表接口，也还没配模型名 —— 先手动填一个模型再检测',
      httpStatus: 0,
    };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await callUpstreamApi(upstream, {
      chatBody: { messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false },
      model: target,
      apiKey,
      signal: ctrl.signal,
    });
    const text = await resp.text();
    if (resp.ok) {
      return { state: 'ok', verdict: '可用', detail: `用 ${target} 实测通过`, httpStatus: 200 };
    }
    return {
      state: classifyUpstreamFailure(resp.status, text),
      verdict: resp.status === 401 || resp.status === 403 ? 'key 无效' : '上游拒绝',
      detail: `HTTP ${resp.status}：${String(text).slice(0, 160)}`,
      httpStatus: resp.status,
    };
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

/**
 * 上游失败归类。第三方中转的错误信封五花八门，所以状态码为主、正文为辅。
 * 这些状态名要和 engine 的 FAILURE_TEXT / eligibleAccounts 的 dead 集合对得上。
 */
export function classifyUpstreamFailure(status, text) {
  const t = String(text || '');
  if (status === 401) return 'token_invalid';
  if (status === 403) {
    if (/region|country|location|unsupported_country/i.test(t)) return 'country_blocked';
    return 'blocked';
  }
  if (status === 429) {
    // 余额耗尽和限速都可能走 429，但前者换号才有用，后者等一会儿就好
    if (/insufficient|balance|quota|credit|billing|exceeded your current/i.test(t)) return 'no_credit';
    return 'rate_limited';
  }
  if (status === 402) return 'no_credit';
  if (/insufficient|balance|credit|billing/i.test(t)) return 'no_credit';
  return 'upstream_error';
}
