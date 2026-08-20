// OpenAI Responses ↔ Chat Completions 双向转换。
//
// 为什么需要它：网关内部一律以 chat 作为中枢格式（门禁、日志、用量统计都读 chat 的
// 字段），但上游有一批模型是 Responses 原生的 —— Zen 上 gpt-* / grok-* / muse-*
// 只认 /v1/responses，按 chat 格式发过去会被上游厂商直接打回（见 models-opencode.js
// 里 nativeProtocol 的说明）。所以这一层要把 Responses 的 input/output 项目流翻成
// chat 的 messages/choices，再翻回去。
//
// 两个方向都要，因为「客户端说什么协议」和「上游要什么协议」是两件独立的事：
//   requestFromChat / responseToChat / createStreamToChat —— 上游是 Responses 原生
//   requestToChat / responseFromChat / createStreamFromChat —— 客户端发的是 Responses
//
// 覆盖范围：文本、instructions、多轮、function_call / function_call_output、
// 截断原因、usage、流式。不做图片和内置工具（web_search 那些没有 chat 对应物）。
import { randomId } from '../util.js';

export const FORMAT = 'responses';

/** 参数留着是为了和别的协议适配器同签名（有的协议流式和非流式不是一个端点） */
export function upstreamPath(model, stream) {
  return '/responses';
}

export function authHeaders(apiKey) {
  return { authorization: `Bearer ${apiKey}` };
}

/** chat 的 content 可以是字符串，也可以是 parts 数组；只取纯文本 */
function chatText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p) => typeof p?.text === 'string')
    .map((p) => p.text)
    .join('');
}

/** Responses 的 content 同理，input_text（用户侧）和 output_text（模型侧）都是文本 */
function itemText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p) => (p?.type === 'input_text' || p?.type === 'output_text' || p?.type === 'text') && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
}

/** output[] 里所有 message 项的文本拼起来 */
function outputText(output) {
  return (Array.isArray(output) ? output : [])
    .filter((i) => i?.type === 'message' || i?.role === 'assistant')
    .map((i) => itemText(i.content))
    .join('');
}

/** tool_calls 的 arguments 必须是字符串，上游/客户端偶尔直接给对象 */
function argsString(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value ?? {});
}

/**
 * Responses 的结束状态 → chat 的 finish_reason。
 * 截断优先于工具调用：正好在工具参数中间被 max_output_tokens 砍断时，
 * 客户端更需要知道"这条是残的"，报 tool_calls 会让它拿半截 JSON 去解析。
 */
function finishReasonOf(resp) {
  if (resp?.status === 'incomplete') {
    return resp?.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'stop';
  }
  const output = Array.isArray(resp?.output) ? resp.output : [];
  if (output.some((i) => i?.type === 'function_call')) return 'tool_calls';
  return 'stop';
}

function usageToChat(u) {
  const input = u?.input_tokens ?? 0;
  const output = u?.output_tokens ?? 0;
  const out = { prompt_tokens: input, completion_tokens: output, total_tokens: u?.total_tokens ?? input + output };
  const cached = u?.input_tokens_details?.cached_tokens;
  if (cached != null) out.prompt_tokens_details = { cached_tokens: cached };
  return out;
}

function usageFromChat(u) {
  const input = u?.prompt_tokens ?? 0;
  const output = u?.completion_tokens ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: u?.total_tokens ?? input + output,
    input_tokens_details: { cached_tokens: u?.prompt_tokens_details?.cached_tokens ?? 0 },
  };
}

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ─────────────────────────── 请求：chat → Responses

/** canonical chat 请求体 → /v1/responses 请求体 */
export function requestFromChat(chatBody, model) {
  const instructions = [];
  const input = [];

  for (const m of Array.isArray(chatBody?.messages) ? chatBody.messages : []) {
    if (!m) continue;

    if (m.role === 'system' || m.role === 'developer') {
      // Responses 把 system 提到了顶层 instructions，不在 input 列表里
      const text = chatText(m.content);
      if (text) instructions.push(text);
      continue;
    }

    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: String(m.tool_call_id || ''),
        output: typeof m.content === 'string' ? m.content : chatText(m.content),
      });
      continue;
    }

    if (m.role === 'assistant') {
      // chat 的一条 assistant 消息在 Responses 里会拆成「文本项 + 若干 function_call 项」
      const text = chatText(m.content);
      if (text) input.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
      for (const call of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        input.push({
          type: 'function_call',
          call_id: String(call?.id || `call_${randomId(8)}`),
          name: String(call?.function?.name || ''),
          arguments: argsString(call?.function?.arguments),
        });
      }
      continue;
    }

    input.push({ role: 'user', content: [{ type: 'input_text', text: chatText(m.content) }] });
  }

  const out = { model, input };
  if (instructions.length) out.instructions = instructions.join('\n\n');
  if (Number.isFinite(chatBody?.max_tokens)) out.max_output_tokens = chatBody.max_tokens;
  if (Number.isFinite(chatBody?.temperature)) out.temperature = chatBody.temperature;
  if (Number.isFinite(chatBody?.top_p)) out.top_p = chatBody.top_p;
  if (chatBody?.stream) out.stream = true;
  // stop / stop_sequences 在 Responses 里没有对应参数，只能丢掉（带过去是 400）

  if (Array.isArray(chatBody?.tools) && chatBody.tools.length) {
    // Responses 的 tool 是扁的：没有嵌套的 function 对象
    out.tools = chatBody.tools
      .filter((t) => (t?.function || t)?.name)
      .map((t) => {
        const f = t.function || t;
        return { type: 'function', name: String(f.name), description: f.description || '', parameters: f.parameters || { type: 'object' } };
      });
  }

  const tc = chatBody?.tool_choice;
  if (tc === 'auto' || tc === 'required' || tc === 'none') out.tool_choice = tc;
  else if (tc?.function?.name) out.tool_choice = { type: 'function', name: String(tc.function.name) };
  else if (tc?.type === 'function' && tc.name) out.tool_choice = { type: 'function', name: String(tc.name) };
  return out;
}

/** /v1/responses 请求体 → canonical chat 请求体（客户端发的是 Responses 格式） */
export function requestToChat(clientBody, model) {
  const messages = [];
  const instructions = typeof clientBody?.instructions === 'string' ? clientBody.instructions : '';
  if (instructions) messages.push({ role: 'system', content: instructions });

  const raw = clientBody?.input;
  const items = typeof raw === 'string' ? [{ role: 'user', content: [{ type: 'input_text', text: raw }] }] : Array.isArray(raw) ? raw : [];

  for (const it of items) {
    if (!it) continue;

    if (it.type === 'function_call') {
      const call = {
        id: String(it.call_id || it.id || `call_${randomId(8)}`),
        type: 'function',
        function: { name: String(it.name || ''), arguments: argsString(it.arguments) },
      };
      // 紧挨着前一条 assistant 文本的 function_call，在 chat 里属于同一条消息
      const prev = messages[messages.length - 1];
      if (prev?.role === 'assistant') {
        if (!prev.tool_calls) prev.tool_calls = [];
        prev.tool_calls.push(call);
      } else {
        messages.push({ role: 'assistant', content: null, tool_calls: [call] });
      }
      continue;
    }

    if (it.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: String(it.call_id || ''),
        content: typeof it.output === 'string' ? it.output : JSON.stringify(it.output ?? ''),
      });
      continue;
    }

    const text = itemText(it.content);
    if (it.role === 'assistant') messages.push({ role: 'assistant', content: text });
    else if (it.role === 'system' || it.role === 'developer') messages.push({ role: 'system', content: text });
    else messages.push({ role: 'user', content: text });
  }

  const out = { model, messages };
  if (Number.isFinite(clientBody?.max_output_tokens)) out.max_tokens = clientBody.max_output_tokens;
  if (Number.isFinite(clientBody?.temperature)) out.temperature = clientBody.temperature;
  if (Number.isFinite(clientBody?.top_p)) out.top_p = clientBody.top_p;
  if (clientBody?.stream) out.stream = true;
  // previous_response_id 是 Responses 独有的服务端会话，chat 这边无状态，只能忽略

  if (Array.isArray(clientBody?.tools) && clientBody.tools.length) {
    out.tools = clientBody.tools
      .filter((t) => (t?.function || t)?.name)
      .map((t) => {
        const f = t.function || t;
        return { type: 'function', function: { name: String(f.name), description: f.description || '', parameters: f.parameters || { type: 'object' } } };
      });
  }

  const tc = clientBody?.tool_choice;
  if (tc === 'auto' || tc === 'required' || tc === 'none') out.tool_choice = tc;
  else if (tc?.type === 'function' && (tc.name || tc.function?.name)) {
    out.tool_choice = { type: 'function', function: { name: String(tc.name || tc.function.name) } };
  }
  return out;
}

// ─────────────────────────── 响应：Responses ↔ chat

/** Responses 的 response 对象 → canonical chat 响应 */
export function responseToChat(json, model) {
  // 上游有可能 HTTP 200 但正文是错误信封，原样带上，别让它掉进空 output 的分支
  if (json?.error) {
    return { error: { message: json.error.message || '上游返回错误', type: json.error.type || json.error.code || 'api_error' } };
  }
  const output = Array.isArray(json?.output) ? json.output : [];
  const text = outputText(output);
  const toolCalls = output
    .filter((i) => i?.type === 'function_call')
    .map((i) => ({
      id: String(i.call_id || i.id || `call_${randomId(8)}`),
      type: 'function',
      function: { name: String(i.name || ''), arguments: argsString(i.arguments) },
    }));

  const message = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: String(json?.id || `chatcmpl-${randomId(8)}`),
    object: 'chat.completion',
    created: json?.created_at ?? Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReasonOf(json), logprobs: null }],
    usage: usageToChat(json?.usage),
  };
}

/** canonical chat 响应 → Responses 的 response 对象 */
export function responseFromChat(chatJson, model) {
  if (chatJson?.error) {
    return { error: { message: chatJson.error.message || '上游返回错误', type: chatJson.error.type || 'api_error' } };
  }
  const choice = chatJson?.choices?.[0] || {};
  const msg = choice.message || {};
  const text = chatText(msg.content);

  const output = [];
  if (text) {
    output.push({
      id: `msg_${randomId(12)}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }
  for (const call of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
    output.push({
      id: `fc_${randomId(12)}`,
      type: 'function_call',
      status: 'completed',
      call_id: String(call?.id || `call_${randomId(8)}`),
      name: String(call?.function?.name || ''),
      arguments: argsString(call?.function?.arguments),
    });
  }

  const incomplete = choice.finish_reason === 'length';
  const out = {
    id: 'resp_' + String(chatJson?.id || randomId(12)).replace(/[^A-Za-z0-9]/g, ''),
    object: 'response',
    created_at: chatJson?.created ?? Math.floor(Date.now() / 1000),
    status: incomplete ? 'incomplete' : 'completed',
    model,
    output,
    usage: usageFromChat(chatJson?.usage),
  };
  if (incomplete) out.incomplete_details = { reason: 'max_output_tokens' };
  return out;
}

// ─────────────────────────── 流式：Responses 事件 → chat chunk
//
// Responses 那边是有状态的项目流（item 开始 / 增量 / 结束），chat 是扁平 delta，
// 所以这边是「拆状态」：output_text.delta 直接变成 delta.content；
// function_call 项要攒出 tool_calls 的 index / id / name / arguments 分片。

export function createStreamToChat(model) {
  const id = `chatcmpl-${randomId(8)}`;
  const created = Math.floor(Date.now() / 1000);
  let buffer = '';
  // event: 行和它的 data: 行可能被切在两次 push 之间，所以这个状态必须挂在闭包上
  let pendingEvent = '';
  let finished = false;
  let sentRole = false;
  let sentFinish = false;
  let sawText = false;
  let usage = null;
  // Responses 的 item_id 是字符串、chat 的 tool_calls index 是序号，两边都留一份映射：
  // 有的实现只在增量事件里给 output_index，不给 item_id
  const byItem = new Map();
  const byOutput = new Map();
  let nextTool = 0;

  const chunk = (delta, finishReason = null) =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;

  const findTool = (itemId, outputIndex) => byItem.get(String(itemId ?? '')) || byOutput.get(outputIndex ?? -1) || null;

  /** 登记一个 function_call 项，顺便发出带 id/name 的头一帧 */
  const addTool = (item, outputIndex) => {
    const existing = findTool(item?.id, outputIndex);
    if (existing) return { t: existing, out: '' };
    const t = { index: nextTool++, args: '' };
    byItem.set(String(item?.id ?? ''), t);
    byOutput.set(outputIndex ?? -1, t);
    const delta = {
      tool_calls: [
        { index: t.index, id: String(item?.call_id || item?.id || `call_${randomId(8)}`), type: 'function', function: { name: String(item?.name || ''), arguments: '' } },
      ],
    };
    if (!sentRole) {
      delta.role = 'assistant';
      sentRole = true;
    }
    return { t, out: chunk(delta) };
  };

  const textChunk = (text) => {
    const delta = { content: text };
    if (!sentRole) {
      delta.role = 'assistant';
      sentRole = true;
    }
    return chunk(delta);
  };

  const handle = (event, data) => {
    const type = String(data?.type || event || '');

    if (type === 'error' || type === 'response.failed' || data?.error) {
      const err = data?.error || data?.response?.error || {};
      // 已经把错误吐出去了，flush 就别再补一帧正常的 finish
      sentFinish = true;
      return `data: ${JSON.stringify({ error: { message: err.message || '上游错误', type: err.type || err.code || 'api_error' } })}\n\n`;
    }

    if (type === 'response.output_item.added') {
      if (data.item?.type !== 'function_call') return '';
      return addTool(data.item, data.output_index).out;
    }

    if (type === 'response.output_text.delta') {
      const text = typeof data.delta === 'string' ? data.delta : '';
      if (!text) return '';
      sawText = true;
      return textChunk(text);
    }

    if (type === 'response.function_call_arguments.delta') {
      const frag = typeof data.delta === 'string' ? data.delta : '';
      let out = '';
      let t = findTool(data.item_id, data.output_index);
      if (!t) {
        // 没见过 output_item.added（丢帧或上游省略），按增量事件里的 id 补登记
        const r = addTool({ id: data.item_id }, data.output_index);
        t = r.t;
        out += r.out;
      }
      if (!frag) return out;
      t.args += frag;
      return out + chunk({ tool_calls: [{ index: t.index, function: { arguments: frag } }] });
    }

    if (type === 'response.output_item.done') {
      const item = data.item || {};
      if (item.type !== 'function_call') return '';
      let out = '';
      let t = findTool(item.id, data.output_index);
      if (!t) {
        const r = addTool(item, data.output_index);
        t = r.t;
        out += r.out;
      }
      // 只有一个分片都没来过时才用 done 里的完整 arguments 补一帧，否则会重复
      if (!t.args && typeof item.arguments === 'string' && item.arguments) {
        t.args = item.arguments;
        out += chunk({ tool_calls: [{ index: t.index, function: { arguments: item.arguments } }] });
      }
      return out;
    }

    if (type === 'response.completed' || type === 'response.incomplete') {
      const resp = data.response || {};
      if (resp.usage) usage = resp.usage;
      let out = '';
      // 有的上游只发终帧、不发增量，这种情况把正文从 output 里补出来
      if (!sawText && !byItem.size) {
        const text = outputText(resp.output);
        if (text) out += textChunk(text);
      }
      sentFinish = true;
      return out + chunk({}, finishReasonOf(resp));
    }

    return '';
  };

  return {
    push(text) {
      if (finished) return '';
      buffer += text;
      let out = '';
      // 逐行处理：跨行正则会把事件之间的空行吃掉，必须一行一行来
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('event:')) {
          pendingEvent = line.slice(6).trim();
          continue;
        }
        if (!line.startsWith('data:')) continue; // 注释行（`: keep-alive`）和空行
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') {
          out += this.flush();
          return out;
        }
        try {
          out += handle(pendingEvent, JSON.parse(payload));
        } catch {
          /* 半截 JSON 或上游杂帧，跳过 */
        }
        pendingEvent = '';
      }
      return out;
    },
    flush() {
      if (finished) return '';
      finished = true;
      let out = '';
      if (!sentFinish) out += chunk({}, byItem.size ? 'tool_calls' : 'stop');
      // usage 单独一帧（很多客户端靠最后这帧统计 token）
      if (usage) {
        out += `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: usageToChat(usage) })}\n\n`;
      }
      return out + 'data: [DONE]\n\n';
    },
  };
}

// ─────────────────────────── 流式反方向：chat chunk → Responses 事件
//
// 这次是「攒状态」：chat 的扁平 delta 里没有"项开始/结束"的概念，得自己维护
// 现在开到第几个 output item、是文本还是工具，最后 response.completed 里还要
// 带一份拼完整的 response 对象（客户端普遍靠它拿 usage 和最终文本）。

export function createStreamFromChat(model) {
  const respId = `resp_${randomId(12)}`;
  const created = Math.floor(Date.now() / 1000);
  let buffer = '';
  let finished = false;
  let errored = false;
  let startSent = false;
  let seq = 0;
  let outputIndex = 0;
  let textItem = null;
  let text = '';
  const tools = new Map(); // chat 的 tool_calls index -> { id, callId, index, name, args }
  let usage = null;
  let status = 'completed';

  const ev = (type, data) => sse(type, { type, sequence_number: seq++, ...data });

  const start = () => {
    if (startSent) return '';
    startSent = true;
    return ev('response.created', {
      response: { id: respId, object: 'response', created_at: created, status: 'in_progress', model, output: [] },
    });
  };

  const openText = () => {
    if (textItem) return '';
    textItem = { id: `msg_${randomId(12)}`, index: outputIndex++ };
    return (
      ev('response.output_item.added', {
        output_index: textItem.index,
        item: { id: textItem.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
      }) +
      ev('response.content_part.added', {
        item_id: textItem.id,
        output_index: textItem.index,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      })
    );
  };

  const handle = (json) => {
    if (json?.error) {
      errored = true;
      return ev('error', { code: json.error.code || json.error.type || 'api_error', message: json.error.message || '上游错误', param: null });
    }
    if (json?.usage) usage = json.usage;
    let out = start();

    const choice = json?.choices?.[0];
    if (!choice) return out;
    const delta = choice.delta || {};

    if (typeof delta.content === 'string' && delta.content) {
      out += openText();
      text += delta.content;
      out += ev('response.output_text.delta', {
        item_id: textItem.id,
        output_index: textItem.index,
        content_index: 0,
        delta: delta.content,
      });
    }

    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const key = call?.index ?? 0;
      let t = tools.get(key);
      if (!t) {
        t = { id: `fc_${randomId(12)}`, callId: String(call?.id || `call_${randomId(8)}`), index: outputIndex++, name: String(call?.function?.name || ''), args: '' };
        tools.set(key, t);
        out += ev('response.output_item.added', {
          output_index: t.index,
          item: { id: t.id, type: 'function_call', status: 'in_progress', call_id: t.callId, name: t.name, arguments: '' },
        });
      }
      // 名字偶尔晚一帧才到（上游先开 tool_call 再补 name）
      if (!t.name && call?.function?.name) t.name = String(call.function.name);
      const frag = call?.function?.arguments;
      if (typeof frag === 'string' && frag) {
        t.args += frag;
        out += ev('response.function_call_arguments.delta', { item_id: t.id, output_index: t.index, delta: frag });
      }
    }

    if (choice.finish_reason === 'length') status = 'incomplete';
    return out;
  };

  return {
    push(chunk) {
      if (finished) return '';
      buffer += chunk;
      let out = '';
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
      if (errored) return ''; // 已经发过 error 事件，再补 completed 只会骗客户端
      let out = start();
      const output = [];
      if (textItem) {
        const item = {
          id: textItem.id,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [] }],
        };
        output.push(item);
        out += ev('response.output_item.done', { output_index: textItem.index, item });
      }
      for (const t of tools.values()) {
        const item = { id: t.id, type: 'function_call', status: 'completed', call_id: t.callId, name: t.name, arguments: t.args };
        output.push(item);
        out += ev('response.output_item.done', { output_index: t.index, item });
      }
      const response = { id: respId, object: 'response', created_at: created, status, model, output, usage: usageFromChat(usage) };
      if (status === 'incomplete') response.incomplete_details = { reason: 'max_output_tokens' };
      // 截断的响应走 response.incomplete，别混进 completed —— 客户端靠事件名分流
      return out + ev(status === 'incomplete' ? 'response.incomplete' : 'response.completed', { response });
    },
  };
}
