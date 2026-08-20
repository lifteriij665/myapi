// Gemini 原生协议适配器的单元测试：node tests/proto-gemini.mjs
// 全是纯函数，不碰网络也不碰 store。
const g = await import('../src/protocols/gemini.js');

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✔' : '✘'} ${name}${ok ? '' : `\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

// ─────────────────────────── 常量 / 路由
eq('FORMAT', g.FORMAT, 'gemini');
eq('非流式路径', g.upstreamPath('gemini-3-flash', false), '/models/gemini-3-flash:generateContent');
eq('流式路径必须带 alt=sse', g.upstreamPath('gemini-3-flash', true), '/models/gemini-3-flash:streamGenerateContent?alt=sse');
eq('模型名带 models/ 前缀时不重复', g.upstreamPath('models/gemini-3-pro', false), '/models/gemini-3-pro:generateContent');
eq('鉴权头', g.authHeaders('AIza-x'), { 'x-goog-api-key': 'AIza-x' });
eq('key 缺失也不炸', g.authHeaders(undefined), { 'x-goog-api-key': '' });

// ─────────────────────────── 请求方向：角色映射
const r1 = g.requestFromChat(
  {
    messages: [
      { role: 'system', content: '你很简洁' },
      { role: 'user', content: '北京天气' },
      { role: 'assistant', content: '晴' },
    ],
    max_tokens: 64,
    temperature: 0.3,
    top_p: 0.9,
    stop: 'END',
  },
  'gemini-3-flash'
);
eq('system 提到 systemInstruction', r1.systemInstruction, { parts: [{ text: '你很简洁' }] });
eq('contents 里不留 system 角色', r1.contents.map((c) => c.role), ['user', 'model']);
eq('assistant → model', r1.contents[1], { role: 'model', parts: [{ text: '晴' }] });
eq('采样参数换成 generationConfig 的名字', r1.generationConfig, {
  maxOutputTokens: 64,
  temperature: 0.3,
  topP: 0.9,
  stopSequences: ['END'],
});
eq('model 不进 body（Gemini 见到未知字段会 400）', r1.model, undefined);
eq('没有工具时不带 tools / toolConfig', [r1.tools, r1.toolConfig], [undefined, undefined]);

// 多条 system 合并
eq(
  '多条 system 合成一段',
  g.requestFromChat({ messages: [{ role: 'system', content: 'a' }, { role: 'developer', content: 'b' }] }, 'm').systemInstruction,
  { parts: [{ text: 'a\n\nb' }] }
);

// ─────────────────────────── 连续同角色必须合并（这条不对的话真实请求会被上游拒）
const merged = g.requestFromChat(
  {
    messages: [
      { role: 'user', content: '一' },
      { role: 'user', content: '二' },
      { role: 'assistant', content: '甲' },
      { role: 'assistant', content: '乙' },
      { role: 'user', content: '三' },
    ],
  },
  'm'
);
eq('连续同角色合并成一条多 parts', merged.contents, [
  { role: 'user', parts: [{ text: '一' }, { text: '二' }] },
  { role: 'model', parts: [{ text: '甲' }, { text: '乙' }] },
  { role: 'user', parts: [{ text: '三' }] },
]);
eq('合并后严格交替', merged.contents.map((c) => c.role), ['user', 'model', 'user']);
eq('空 messages 也给一条兜底 user', g.requestFromChat({}, 'm').contents, [{ role: 'user', parts: [{ text: '' }] }]);

// ─────────────────────────── 工具往返
const tools = g.requestFromChat(
  {
    messages: [
      { role: 'user', content: '北京天气' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } },
          { id: 'call_2', type: 'function', function: { name: 'get_time', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_2', content: '{"hour":9}' },
      { role: 'tool', tool_call_id: 'call_1', content: '晴 25 度' },
    ],
    tools: [{ type: 'function', function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    tool_choice: 'required',
  },
  'm'
);
eq('tool_calls → functionCall（args 是对象不是字符串）', tools.contents[1], {
  role: 'model',
  parts: [
    { functionCall: { name: 'get_weather', args: { city: '北京' } } },
    { functionCall: { name: 'get_time', args: {} } },
  ],
});
eq('role:tool → user 的 functionResponse，name 由 tool_call_id 反查（两条结果也合并成一条 user）', tools.contents[2], {
  role: 'user',
  parts: [
    { functionResponse: { name: 'get_time', response: { hour: 9 } } },
    { functionResponse: { name: 'get_weather', response: { result: '晴 25 度' } } },
  ],
});
eq('裸字符串的工具输出被包成对象', tools.contents[2].parts[1].functionResponse.response, { result: '晴 25 度' });
eq('对象形式的工具输出原样保留', tools.contents[2].parts[0].functionResponse.response, { hour: 9 });
eq('functionDeclarations 包在 tools[0] 里', tools.tools[0].functionDeclarations[0].name, 'get_weather');
eq('tool_choice: required → mode ANY', tools.toolConfig, { functionCallingConfig: { mode: 'ANY' } });
eq(
  'tool_choice 指名 → allowedFunctionNames',
  g.requestFromChat(
    { messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'f' } }], tool_choice: { type: 'function', function: { name: 'f' } } },
    'm'
  ).toolConfig,
  { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['f'] } }
);
eq(
  'tool_choice: none → mode NONE',
  g.requestFromChat({ messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'f' } }], tool_choice: 'none' }, 'm').toolConfig,
  { functionCallingConfig: { mode: 'NONE' } }
);
eq(
  '找不到匹配 id 时退回上一个函数名，而不是发一个空 name',
  g.requestFromChat(
    {
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'call_x', function: { name: 'only_fn', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'nope', content: 'ok' },
      ],
    },
    'm'
  ).contents[1].parts[0].functionResponse.name,
  'only_fn'
);
eq(
  '坏掉的 arguments 不炸，退成空对象',
  g.requestFromChat({ messages: [{ role: 'assistant', tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{半截' } }] }] }, 'm').contents[0].parts[0]
    .functionCall.args,
  {}
);

// ─────────────────────────── JSON-Schema 洗白（Gemini 不认 JSON-Schema 专有关键字）
const schema = g.requestFromChat(
  {
    messages: [{ role: 'user', content: 'x' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'f',
          parameters: {
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            additionalProperties: false,
            properties: {
              a: { type: 'string', default: 'x' },
              nested: {
                type: 'object',
                additionalProperties: false,
                $schema: 'x',
                properties: { b: { type: 'number', default: 1 } },
              },
              list: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { c: { type: 'string' } } } },
              empty: { type: 'object', properties: {}, additionalProperties: false },
              default: { type: 'string' },
            },
            required: ['a'],
          },
        },
      },
    ],
  },
  'm'
).tools[0].functionDeclarations[0].parameters;
eq('$schema / additionalProperties / default 递归剥掉，空 properties 丢弃，required 保留', schema, {
  type: 'object',
  properties: {
    a: { type: 'string' },
    nested: { type: 'object', properties: { b: { type: 'number' } } },
    list: { type: 'array', items: { type: 'object', properties: { c: { type: 'string' } } } },
    empty: { type: 'object' },
    default: { type: 'string' },
  },
  required: ['a'],
});
eq(
  '没给 parameters 时补一个 type:object',
  g.requestFromChat({ messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'f' } }] }, 'm').tools[0].functionDeclarations[0]
    .parameters,
  { type: 'object' }
);

// ─────────────────────────── 响应方向
const resp = g.responseToChat(
  {
    candidates: [{ content: { parts: [{ text: '晴 25 度' }], role: 'model' }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14, cachedContentTokenCount: 6 },
  },
  'gemini-3-flash'
);
eq('文本 → message.content', resp.choices[0].message, { role: 'assistant', content: '晴 25 度' });
eq('object / model 字段', [resp.object, resp.model], ['chat.completion', 'gemini-3-flash']);
eq('STOP → stop', resp.choices[0].finish_reason, 'stop');
eq('usageMetadata → canonical usage', resp.usage, {
  prompt_tokens: 10,
  completion_tokens: 4,
  total_tokens: 14,
  prompt_tokens_details: { cached_tokens: 6 },
});
eq(
  'totalTokenCount 缺失时自己加',
  g.responseToChat({ candidates: [], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } }, 'm').usage,
  { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
);
eq('没有 usageMetadata 时 usage 全 0', g.responseToChat({ candidates: [] }, 'm').usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });

eq('MAX_TOKENS → length', g.responseToChat({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'MAX_TOKENS' }] }, 'm').choices[0].finish_reason, 'length');
eq('SAFETY → content_filter', g.responseToChat({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] }, 'm').choices[0].finish_reason, 'content_filter');
eq(
  'RECITATION / PROHIBITED_CONTENT 也算 content_filter',
  ['RECITATION', 'PROHIBITED_CONTENT'].map((f) => g.responseToChat({ candidates: [{ content: {}, finishReason: f }] }, 'm').choices[0].finish_reason),
  ['content_filter', 'content_filter']
);
eq('未知 finishReason 退成 stop', g.responseToChat({ candidates: [{ content: {}, finishReason: 'WAT' }] }, 'm').choices[0].finish_reason, 'stop');

const fc = g.responseToChat(
  {
    candidates: [
      {
        content: { parts: [{ text: '让我查一下' }, { functionCall: { name: 'get_weather', args: { city: '上海' } } }], role: 'model' },
        finishReason: 'STOP',
      },
    ],
  },
  'm'
);
eq('有 functionCall → finish_reason 变 tool_calls（哪怕 Gemini 说 STOP）', fc.choices[0].finish_reason, 'tool_calls');
eq('functionCall → tool_calls，args 序列化成字符串，id 合成一个稳定值', fc.choices[0].message.tool_calls, [
  { id: 'call_get_weather_0', type: 'function', function: { name: 'get_weather', arguments: '{"city":"上海"}' } },
]);
eq('文本和工具调用同时在', fc.choices[0].message.content, '让我查一下');
eq('纯工具调用时 content 为 null', g.responseToChat({ candidates: [{ content: { parts: [{ functionCall: { name: 'f' } }] } }] }, 'm').choices[0].message.content, null);

// 被拦掉的提示词：没有 candidates，只有 promptFeedback
const blocked = g.responseToChat({ promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 7 } }, 'gemini-3-flash');
eq('拦截：不炸，给一条合法响应', [blocked.object, blocked.choices.length], ['chat.completion', 1]);
eq('拦截：finish_reason 是 content_filter', blocked.choices[0].finish_reason, 'content_filter');
eq('拦截：message 仍然是合法形状', blocked.choices[0].message, { role: 'assistant', content: null });
eq('空 body 不炸', g.responseToChat({}, 'm').choices[0].finish_reason, 'stop');
eq('undefined 不炸', g.responseToChat(undefined, 'm').choices[0].message.content, null);

// Gemini 的错误信封
eq('{error:{...}} → canonical error', g.responseToChat({ error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }, 'm'), {
  error: { message: 'Quota exceeded', type: 'RESOURCE_EXHAUSTED', code: 429 },
});
eq('错误里字段缺失时有兜底', g.responseToChat({ error: {} }, 'm').error.type, 'api_error');

// ─────────────────────────── 流式
const frames =
  'data: {"candidates":[{"content":{"parts":[{"text":"你"}],"role":"model"},"index":0}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1,"totalTokenCount":6}}\n\n' +
  ': keep-alive\n\n' +
  'data: {"candidates":[{"content":{"parts":[{"text":"好，"}],"role":"model"},"index":0}]}\n\n' +
  'data: {"candidates":[{"content":{"parts":[{"text":"世界"}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3,"totalTokenCount":8}}\n\n';

const runs = {};
// id 和 created 每个实例都不一样，比对前抹掉，剩下的必须逐字节相同
const norm = (s) => s.replace(/"id":"chatcmpl-[a-f0-9]+"/g, '"id":"ID"').replace(/"created":\d+/g, '"created":0');
for (const size of [1, 7, 33, 4096]) {
  const s = g.createStreamToChat('gemini-3-flash');
  let out = '';
  for (let i = 0; i < frames.length; i += size) out += s.push(frames.slice(i, i + size));
  out += s.flush();
  runs[size] = norm(out);

  const chunks = out.split('\n\n').filter(Boolean);
  const objs = chunks.filter((c) => c !== 'data: [DONE]').map((c) => JSON.parse(c.slice(6)));
  eq(`切片 ${size}：文本拼得回来`, objs.map((o) => o.choices?.[0]?.delta?.content || '').join(''), '你好，世界');
  eq(`切片 ${size}：以 [DONE] 收尾`, chunks[chunks.length - 1], 'data: [DONE]');
  eq(`切片 ${size}：不出现 \\n\\n\\n，也不吞事件之间的空行`, out.endsWith('\n\n') && !out.includes('\n\n\n'), true);
  eq(`切片 ${size}：每帧都是 data: 开头`, chunks.every((c) => c.startsWith('data: ')), true);
  eq(`切片 ${size}：倒数第二帧是 usage`, objs[objs.length - 1].usage, { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
  eq(`切片 ${size}：finish_reason 只在收尾那帧`, objs.map((o) => o.choices?.[0]?.finish_reason ?? null), [null, null, null, 'stop', undefined]);
  eq(`切片 ${size}：第一帧带 role`, objs[0].choices[0].delta.role, 'assistant');
  eq(`切片 ${size}：后续帧不重复 role`, objs[1].choices[0].delta.role, undefined);
}
eq('切片大小不影响输出（1 / 7 / 33 / 4096 完全一致）', [runs[7] === runs[1], runs[33] === runs[1], runs[4096] === runs[1]], [true, true, true]);

// 流式工具调用：Gemini 一次给整个 functionCall，arguments 一帧发全
const toolStream = g.createStreamToChat('m');
let tOut = toolStream.push(
  'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"city":"上海"}}}],"role":"model"},"finishReason":"STOP"}]}\n\n'
);
tOut += toolStream.flush();
const tObjs = tOut
  .split('\n\n')
  .filter((c) => c && c !== 'data: [DONE]')
  .map((c) => JSON.parse(c.slice(6)));
eq('流式工具：delta.tool_calls 一帧给全 arguments', tObjs[0].choices[0].delta.tool_calls, [
  { index: 0, id: 'call_get_weather_0', type: 'function', function: { name: 'get_weather', arguments: '{"city":"上海"}' } },
]);
eq('流式工具：收尾 finish_reason 是 tool_calls', tObjs[tObjs.length - 1].choices[0].finish_reason, 'tool_calls');
eq('流式工具：第一帧带 role', tObjs[0].choices[0].delta.role, 'assistant');

// 流式里的 MAX_TOKENS / 拦截 / 错误
const cut = g.createStreamToChat('m');
cut.push('data: {"candidates":[{"content":{"parts":[{"text":"x"}]},"finishReason":"MAX_TOKENS"}]}\n\n');
eq('流式：MAX_TOKENS → length', JSON.parse(cut.flush().split('\n\n')[0].slice(6)).choices[0].finish_reason, 'length');

const blockedStream = g.createStreamToChat('m');
blockedStream.push('data: {"promptFeedback":{"blockReason":"SAFETY"}}\n\n');
const bs = blockedStream.flush();
eq('流式：只有 promptFeedback 时也能正常收尾', [JSON.parse(bs.split('\n\n')[0].slice(6)).choices[0].finish_reason, bs.endsWith('data: [DONE]\n\n')], ['content_filter', true]);

const errStream = g.createStreamToChat('m');
const eo = errStream.push('data: {"error":{"code":500,"message":"boom","status":"INTERNAL"}}\n\n');
eq('流式：中途报错发一帧 error 信封', JSON.parse(eo.split('\n\n')[0].slice(6)).error, { message: 'boom', type: 'INTERNAL' });

// 半截 JSON / 空 push / flush 幂等
const odd = g.createStreamToChat('m');
eq('半截 JSON 不炸也不输出', odd.push('data: {"candidates":[{"content"\n\ndata: not json\n\n'), '');
eq('空字符串 push 不炸', odd.push(''), '');
const once = g.createStreamToChat('m');
once.push('data: {"candidates":[{"content":{"parts":[{"text":"a"}]},"finishReason":"STOP"}]}\n\n');
once.flush();
eq('flush 只生效一次', once.flush(), '');
eq('flush 之后 push 不再输出', once.push('data: {"candidates":[{"content":{"parts":[{"text":"b"}]}}]}\n\n'), '');
// id / created 是随机的，所以只验帧数、收尾和"没有 usage 字段"这三件事
const noUsage = g.createStreamToChat('m');
noUsage.push('data: {"candidates":[{"content":{"parts":[{"text":"a"}]},"finishReason":"STOP"}]}\n\n');
const noUsageFrames = noUsage.flush().split('\n\n').filter(Boolean);
eq('上游没给 usage 时不硬造 usage 帧：只剩 finish 帧 + [DONE]', [noUsageFrames.length, JSON.parse(noUsageFrames[0].slice(6)).usage, noUsageFrames[1]], [
  2,
  undefined,
  'data: [DONE]',
]);

// 上游（或中间代理）补了 [DONE]：不能提前收尾，也不能重复发
const withDone = g.createStreamToChat('m');
let wd = withDone.push('data: {"candidates":[{"content":{"parts":[{"text":"a"}]},"finishReason":"STOP"}]}\n\ndata: [DONE]\n\n');
wd += withDone.flush();
eq('上游多给一个 [DONE] 时只输出一个', wd.split('data: [DONE]').length - 1, 1);
eq('CRLF 换行也能解析', (() => {
  const s = g.createStreamToChat('m');
  const out = s.push('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\r\n\r\n');
  return JSON.parse(out.split('\n\n')[0].slice(6)).choices[0].delta.content;
})(), 'ok');

console.log(`\nGemini 协议测试：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
