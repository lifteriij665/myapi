// Google Gemini 原生 generateContent 适配器（只做上游侧：canonical → Gemini → canonical）。
//
// 为什么单独一层：网关内部一律用 OpenAI Chat Completions 当中枢格式，而 Gemini 那套
// 既不是同一个 body 形状，也不是同一套语义 —— 没有 system 角色、没有 tool_call_id、
// 要求 user/model 严格交替、JSON-Schema 只吃 OpenAPI 子集。这些差异全部在这里吸收掉，
// engine 那边只管拿 canonical 进、canonical 出。
//
// 反方向（对外提供 Gemini 协议给客户端）故意不做：本网关只对外说 OpenAI / Anthropic。
import { randomId } from '../util.js';

export const FORMAT = 'gemini';

const FINISH_REASON = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
  PROHIBITED_CONTENT: 'content_filter',
  BLOCKLIST: 'content_filter',
  SPII: 'content_filter',
  OTHER: 'stop',
};

/** canonical 的 content 可能是字符串，也可能是 OpenAI 的多模态块数组；只取纯文本 */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => (b?.type === 'text' || b?.type === undefined) && typeof b?.text === 'string')
    .map((b) => b.text)
    .join('');
}

function parseArgs(raw) {
  try {
    const v = JSON.parse(raw || '{}');
    // args 必须是对象；上游模型偶尔吐个裸字符串/数组，那就当空参数，别把 400 攒到 Gemini 那边
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** functionResponse.response 必须是 JSON 对象；工具输出常常是裸字符串，得包一层 */
function toResponseObject(content) {
  if (content && typeof content === 'object' && !Array.isArray(content)) return content;
  const raw = typeof content === 'string' ? content : textOf(content);
  if (raw) {
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
      return { result: v };
    } catch {
      /* 不是 JSON，走下面的裸字符串分支 */
    }
  }
  return { result: raw };
}

// Gemini 的 parameters 走的是 OpenAPI 3.0 的 Schema 子集，见到 JSON-Schema 专有关键字
// 会整条请求 400（Unknown name "$schema" / "additionalProperties"），而绝大多数客户端
// 的 tool 定义都是 zod / pydantic 直接导出的完整 JSON-Schema。所以递归洗一遍。
// 空的 properties:{} 也要删：Gemini 对 type:OBJECT 且字段表为空的 schema 同样拒收。
const DROP_KEYS = new Set(['$schema', 'additionalProperties', 'default']);

function sanitizeSchema(node) {
  if (Array.isArray(node)) return node.map(sanitizeSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (DROP_KEYS.has(k)) continue;
    if (k === 'properties') {
      // properties 的键是字段名，不能拿关键字表去筛（真有参数就叫 default 的）
      const props = {};
      for (const [name, sub] of Object.entries(v && typeof v === 'object' ? v : {})) props[name] = sanitizeSchema(sub);
      if (Object.keys(props).length) out.properties = props;
      continue;
    }
    out[k] = sanitizeSchema(v);
  }
  return out;
}

/** Gemini 没有 tool_call_id，canonical 侧需要一个稳定 id 才能把结果配回去 */
function callId(name, index) {
  return `call_${String(name || 'fn').replace(/[^A-Za-z0-9_]/g, '_')}_${index}`;
}

/** 模型名在 URL 里，不在 body 里；stream 必须显式要 alt=sse，否则 Gemini 回的是 JSON 数组流 */
export function upstreamPath(model, stream) {
  const name = String(model || '').replace(/^models\//, '');
  return `/models/${name}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
}

export function authHeaders(apiKey) {
  return { 'x-goog-api-key': String(apiKey || '') };
}

/** canonical chat 请求体 → Gemini generateContent 请求体（model 不进 body，Gemini 见到未知字段会 400） */
export function requestFromChat(chatBody, model) {
  const messages = Array.isArray(chatBody?.messages) ? chatBody.messages : [];
  const sys = [];
  const contents = [];
  const names = new Map(); // tool_call_id → 函数名，给后面的 role:'tool' 找名字用
  let lastName = '';

  // Gemini 严格交替 user/model，连续同角色会被拒；合成一条多 parts 的 content
  const add = (role, parts) => {
    if (!parts.length) return;
    const prev = contents[contents.length - 1];
    if (prev && prev.role === role) prev.parts.push(...parts);
    else contents.push({ role, parts });
  };

  for (const m of messages) {
    if (!m) continue;

    if (m.role === 'system' || m.role === 'developer') {
      // Gemini 没有 system 角色，只有顶层的 systemInstruction
      const t = textOf(m.content);
      if (t) sys.push(t);
      continue;
    }

    if (m.role === 'tool') {
      // 工具结果在 Gemini 侧是一条 user 消息里的 functionResponse，靠函数名而不是 id 对齐
      const name = names.get(String(m.tool_call_id ?? '')) || lastName;
      add('user', [{ functionResponse: { name: String(name || ''), response: toResponseObject(m.content) } }]);
      continue;
    }

    if (m.role === 'assistant') {
      const parts = [];
      const t = textOf(m.content);
      if (t) parts.push({ text: t });
      for (const call of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        const name = String(call?.function?.name || '');
        names.set(String(call?.id ?? ''), name);
        lastName = name;
        parts.push({ functionCall: { name, args: parseArgs(call?.function?.arguments) } });
      }
      add('model', parts);
      continue;
    }

    const t = textOf(m.content);
    add('user', t ? [{ text: t }] : []);
  }

  // contents 不能是空数组，兜一条空 user，让上游报模型层面的错而不是格式错
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: '' }] });

  const out = { contents };
  if (sys.length) out.systemInstruction = { parts: [{ text: sys.join('\n\n') }] };

  const gen = {};
  if (Number.isFinite(chatBody?.max_tokens)) gen.maxOutputTokens = chatBody.max_tokens;
  else if (Number.isFinite(chatBody?.max_completion_tokens)) gen.maxOutputTokens = chatBody.max_completion_tokens;
  if (Number.isFinite(chatBody?.temperature)) gen.temperature = chatBody.temperature;
  if (Number.isFinite(chatBody?.top_p)) gen.topP = chatBody.top_p;
  const stop = typeof chatBody?.stop === 'string' ? [chatBody.stop] : Array.isArray(chatBody?.stop) ? chatBody.stop : null;
  // Gemini 最多收 5 条停止序列，多了整条请求 400
  if (stop?.length) gen.stopSequences = stop.filter((s) => typeof s === 'string' && s).slice(0, 5);
  if (Object.keys(gen).length) out.generationConfig = gen;

  const decls = (Array.isArray(chatBody?.tools) ? chatBody.tools : [])
    .filter((t) => t?.function?.name)
    .map((t) => {
      const d = { name: String(t.function.name) };
      if (t.function.description) d.description = String(t.function.description);
      d.parameters = sanitizeSchema(t.function.parameters || { type: 'object' });
      return d;
    });
  if (decls.length) {
    out.tools = [{ functionDeclarations: decls }];
    // toolConfig 只在有工具时才给，否则 Gemini 会抱怨配置了工具策略却没有工具
    const tc = chatBody?.tool_choice;
    if (tc === 'none') out.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
    else if (tc === 'required' || tc === 'any') out.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
    else if (tc?.function?.name)
      out.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [String(tc.function.name)] } };
    else if (tc === 'auto') out.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  }
  return out;
}

function usageToChat(u) {
  const prompt = u?.promptTokenCount ?? 0;
  const completion = u?.candidatesTokenCount ?? 0;
  const out = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: u?.totalTokenCount ?? prompt + completion,
  };
  if (Number.isFinite(u?.cachedContentTokenCount)) out.prompt_tokens_details = { cached_tokens: u.cachedContentTokenCount };
  return out;
}

/** parts[] → { text, tool_calls[] } */
function partsToMessage(parts) {
  const list = Array.isArray(parts) ? parts : [];
  const text = list
    .filter((p) => typeof p?.text === 'string')
    .map((p) => p.text)
    .join('');
  const toolCalls = list
    .filter((p) => p?.functionCall)
    .map((p, i) => ({
      id: callId(p.functionCall.name, i),
      type: 'function',
      function: { name: String(p.functionCall.name || ''), arguments: JSON.stringify(p.functionCall.args ?? {}) },
    }));
  return { text, toolCalls };
}

/** Gemini 的一整段响应 → canonical chat 响应 */
export function responseToChat(json, model) {
  if (json?.error) {
    const e = json.error;
    const out = { error: { message: e.message || '上游返回错误', type: e.status || 'api_error' } };
    if (Number.isFinite(e.code)) out.error.code = e.code;
    return out;
  }

  const cand = json?.candidates?.[0] || null;
  const { text, toolCalls } = partsToMessage(cand?.content?.parts);
  const message = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;

  // 提示词被安全策略拦掉时整个 candidates 都是空的，只有 promptFeedback；
  // 这里必须回一条合法的 canonical 响应，不然客户端看到的是网关 500
  const blocked = json?.promptFeedback?.blockReason;
  let finish = toolCalls.length ? 'tool_calls' : FINISH_REASON[cand?.finishReason] || 'stop';
  if (!cand && blocked) finish = 'content_filter';

  return {
    id: json?.responseId ? `chatcmpl-${String(json.responseId).replace(/[^A-Za-z0-9]/g, '')}` : `chatcmpl-${randomId(8)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish, logprobs: null }],
    usage: usageToChat(json?.usageMetadata),
  };
}

// ─────────────────────────── 流式：Gemini SSE → canonical SSE
//
// Gemini 的 ?alt=sse 只有裸的 `data: {...}` 行：没有 event: 行，也没有 [DONE] 收尾，
// 每帧都是一个部分 GenerateContentResponse。所以「结束」这件事只能由 flush() 负责 ——
// 最后那帧 finish_reason、usage 帧、[DONE] 全在 flush 里补。
//
// 逐行解析而不是拿正则去切整个 buffer：之前跨行正则的写法会把事件之间的空行吃掉，
// 导致所有 SSE 客户端都读不出帧边界。分片可能落在任意字节位置，半行必须留在 buffer 里。

export function createStreamToChat(model) {
  const id = `chatcmpl-${randomId(8)}`;
  const created = Math.floor(Date.now() / 1000);
  let buffer = '';
  let finished = false;
  let sentRole = false;
  let usage = null;
  let finishReason = 'stop';
  let sawTool = false;
  let toolIndex = 0;

  const chunk = (delta, reason = null, extra = {}) =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: reason }],
      ...extra,
    })}\n\n`;

  const withRole = (delta) => {
    if (!sentRole) {
      sentRole = true;
      return { role: 'assistant', ...delta };
    }
    return delta;
  };

  const handle = (json) => {
    if (json?.error) {
      // 流中途报错：照 canonical 的错误信封发一帧，客户端才知道这条流废了
      return `data: ${JSON.stringify({ error: { message: json.error.message || '上游错误', type: json.error.status || 'api_error' } })}\n\n`;
    }
    // usageMetadata 是累计值，后面的帧覆盖前面的，最后一帧就是总数
    if (json?.usageMetadata) usage = json.usageMetadata;
    if (json?.promptFeedback?.blockReason) finishReason = 'content_filter';

    let out = '';
    const cand = json?.candidates?.[0];
    if (!cand) return out;

    for (const p of Array.isArray(cand.content?.parts) ? cand.content.parts : []) {
      if (typeof p?.text === 'string' && p.text) {
        out += chunk(withRole({ content: p.text }));
      } else if (p?.functionCall) {
        // Gemini 不切分参数，一次给整个 functionCall；所以 arguments 一帧发全
        sawTool = true;
        const name = String(p.functionCall.name || '');
        const index = toolIndex++;
        out += chunk(
          withRole({
            tool_calls: [
              {
                index,
                id: callId(name, index),
                type: 'function',
                function: { name, arguments: JSON.stringify(p.functionCall.args ?? {}) },
              },
            ],
          })
        );
      }
    }

    if (cand.finishReason) finishReason = FINISH_REASON[cand.finishReason] || 'stop';
    return out;
  };

  return {
    /** 喂一段上游原始 SSE 文本，返回转换后的 canonical SSE 文本 */
    push(text) {
      if (finished) return '';
      buffer += text;
      let out = '';
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        // 只认 data: 行；注释行（`: keep-alive`）和帧之间的空行都直接跳过
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        // 原生 Gemini 不发 [DONE]，但中间可能有代理补一个；收尾统一交给 flush，别提前发
        if (!payload || payload === '[DONE]') continue;
        try {
          out += handle(JSON.parse(payload));
        } catch {
          /* 半截 JSON 或杂帧，跳过 */
        }
      }
      return out;
    },
    flush() {
      if (finished) return '';
      finished = true;
      let out = chunk({}, sawTool ? 'tool_calls' : finishReason);
      if (usage) out += `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: usageToChat(usage) })}\n\n`;
      return out + 'data: [DONE]\n\n';
    },
  };
}
