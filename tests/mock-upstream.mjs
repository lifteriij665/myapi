// 假上游：四种协议各起一个端点，用来端到端验协议转换（不碰真网络）。
// 只做最小实现：认 key、回一个固定形状的响应 / SSE 流。
import { createServer } from 'node:http';

const PORT = Number(process.argv[2] || 8971);
const KEY = 'sk-mock-key-0000000000';

const read = (req) =>
  new Promise((done) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => done(b ? JSON.parse(b) : {}));
  });

const json = (res, code, obj) => {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': body.length });
  res.end(body);
};

const sse = (res, frames) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  // 故意分片写、故意先来一个注释行，模拟真实上游
  res.write(': keep-alive\n\n');
  for (const f of frames) res.write(f);
  res.end();
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const auth = req.headers.authorization || '';
  const key = auth.replace(/^Bearer /, '') || req.headers['x-api-key'] || req.headers['x-goog-api-key'] || '';
  const body = req.method === 'POST' ? await read(req) : {};
  const stream = Boolean(body.stream) || p.includes('streamGenerateContent');

  if (key !== KEY) return json(res, 401, { error: { message: 'bad key', type: 'auth_error' } });

  // ── 模型列表（四种协议的形状都不一样）──
  if (p.endsWith('/models') && req.method === 'GET') {
    if (p.includes('gemini') || url.searchParams.get('shape') === 'gemini') {
      return json(res, 200, { models: [{ name: 'models/mock-gemini' }] });
    }
    return json(res, 200, { object: 'list', data: [{ id: 'mock-a' }, { id: 'mock-b' }] });
  }

  // ── OpenAI Chat Completions ──
  if (p.endsWith('/chat/completions')) {
    if (!stream) {
      return json(res, 200, {
        id: 'cmpl-mock',
        object: 'chat.completion',
        created: 1,
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: `chat收到:${body.messages?.at(-1)?.content}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });
    }
    return sse(res, [
      `data: {"id":"cmpl-mock","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant","content":"chat"}}]}\n\n`,
      `data: {"id":"cmpl-mock","object":"chat.completion.chunk","choices":[{"delta":{"content":"流"}}]}\n\n`,
      `data: {"id":"cmpl-mock","object":"chat.completion.chunk","choices":[{"finish_reason":"stop","delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n`,
      'data: [DONE]\n\n',
    ]);
  }

  // ── OpenAI Responses ──
  if (p.endsWith('/responses')) {
    const said = typeof body.input === 'string' ? body.input : body.input?.at(-1)?.content?.[0]?.text;
    if (!stream) {
      return json(res, 200, {
        id: 'resp-mock',
        object: 'response',
        status: 'completed',
        model: body.model,
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `resp收到:${said}` }] }],
        usage: { input_tokens: 6, output_tokens: 4, total_tokens: 10 },
      });
    }
    return sse(res, [
      `event: response.created\ndata: {"type":"response.created","response":{"id":"resp-mock"}}\n\n`,
      `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"resp","item_id":"m1","output_index":0}\n\n`,
      `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"流","item_id":"m1","output_index":0}\n\n`,
      `event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-mock","status":"completed","output":[],"usage":{"input_tokens":6,"output_tokens":2,"total_tokens":8}}}\n\n`,
    ]);
  }

  // ── Anthropic Messages ──
  if (p.endsWith('/messages')) {
    const said = body.messages?.at(-1)?.content;
    const txt = typeof said === 'string' ? said : said?.[0]?.text;
    if (!stream) {
      return json(res, 200, {
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: `ant收到:${txt}` }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 7, output_tokens: 5 },
      });
    }
    return sse(res, [
      `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_mock","usage":{"input_tokens":7,"output_tokens":0}}}\n\n`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ant"}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"流"}}\n\n`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ]);
  }

  // ── Gemini generateContent ──
  if (p.includes(':generateContent') || p.includes(':streamGenerateContent')) {
    const txt = body.contents?.at(-1)?.parts?.[0]?.text;
    if (!stream) {
      return json(res, 200, {
        candidates: [{ content: { parts: [{ text: `gem收到:${txt}` }], role: 'model' }, finishReason: 'STOP', index: 0 }],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 6, totalTokenCount: 14 },
      });
    }
    return sse(res, [
      `data: {"candidates":[{"content":{"parts":[{"text":"gem"}],"role":"model"},"index":0}]}\n\n`,
      `data: {"candidates":[{"content":{"parts":[{"text":"流"}],"role":"model"},"index":0}],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":2,"totalTokenCount":10}}\n\n`,
      `data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP","index":0}]}\n\n`,
    ]);
  }

  json(res, 404, { error: { message: `no route ${p}` } });
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock upstream on ${PORT}`));
