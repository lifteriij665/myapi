// OpenAI Responses 协议适配器的单测。跑法：node tests/proto-responses.mjs
// 不碰网络，全是纯函数 + 流式切片。
import {
  FORMAT,
  upstreamPath,
  authHeaders,
  requestFromChat,
  requestToChat,
  responseToChat,
  responseFromChat,
  createStreamToChat,
  createStreamFromChat,
} from '../src/protocols/responses.js';

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) {
    console.log(`✔ ${name}`);
    pass++;
  } else {
    console.log(`✘ ${name}\n   got  ${a}\n   want ${b}`);
    fail++;
  }
};

eq('FORMAT 标识', FORMAT, 'responses');
eq('端点固定是 /responses', [upstreamPath('gpt-5', false), upstreamPath('gpt-5', true)], ['/responses', '/responses']);
eq('鉴权头是 Bearer', authHeaders('sk-abc'), { authorization: 'Bearer sk-abc' });

// ─────────────────────────── 请求：chat → Responses
const fromChat = requestFromChat(
  {
    messages: [
      { role: 'system', content: '你很简洁' },
      { role: 'user', content: '北京天气' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '晴 25 度' },
    ],
    max_tokens: 128,
    temperature: 0.4,
    top_p: 0.9,
    stream: true,
    tools: [{ type: 'function', function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    tool_choice: { type: 'function', function: { name: 'get_weather' } },
  },
  'gpt-5'
);
eq('c→r：system 提到 instructions', fromChat.instructions, '你很简洁');
eq('c→r：max_tokens 改名 max_output_tokens', [fromChat.max_output_tokens, fromChat.max_tokens], [128, undefined]);
eq('c→r：采样参数带过去', [fromChat.temperature, fromChat.top_p, fromChat.stream], [0.4, 0.9, true]);
eq('c→r：user 变成 input_text 项', fromChat.input[0], { role: 'user', content: [{ type: 'input_text', text: '北京天气' }] });
eq('c→r：tool_calls 变成独立的 function_call 项', fromChat.input[1], {
  type: 'function_call',
  call_id: 'call_1',
  name: 'get_weather',
  arguments: '{"city":"北京"}',
});
eq('c→r：role:tool 变成 function_call_output', fromChat.input[2], { type: 'function_call_output', call_id: 'call_1', output: '晴 25 度' });
eq('c→r：tools 摊平（没有嵌套的 function 对象）', fromChat.tools, [
  { type: 'function', name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
]);
eq('c→r：tool_choice 具名', fromChat.tool_choice, { type: 'function', name: 'get_weather' });
eq('c→r：tool_choice auto/required/none 原样', [
  requestFromChat({ messages: [], tool_choice: 'auto' }, 'm').tool_choice,
  requestFromChat({ messages: [], tool_choice: 'required' }, 'm').tool_choice,
  requestFromChat({ messages: [], tool_choice: 'none' }, 'm').tool_choice,
], ['auto', 'required', 'none']);
eq('c→r：stop 映射到 Responses 侧不存在的字段时不乱塞', 'stop' in requestFromChat({ messages: [], stop: ['X'] }, 'm'), false);
eq('c→r：空请求不抛', requestFromChat({}, 'm').input, []);

// ─────────────────────────── 请求：Responses → chat（客户端发的是 Responses）
const toChat = requestToChat(
  {
    instructions: '你很简洁',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: '北京天气' }] },
      { type: 'function_call', call_id: 'call_9', name: 'get_weather', arguments: '{"city":"北京"}' },
      { type: 'function_call_output', call_id: 'call_9', output: '晴' },
    ],
    max_output_tokens: 64,
    stream: true,
    tools: [{ type: 'function', name: 'f', description: 'd', parameters: { type: 'object' } }],
    tool_choice: { type: 'function', name: 'f' },
  },
  'gpt-5'
);
eq('r→c：instructions 变成第一条 system', toChat.messages[0], { role: 'system', content: '你很简洁' });
eq('r→c：input_text 变成 user', toChat.messages[1], { role: 'user', content: '北京天气' });
eq('r→c：function_call 变成 assistant.tool_calls', toChat.messages[2], {
  role: 'assistant',
  content: null,
  tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }],
});
eq('r→c：function_call_output 变成 role:tool', toChat.messages[3], { role: 'tool', tool_call_id: 'call_9', content: '晴' });
eq('r→c：max_output_tokens 改回 max_tokens', toChat.max_tokens, 64);
eq('r→c：tools 变回嵌套形状', toChat.tools, [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }]);
eq('r→c：tool_choice 变回 OpenAI chat 的形状', toChat.tool_choice, { type: 'function', function: { name: 'f' } });
eq('r→c：input 是纯字符串时当一条 user', requestToChat({ input: '你好' }, 'm').messages, [{ role: 'user', content: '你好' }]);

// 往返：chat → Responses → chat 应该保住语义
const roundTrip = requestToChat(fromChat, 'gpt-5');
eq('往返后角色序列不变', roundTrip.messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool']);
eq('往返后工具调用还在', roundTrip.messages[2].tool_calls[0].function, { name: 'get_weather', arguments: '{"city":"北京"}' });

// ─────────────────────────── 响应：Responses → chat
const respDone = responseToChat(
  {
    id: 'resp_1',
    object: 'response',
    status: 'completed',
    model: 'gpt-5',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '晴' }] }],
    usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, input_tokens_details: { cached_tokens: 6 } },
  },
  'up/gpt-5'
);
eq('r→c 响应：外壳是 chat.completion', [respDone.object, respDone.model, respDone.choices[0].index], ['chat.completion', 'up/gpt-5', 0]);
eq('r→c 响应：文本落到 message.content', respDone.choices[0].message, { role: 'assistant', content: '晴' });
eq('r→c 响应：finish_reason=stop', respDone.choices[0].finish_reason, 'stop');
eq('r→c 响应：usage 换成 chat 的字段名', respDone.usage, {
  prompt_tokens: 10,
  completion_tokens: 3,
  total_tokens: 13,
  prompt_tokens_details: { cached_tokens: 6 },
});

const respTool = responseToChat(
  {
    id: 'resp_2',
    status: 'completed',
    output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '我查一下' }] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_5', name: 'get_weather', arguments: '{"city":"上海"}' },
    ],
  },
  'm'
);
eq('r→c 响应：有 function_call 就是 tool_calls', respTool.choices[0].finish_reason, 'tool_calls');
eq('r→c 响应：文本和工具调用同时保留', [respTool.choices[0].message.content, respTool.choices[0].message.tool_calls], [
  '我查一下',
  [{ id: 'call_5', type: 'function', function: { name: 'get_weather', arguments: '{"city":"上海"}' } }],
]);
eq(
  'r→c 响应：incomplete(max_output_tokens) → length',
  responseToChat({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }, 'm').choices[0].finish_reason,
  'length'
);
eq(
  'r→c 响应：截断优先于工具调用（别让客户端拿半截 JSON）',
  responseToChat(
    { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'function_call', call_id: 'c', name: 'f', arguments: '{"a' }] },
    'm'
  ).choices[0].finish_reason,
  'length'
);
eq('r→c 响应：HTTP 200 但正文是错误 → 转成 error', responseToChat({ error: { message: '炸了', type: 'server_error' } }, 'm').error.message, '炸了');
eq('r→c 响应：空 output 不抛', responseToChat({ status: 'completed', output: [] }, 'm').choices[0].message.content, null);

// ─────────────────────────── 响应：chat → Responses
const back = responseFromChat(
  {
    id: 'chatcmpl-7',
    model: 'gpt-5',
    choices: [
      {
        finish_reason: 'tool_calls',
        message: { role: 'assistant', content: '好', tool_calls: [{ id: 'call_3', function: { name: 'f', arguments: '{"a":1}' } }] },
      },
    ],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  },
  'gpt-5'
);
eq('c→r 响应：外壳是 response', [back.object, back.status], ['response', 'completed']);
eq('c→r 响应：文本变成 output_text 项', (({ id, status, ...rest }) => rest)(back.output[0]), {
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text: '好', annotations: [] }],
});
eq('c→r 响应：tool_calls 变成 function_call 项', back.output[1].type, 'function_call');
eq('c→r 响应：function_call 带 call_id / name / arguments', [back.output[1].call_id, back.output[1].name, back.output[1].arguments], [
  'call_3',
  'f',
  '{"a":1}',
]);
eq('c→r 响应：usage 换回 Responses 的字段名', back.usage, {
  input_tokens: 4,
  output_tokens: 2,
  total_tokens: 6,
  input_tokens_details: { cached_tokens: 0 },
});
eq(
  'c→r 响应：finish_reason=length → incomplete',
  (() => {
    const r = responseFromChat({ choices: [{ finish_reason: 'length', message: { content: '半' } }] }, 'm');
    return [r.status, r.incomplete_details?.reason];
  })(),
  ['incomplete', 'max_output_tokens']
);

// ─────────────────────────── 流式：Responses → chat
// 关键点：切片位置不能影响输出（事件行和 data 行可能被切开）
const upstreamSse =
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_9"}}\n\n' +
  ': keep-alive\n\n' +
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"你","item_id":"msg_1","output_index":0}\n\n' +
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"好","item_id":"msg_1","output_index":0}\n\n' +
  'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_7","name":"get_weather"}}\n\n' +
  'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":1,"delta":"{\\"city\\":"}\n\n' +
  'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":1,"delta":"\\"北京\\"}"}\n\n' +
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_9","status":"completed","output":[{"type":"function_call","call_id":"call_7","name":"get_weather","arguments":"{}"}],"usage":{"input_tokens":9,"output_tokens":5,"total_tokens":14}}}\n\n';

const sliceRuns = [];
for (const size of [1, 7, 33, 4096]) {
  const s = createStreamToChat('up/gpt-5');
  let out = '';
  for (let i = 0; i < upstreamSse.length; i += size) out += s.push(upstreamSse.slice(i, i + size));
  out += s.flush();
  // id 和 created 每次实例都不同，比较前抹掉
  sliceRuns.push(out.replace(/"id":"chatcmpl-[a-f0-9]+"/g, '"id":"ID"').replace(/"created":\d+/g, '"created":0'));
}
eq('r→c 流式：1/7/33/4096 字节切片输出完全一致', sliceRuns.every((x) => x === sliceRuns[0]), true);

const s2cFrames = sliceRuns[0].split('\n\n').filter(Boolean);
eq('r→c 流式：以 [DONE] 收尾', s2cFrames[s2cFrames.length - 1], 'data: [DONE]');
eq('r→c 流式：没有连续空行（会让 SSE 客户端解析失败）', sliceRuns[0].includes('\n\n\n'), false);
const s2cObjs = s2cFrames.filter((f) => f !== 'data: [DONE]').map((f) => JSON.parse(f.replace(/^data: /, '')));
eq('r→c 流式：文本拼得回来', s2cObjs.map((o) => o.choices?.[0]?.delta?.content || '').join(''), '你好');
eq('r→c 流式：第一帧带 role', s2cObjs[0].choices[0].delta.role, 'assistant');
eq(
  'r→c 流式：工具参数分片拼得回来',
  s2cObjs
    .flatMap((o) => o.choices?.[0]?.delta?.tool_calls || [])
    .map((t) => t.function?.arguments || '')
    .join(''),
  '{"city":"北京"}'
);
eq(
  'r→c 流式：工具头一帧带 id 和 name',
  (() => {
    const first = s2cObjs.flatMap((o) => o.choices?.[0]?.delta?.tool_calls || []).find((t) => t.id);
    return [first.id, first.function.name, first.index];
  })(),
  ['call_7', 'get_weather', 0]
);
eq('r→c 流式：结尾给出 finish_reason', s2cObjs.map((o) => o.choices?.[0]?.finish_reason).filter(Boolean).pop(), 'tool_calls');
eq('r→c 流式：usage 有带出来', s2cObjs.map((o) => o.usage).filter(Boolean).pop(), {
  prompt_tokens: 9,
  completion_tokens: 5,
  total_tokens: 14,
});

// 上游中途报错
const errStream = createStreamToChat('m');
const errOut = errStream.push('event: error\ndata: {"type":"error","error":{"message":"上游炸了","code":"server_error"}}\n\n') + errStream.flush();
eq('r→c 流式：上游报错透出成 error 帧', errOut.includes('"上游炸了"'), true);
eq('r→c 流式：报错后仍然以 [DONE] 收尾', errOut.trimEnd().endsWith('data: [DONE]'), true);

// ─────────────────────────── 流式：chat → Responses
const chatSse =
  'data: {"id":"chatcmpl-1","choices":[{"delta":{"role":"assistant","content":"你"}}]}\n\n' +
  ': keep-alive\n\n' +
  'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"好"}}]}\n\n' +
  'data: {"id":"chatcmpl-1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_2","type":"function","function":{"name":"f","arguments":""}}]}}]}\n\n' +
  'data: {"id":"chatcmpl-1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\":1}"}}]}}]}\n\n' +
  'data: {"id":"chatcmpl-1","choices":[{"finish_reason":"tool_calls","delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\n' +
  'data: [DONE]\n\n';

const c2rRuns = [];
for (const size of [1, 7, 33, 4096]) {
  const s = createStreamFromChat('gpt-5');
  let out = '';
  for (let i = 0; i < chatSse.length; i += size) out += s.push(chatSse.slice(i, i + size));
  out += s.flush();
  // id 是每个实例随机生成的（resp_ / msg_ / fc_ 三种前缀），比较前统一抹掉
  c2rRuns.push(
    out
      .replace(/"(resp|msg|fc|call)_[a-f0-9]{8,}"/g, '"X"')
      .replace(/(_at|created)":\d+/g, '$1":0')
  );
}
eq('c→r 流式：1/7/33/4096 字节切片输出完全一致', c2rRuns.every((x) => x === c2rRuns[0]), true);
eq('c→r 流式：没有连续空行', c2rRuns[0].includes('\n\n\n'), false);
const c2rEvents = c2rRuns[0]
  .split('\n\n')
  .filter(Boolean)
  .map((f) => (f.match(/^event: (\S+)/m) || [])[1])
  .filter(Boolean);
eq('c→r 流式：以 response.created 开场、response.completed 收尾', [c2rEvents[0], c2rEvents[c2rEvents.length - 1]], [
  'response.created',
  'response.completed',
]);
eq('c→r 流式：文本增量事件都在', c2rEvents.includes('response.output_text.delta'), true);
eq('c→r 流式：工具参数增量事件都在', c2rEvents.includes('response.function_call_arguments.delta'), true);
const c2rData = c2rRuns[0]
  .split('\n\n')
  .filter(Boolean)
  .map((f) => {
    const m = f.match(/^data: (.*)$/m);
    return m ? JSON.parse(m[1]) : null;
  })
  .filter(Boolean);
eq(
  'c→r 流式：文本拼得回来',
  c2rData.filter((d) => d.type === 'response.output_text.delta').map((d) => d.delta).join(''),
  '你好'
);
eq(
  'c→r 流式：工具参数拼得回来',
  c2rData.filter((d) => d.type === 'response.function_call_arguments.delta').map((d) => d.delta).join(''),
  '{"a":1}'
);
eq(
  'c→r 流式：completed 里带 usage',
  c2rData.filter((d) => d.type === 'response.completed').pop().response.usage,
  { input_tokens: 3, output_tokens: 4, total_tokens: 7, input_tokens_details: { cached_tokens: 0 } }
);

console.log(`\nResponses 协议测试：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
