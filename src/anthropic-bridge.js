// Anthropic ↔ OpenAI Chat Completions 双向转换。
//
// 为什么需要它：opencode Zen 是**按模型**钉死协议的，不是按端点。
// 实测（2026-08-20）把 mimo-v2.5-free 这种 chat 原生模型 POST 到 /v1/messages
// 或 /v1/responses，一律回 400 `Input required: specify "prompt" or "messages"` ——
// Zen 只是照客户端选的端点解析 body，然后原样转给上游厂商，格式不对就炸在那边。
// 而 Zen 的免费模型全是 chat 原生的，Anthropic 客户端（Claude Code 这类）
// 想用它们，只能在网关这一层把协议翻过去再翻回来。
//
// 覆盖范围：文本、system、多轮、tools / tool_use / tool_result、stop 原因、usage、
// 流式。不做 PDF / 图片以外的多模态（上游那些免费模型本身也不支持）。
import { randomId } from './util.js';

const STOP_REASON = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'end_turn',
};

/** Anthropic 的 content 可以是字符串，也可以是块数组；取其中的纯文本 */
function blocksToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

/** Anthropic messages[] → OpenAI messages[]（tool_use/tool_result 也一起翻） */
function convertMessages(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const blocks = Array.isArray(m.content) ? m.content : null;

    if (m.role === 'assistant') {
      const text = blocksToText(m.content);
      const toolCalls = (blocks || [])
        .filter((b) => b?.type === 'tool_use')
        .map((b) => ({
          id: String(b.id || `call_${randomId(8)}`),
          type: 'function',
          function: { name: String(b.name || ''), arguments: JSON.stringify(b.input ?? {}) },
        }));
      const msg = { role: 'assistant', content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      // 既没文字也没工具调用的空回合直接丢掉，别给上游一条 content:null 的裸消息
      if (msg.content || msg.tool_calls) out.push(msg);
      continue;
    }

    // user：tool_result 在 OpenAI 侧是独立的 role:'tool' 消息，必须拆出来
    const results = (blocks || []).filter((b) => b?.type === 'tool_result');
    for (const r of results) {
      out.push({
        role: 'tool',
        tool_call_id: String(r.tool_use_id || ''),
        content: typeof r.content === 'string' ? r.content : blocksToText(r.content) || JSON.stringify(r.content ?? ''),
      });
    }
    const text = blocksToText(m.content);
    if (text || !results.length) out.push({ role: 'user', content: text });
  }
  return out;
}

/** Anthropic /v1/messages 请求体 → OpenAI /v1/chat/completions 请求体 */
export function anthropicToChat(body, model) {
  const messages = convertMessages(body?.messages);
  const system = blocksToText(body?.system);
  if (system) messages.unshift({ role: 'system', content: system });

  const out = { model, messages };
  if (Number.isFinite(body?.max_tokens)) out.max_tokens = body.max_tokens;
  if (Number.isFinite(body?.temperature)) out.temperature = body.temperature;
  if (Number.isFinite(body?.top_p)) out.top_p = body.top_p;
  if (Array.isArray(body?.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;
  if (body?.stream) out.stream = true;

  if (Array.isArray(body?.tools) && body.tools.length) {
    out.tools = body.tools
      .filter((t) => t?.name)
      .map((t) => ({
        type: 'function',
        function: { name: String(t.name), description: t.description || '', parameters: t.input_schema || { type: 'object' } },
      }));
  }
  const tc = body?.tool_choice;
  if (tc?.type === 'auto') out.tool_choice = 'auto';
  else if (tc?.type === 'any') out.tool_choice = 'required';
  else if (tc?.type === 'tool' && tc.name) out.tool_choice = { type: 'function', function: { name: String(tc.name) } };
  return out;
}

function usageToAnthropic(u) {
  const det = u?.prompt_tokens_details || {};
  return {
    input_tokens: u?.prompt_tokens ?? 0,
    output_tokens: u?.completion_tokens ?? 0,
    cache_creation_input_tokens: det.cache_write_tokens ?? 0,
    cache_read_input_tokens: det.cached_tokens ?? 0,
  };
}

/** OpenAI chat 的一整段响应 → Anthropic message 对象 */
export function chatToAnthropic(json, model) {
  // 上游有可能 HTTP 200 但正文是错误（实测 nemotron 出现过），原样带上错误信封
  if (json?.error) {
    return { type: 'error', error: { type: json.error.type || 'api_error', message: json.error.message || '上游返回错误' } };
  }
  const choice = json?.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  const text = typeof msg.content === 'string' ? msg.content : blocksToText(msg.content);
  if (text) content.push({ type: 'text', text });
  for (const call of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
    let input = {};
    try {
      input = JSON.parse(call?.function?.arguments || '{}');
    } catch {
      input = { _raw: String(call?.function?.arguments || '') };
    }
    content.push({ type: 'tool_use', id: String(call?.id || `toolu_${randomId(8)}`), name: String(call?.function?.name || ''), input });
  }
  // Anthropic 规范里 content 不能是空数组，补一个空文本块
  if (!content.length) content.push({ type: 'text', text: '' });
  return {
    id: 'msg_' + String(json?.id || randomId(12)).replace(/[^A-Za-z0-9]/g, ''),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: STOP_REASON[choice.finish_reason] || 'end_turn',
    stop_sequence: null,
    usage: usageToAnthropic(json?.usage),
  };
}

/** Anthropic /v1/messages/count_tokens 的粗略回答（上游没有这个接口） */
export function countTokensReply(body) {
  const parts = [blocksToText(body?.system)];
  for (const m of Array.isArray(body?.messages) ? body.messages : []) parts.push(blocksToText(m?.content));
  const text = parts.filter(Boolean).join('\n');
  let ascii = 0;
  let wide = 0;
  for (const ch of text) (ch.codePointAt(0) < 128 ? ascii++ : wide++);
  return { input_tokens: Math.max(1, Math.round(ascii / 4 + wide)) };
}

// ─────────────────────────── 反方向：OpenAI chat → Anthropic
//
// Zen 上 claude-* / qwen* 是 Anthropic 原生的，只认 /messages。
// 所以 OpenAI 客户端想用它们，得把请求翻过去、响应翻回来 —— 和上面正好对称。

const FINISH_REASON = { end_turn: 'stop', max_tokens: 'length', tool_use: 'tool_calls', stop_sequence: 'stop' };

/** OpenAI messages[] → { system, messages }（Anthropic 的 system 是顶层字段） */
function splitSystem(messages) {
  const sys = [];
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    if (m.role === 'system' || m.role === 'developer') {
      sys.push(typeof m.content === 'string' ? m.content : blocksToText(m.content));
      continue;
    }
    if (m.role === 'tool') {
      // 连续的 tool 结果要合进同一条 user 消息里（Anthropic 要求这样）
      const block = { type: 'tool_result', tool_use_id: String(m.tool_call_id || ''), content: String(m.content ?? '') };
      const prev = out[out.length - 1];
      if (prev?.role === 'user' && Array.isArray(prev.content) && prev.content.every((b) => b.type === 'tool_result')) {
        prev.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = [];
      const text = typeof m.content === 'string' ? m.content : blocksToText(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const call of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        let input = {};
        try {
          input = JSON.parse(call?.function?.arguments || '{}');
        } catch {
          input = {};
        }
        blocks.push({ type: 'tool_use', id: String(call?.id || `toolu_${randomId(8)}`), name: String(call?.function?.name || ''), input });
      }
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
      continue;
    }
    const text = typeof m.content === 'string' ? m.content : blocksToText(m.content);
    out.push({ role: 'user', content: text });
  }
  return { system: sys.join('\n\n'), messages: out };
}

/** OpenAI /v1/chat/completions 请求体 → Anthropic /v1/messages 请求体 */
export function chatToAnthropicRequest(body, model) {
  const { system, messages } = splitSystem(body?.messages);
  // Anthropic 的 max_tokens 是必填的，客户端没给就补一个够用的默认值
  const out = { model, max_tokens: Number.isFinite(body?.max_tokens) ? body.max_tokens : 4096, messages };
  if (system) out.system = system;
  if (Number.isFinite(body?.temperature)) out.temperature = body.temperature;
  if (Number.isFinite(body?.top_p)) out.top_p = body.top_p;
  if (body?.stream) out.stream = true;
  const stop = typeof body?.stop === 'string' ? [body.stop] : Array.isArray(body?.stop) ? body.stop : null;
  if (stop?.length) out.stop_sequences = stop;
  if (Array.isArray(body?.tools) && body.tools.length) {
    out.tools = body.tools
      .filter((t) => t?.function?.name)
      .map((t) => ({ name: String(t.function.name), description: t.function.description || '', input_schema: t.function.parameters || { type: 'object' } }));
  }
  const tc = body?.tool_choice;
  if (tc === 'auto') out.tool_choice = { type: 'auto' };
  else if (tc === 'required') out.tool_choice = { type: 'any' };
  else if (tc?.function?.name) out.tool_choice = { type: 'tool', name: String(tc.function.name) };
  return out;
}

/** Anthropic message 对象 → OpenAI chat 响应 */
export function anthropicToChatResponse(json, model) {
  if (json?.type === 'error' || json?.error) {
    return { error: { message: json.error?.message || '上游返回错误', type: json.error?.type || 'api_error' } };
  }
  const blocks = Array.isArray(json?.content) ? json.content : [];
  const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('');
  const toolCalls = blocks
    .filter((b) => b?.type === 'tool_use')
    .map((b) => ({ id: String(b.id || `call_${randomId(8)}`), type: 'function', function: { name: String(b.name || ''), arguments: JSON.stringify(b.input ?? {}) } }));
  const message = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const u = json?.usage || {};
  return {
    id: String(json?.id || `chatcmpl-${randomId(8)}`),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: FINISH_REASON[json?.stop_reason] || 'stop', logprobs: null }],
    usage: {
      prompt_tokens: u.input_tokens ?? 0,
      completion_tokens: u.output_tokens ?? 0,
      total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
      prompt_tokens_details: { cached_tokens: u.cache_read_input_tokens ?? 0, cache_write_tokens: u.cache_creation_input_tokens ?? 0 },
    },
  };
}
//
// Anthropic 的事件顺序是有状态的：message_start → (content_block_start →
// content_block_delta* → content_block_stop)* → message_delta → message_stop。
// OpenAI 那边是一串扁平的 delta，所以这里要自己维护"现在开到第几个块、是文本还是工具"。

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createChatToAnthropicStream(model) {
  let started = false;
  let textOpen = false;
  let index = 0;
  const tools = new Map(); // openai 的 tool_call index -> { blockIndex, id, name }
  let stopReason = 'end_turn';
  let usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  let messageId = 'msg_' + randomId(12);
  let buffer = '';
  let finished = false;

  const startMessage = () => {
    if (started) return '';
    started = true;
    return sse('message_start', {
      type: 'message_start',
      message: { id: messageId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage },
    });
  };

  const closeOpenBlocks = () => {
    let out = '';
    if (textOpen) {
      out += sse('content_block_stop', { type: 'content_block_stop', index: 0 });
      textOpen = false;
    }
    for (const t of tools.values()) {
      out += sse('content_block_stop', { type: 'content_block_stop', index: t.blockIndex });
    }
    tools.clear();
    return out;
  };

  /** 处理一个 OpenAI chunk 对象，返回要写出去的 Anthropic 事件文本 */
  const handle = (json) => {
    let out = '';
    if (json?.error) {
      // 上游中途报错：按 Anthropic 的 error 事件发出去，客户端才知道这条流废了
      return sse('error', { type: 'error', error: { type: json.error.type || 'api_error', message: json.error.message || '上游错误' } });
    }
    if (json?.id && !started) messageId = 'msg_' + String(json.id).replace(/[^A-Za-z0-9]/g, '');
    if (json?.usage) usage = usageToAnthropic(json.usage);
    out += startMessage();

    const choice = json?.choices?.[0];
    if (!choice) return out;
    const delta = choice.delta || {};

    if (typeof delta.content === 'string' && delta.content) {
      if (!textOpen) {
        out += sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        textOpen = true;
        index = Math.max(index, 1);
      }
      out += sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta.content } });
    }

    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const key = call?.index ?? 0;
      let t = tools.get(key);
      if (!t) {
        t = { blockIndex: index++, id: String(call?.id || `toolu_${randomId(8)}`), name: String(call?.function?.name || '') };
        tools.set(key, t);
        out += sse('content_block_start', {
          type: 'content_block_start',
          index: t.blockIndex,
          content_block: { type: 'tool_use', id: t.id, name: t.name, input: {} },
        });
      }
      const frag = call?.function?.arguments;
      if (typeof frag === 'string' && frag) {
        out += sse('content_block_delta', {
          type: 'content_block_delta',
          index: t.blockIndex,
          delta: { type: 'input_json_delta', partial_json: frag },
        });
      }
    }

    if (choice.finish_reason) stopReason = STOP_REASON[choice.finish_reason] || 'end_turn';
    return out;
  };

  return {
    /** 喂一段上游原始 SSE 文本，返回转换后的 Anthropic SSE 文本 */
    push(chunk) {
      if (finished) return '';
      buffer += chunk;
      let out = '';
      // 逐行处理：只认 `data: ` 行，注释行（`: keep-alive`）和空行都跳过
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') {
          out += this.flush();
          return out;
        }
        try {
          out += handle(JSON.parse(payload));
        } catch {
          /* 半截 JSON 或上游杂帧，跳过 */
        }
      }
      return out;
    },
    flush() {
      if (finished) return '';
      finished = true;
      let out = startMessage();
      out += closeOpenBlocks();
      out += sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: usage.output_tokens },
      });
      out += sse('message_stop', { type: 'message_stop' });
      return out;
    },
  };
}

// ─────────────────────────── 流式反方向：Anthropic 事件 → OpenAI chunk
//
// Anthropic 那边是有状态的事件流，OpenAI 是扁平 delta，所以这次是「拆状态」：
// content_block_delta 里的 text_delta 直接变成 delta.content；
// tool_use 块要攒出 tool_calls 的 index / id / name / arguments 分片。

export function createAnthropicToChatStream(model) {
  const id = `chatcmpl-${randomId(8)}`;
  const created = Math.floor(Date.now() / 1000);
  let buffer = '';
  let finished = false;
  let sentRole = false;
  let usage = null;
  // Anthropic 的 block index 是全局的，OpenAI 的 tool_calls index 只数工具，要单独映射
  const toolIndex = new Map();
  let nextTool = 0;

  const chunk = (delta, finishReason = null, extra = {}) =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...extra,
    })}\n\n`;

  const handle = (event, data) => {
    let out = '';
    if (event === 'error' || data?.type === 'error') {
      return `data: ${JSON.stringify({ error: { message: data?.error?.message || '上游错误', type: data?.error?.type || 'api_error' } })}\n\n`;
    }
    if (data?.type === 'message_start') {
      const u = data.message?.usage;
      if (u) usage = u;
      return '';
    }
    if (data?.type === 'content_block_start') {
      const b = data.content_block || {};
      if (b.type === 'tool_use') {
        const idx = nextTool++;
        toolIndex.set(data.index, idx);
        const delta = { tool_calls: [{ index: idx, id: String(b.id || ''), type: 'function', function: { name: String(b.name || ''), arguments: '' } }] };
        if (!sentRole) {
          delta.role = 'assistant';
          sentRole = true;
        }
        out += chunk(delta);
      }
      return out;
    }
    if (data?.type === 'content_block_delta') {
      const d = data.delta || {};
      if (d.type === 'text_delta' && d.text) {
        const delta = { content: d.text };
        if (!sentRole) {
          delta.role = 'assistant';
          sentRole = true;
        }
        out += chunk(delta);
      } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
        const idx = toolIndex.get(data.index) ?? 0;
        out += chunk({ tool_calls: [{ index: idx, function: { arguments: d.partial_json } }] });
      }
      return out;
    }
    if (data?.type === 'message_delta') {
      if (data.usage) usage = { ...(usage || {}), ...data.usage };
      out += chunk({}, FINISH_REASON[data.delta?.stop_reason] || 'stop');
      return out;
    }
    return out;
  };

  return {
    push(text) {
      if (finished) return '';
      buffer += text;
      let out = '';
      let event = '';
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('event:')) {
          event = line.slice(6).trim();
          continue;
        }
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          out += handle(event, JSON.parse(payload));
        } catch {
          /* 半截 JSON，跳过 */
        }
      }
      return out;
    },
    flush() {
      if (finished) return '';
      finished = true;
      let out = '';
      // usage 用 OpenAI 的形状补一帧（很多客户端靠最后这帧统计 token）
      if (usage) {
        out += `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [],
          usage: {
            prompt_tokens: usage.input_tokens ?? 0,
            completion_tokens: usage.output_tokens ?? 0,
            total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
          },
        })}\n\n`;
      }
      return out + 'data: [DONE]\n\n';
    },
  };
}
