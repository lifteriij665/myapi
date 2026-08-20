// 临时测试：这轮安全加固的单元级验证
process.env.DATA_DIR = './data-test-unit';
process.env.ADMIN_PASSWORD = 'unit-test-pw';
const { clientIp, publicBaseUrl, constantTimeEqual } = await import('../src/util.js');
const { safeTarget } = await import('../src/browser.js');
const { store } = await import('../src/store.js');

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✔' : '✘'} ${name}${ok ? '' : `\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};
const reqOf = (headers = {}, remote = '203.0.113.9') => ({ headers, socket: { remoteAddress: remote } });

// ── XFF 取向：客户端伪造的部分必须被忽略 ──
eq('伪造 XFF 时取代理追加的那一跳', clientIp(reqOf({ 'x-forwarded-for': '1.2.3.4, 198.51.100.7' }), 1), '198.51.100.7');
eq('多层代理按 hops 取', clientIp(reqOf({ 'x-forwarded-for': 'evil, 198.51.100.7, 10.0.0.1' }), 2), '198.51.100.7');
eq('没有 XFF 就用 socket 地址', clientIp(reqOf({}), 1), '203.0.113.9');
eq('XFF 全是空白也不炸', clientIp(reqOf({ 'x-forwarded-for': ' , ' }), 1), '203.0.113.9');

// ── Host 头注入 ──
delete process.env.PUBLIC_BASE_URL;
process.env.RAILWAY_PUBLIC_DOMAIN = 'real.up.railway.app';
eq('Host 被换成攻击者域名时回落到平台域名', publicBaseUrl(reqOf({ host: 'evil.example.com' })), 'https://real.up.railway.app');
eq('Host 是平台域名时正常用它', publicBaseUrl(reqOf({ host: 'real.up.railway.app', 'x-forwarded-proto': 'https' })), 'https://real.up.railway.app');
eq('本机访问仍然给 http://localhost', publicBaseUrl(reqOf({ host: 'localhost:8787' })), 'http://localhost:8787');
eq('Host 里塞奇怪字符直接不认', publicBaseUrl(reqOf({ host: 'a.com/x?y=1' })), 'https://real.up.railway.app');
process.env.PUBLIC_BASE_URL = 'https://api.mydomain.com';
eq('显式配了 PUBLIC_BASE_URL 就用它', publicBaseUrl(reqOf({ host: 'evil.example.com' })), 'https://api.mydomain.com');
delete process.env.PUBLIC_BASE_URL;
delete process.env.RAILWAY_PUBLIC_DOMAIN;

// ── 内置浏览器的目标限制（SSRF）──
for (const bad of [
  'http://127.0.0.1:8787/admin/api/export',
  'http://localhost/',
  'http://169.254.169.254/latest/meta-data/',
  'http://metadata.google.internal/computeMetadata/v1/',
  'http://10.0.0.5/',
  'http://192.168.1.1/',
  'http://172.16.0.9/',
  'file:///etc/passwd',
  'chrome://settings',
  'data:text/html,<h1>x',
  'http://[::1]:8787/',
  'http://railway.internal/',
]) {
  eq(`拦住 ${bad}`, safeTarget(bad), null);
}
eq('放过正常上游地址', safeTarget('https://www.codebuff.com/login?auth_code=x'), 'https://www.codebuff.com/login?auth_code=x');
eq('裸域名补 https', safeTarget('github.com/login'), 'https://github.com/login');

// ── 定长比较 ──
eq('相同字符串', constantTimeEqual('abc', 'abc'), true);
eq('长度不同也能安全返回 false', constantTimeEqual('a', 'abcdefghijklmnop'), false);
eq('空值不炸', constantTimeEqual(undefined, ''), true);

// ── API key 查表 ──
store.load();
const k = store.addKey({ name: 'unit' });
eq('能查到刚建的 key', store.findKey(k.key)?.id, k.id);
eq('查不存在的 key 返回 null', store.findKey('sk-fb-nope'), null);
eq('非字符串不炸', store.findKey({}), null);
store.removeKey(k.id);
eq('删掉之后索引跟着失效', store.findKey(k.key), null);

// ── 密码校验 ──
eq('环境变量密码有效', await store.verifyPassword('unit-test-pw'), true);
eq('错密码', await store.verifyPassword('unit-test-pw '), false);


// ─────────────────────────── 选号策略（钉住 / 手动 / 排除失效）
store.data.accounts = [
  { id: 'a1', email: 'one@x.com', token: 'tok-one-1234567890', pool: 'any', enabled: true, status: null },
  { id: 'a2', email: 'two@x.com', token: 'tok-two-1234567890', pool: 'any', enabled: true, status: null },
  { id: 'a3', email: 'three@x.com', token: 'tok-three-123456789', pool: 'free', enabled: true, status: null },
];
const { selectOrder, createAnthropicStreamPatcher, ensureMessageId, normalizeAnthropicUsage, patchAnthropicMessage } =
  await import('../src/engine.js');
const FREE = 'deepseek/deepseek-v4-flash';
const PAID = 'openai/gpt-5.6-luna';

store.data.settings.autoSwitch = true;
store.data.settings.activeAccountId = null;
eq('没钉号时按优先级排（仅免费的号先接免费模型）', selectOrder(FREE).order.map((a) => a.id), ['a3', 'a1', 'a2']);

store.data.settings.activeAccountId = 'a3';
eq('钉住同档位的号 → 从它开始顺延', selectOrder(FREE).order.map((a) => a.id), ['a3', 'a1', 'a2']);

store.data.settings.activeAccountId = 'a2';
eq('钉住的号档位更低时不当起点（免费流量别去啃付费号）', selectOrder(FREE).order.map((a) => a.id), ['a3', 'a1', 'a2']);

store.data.settings.autoSwitch = false;
eq('手动模式只给钉住的那一个', selectOrder(FREE).order.map((a) => a.id), ['a2']);
store.data.accounts[1].enabled = false;
eq('手动模式下钉住的号被停用 → 空（请求应 503）', selectOrder(FREE).order.length, 0);
store.data.accounts[1].enabled = true;
store.data.settings.autoSwitch = true;

store.data.accounts[0].status = { state: 'token_invalid' };
eq('标记失效的号被排除', selectOrder(FREE).order.map((a) => a.id), ['a3', 'a2']);
store.data.accounts[0].status = null;
store.data.settings.activeAccountId = null;
eq('付费模型排除"仅免费"的号', selectOrder(PAID).order.map((a) => a.id), ['a1', 'a2']);

// ─────────────────────────── Anthropic 响应补丁
eq('裸 UUID 补 msg_ 前缀', ensureMessageId('2a76b09d-7015-4984-b2b6-6f7d2e063b59'), 'msg_2a76b09d70154984b2b66f7d2e063b59');
eq('已经是 msg_ 的不动', ensureMessageId('msg_01abc'), 'msg_01abc');
eq('usage 补 cache 字段', normalizeAnthropicUsage({ input_tokens: 5, output_tokens: 7 }), {
  input_tokens: 5,
  output_tokens: 7,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
});
eq('非 message 对象不动', patchAnthropicMessage({ type: 'error', error: {} }), { type: 'error', error: {} });

const sse =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"abc-123","type":"message","role":"assistant","model":"m","content":[],"usage":{"input_tokens":3,"output_tokens":1}}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';
const patched = sse.replace(
  '{"id":"abc-123","type":"message","role":"assistant","model":"m","content":[],"usage":{"input_tokens":3,"output_tokens":1}}',
  '{"id":"msg_abc123","type":"message","role":"assistant","model":"m","content":[],"usage":{"input_tokens":3,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}'
);
for (const size of [1, 7, 33, 4096]) {
  const p = createAnthropicStreamPatcher();
  let out = '';
  for (let i = 0; i < sse.length; i += size) out += p.push(sse.slice(i, i + size));
  out += p.flush();
  eq(`SSE 切片 ${size} 字节：只改 message_start，事件边界不变`, out, patched);
}
const oaiSse = 'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
const p2 = createAnthropicStreamPatcher();
eq('没有 message_start 就原样透传', p2.push(oaiSse) + p2.flush(), oaiSse);

// ─────────────────────────── opencode 号池（不碰真上游，全是纯函数 + store 状态）
const { isFreeOpencodeModel, isOpencodeModel, stripPrefix, withPrefix } = await import('../src/models-opencode.js');
const { tierOf, providerForModel, resolveModelId, checkModelAccess, isKnownModel } = await import('../src/models.js');
const { providerOf } = await import('../src/store.js');

eq('big-pickle 是免费的（名字里没 free，只按名字判断会漏）', isFreeOpencodeModel('big-pickle'), true);
eq('带 -free 后缀的都算免费', isFreeOpencodeModel('mimo-v2.5-free'), true);
eq('deepseek-v4-pro 不是免费的', isFreeOpencodeModel('deepseek-v4-pro'), false);
eq('前缀判断', [isOpencodeModel('opencode/big-pickle'), isOpencodeModel('deepseek/deepseek-v4-flash')], [true, false]);
eq('去前缀 / 加前缀', [stripPrefix('opencode/big-pickle'), withPrefix('big-pickle')], ['big-pickle', 'opencode/big-pickle']);

const OC_FREE = 'opencode/mimo-v2.5-free';
const OC_PAID = 'opencode/claude-sonnet-5';
eq('opencode 免费模型归类为 free', tierOf(OC_FREE), 'free');
eq('opencode 付费模型归类为 paid', tierOf(OC_PAID), 'paid');
eq('模型 → 上游', [providerForModel(OC_FREE), providerForModel(FREE)], ['opencode', 'freebuff']);
eq('裸的 opencode 模型名也认', resolveModelId('mimo-v2.5-free'), OC_FREE);
eq('带前缀的原样保留', resolveModelId(OC_FREE), OC_FREE);
eq('opencode 的模型算已知', isKnownModel(OC_FREE), true);
eq('freebuff 后缀匹配没被 opencode 抢走', resolveModelId('deepseek-v4-flash'), 'deepseek/deepseek-v4-flash');

// 门禁：没勾「允许付费」的 key 不能用 Zen 的按量计费模型，免费的可以
eq('免费 key 能用 opencode 免费模型', checkModelAccess({ allowPaid: false, models: [] }, OC_FREE).ok, true);
eq('免费 key 用不了 opencode 付费模型', checkModelAccess({ allowPaid: false, models: [] }, OC_PAID).status, 403);
eq('勾了付费就能用', checkModelAccess({ allowPaid: true, models: [] }, OC_PAID).ok, true);
eq('不存在的 opencode 模型：表还没刷新时不硬判 404，交给上游说话', checkModelAccess({ allowPaid: true, models: [] }, 'opencode/not-a-model').ok, true);
eq('未知的 opencode 模型按付费处理（fail-closed）', tierOf('opencode/not-a-model'), 'paid');
eq('key 白名单对 opencode 同样生效', checkModelAccess({ allowPaid: true, models: [OC_PAID] }, OC_FREE).status, 403);

// 选号必须按上游分流：opencode 的 key 塞进 freebuff 引擎毫无意义，反之亦然
store.data.settings.autoSwitch = true;
store.data.settings.activeAccountId = null;
store.data.accounts = [
  { id: 'fb1', email: 'one@x.com', token: 'tok-one-1234567890', pool: 'any', enabled: true, status: null },
  { id: 'fb2', email: 'two@x.com', token: 'tok-two-1234567890', provider: 'freebuff', pool: 'any', enabled: true, status: null },
  { id: 'oc1', name: 'zen-a', token: 'sk-zen-aaaaaaaaaaaa', provider: 'opencode', pool: 'free', enabled: true, status: null },
  { id: 'oc2', name: 'zen-b', token: 'sk-zen-bbbbbbbbbbbb', provider: 'opencode', pool: 'any', enabled: true, status: null },
];
eq('老数据没 provider 字段时当 freebuff', providerOf(store.data.accounts[0]), 'freebuff');
eq('freebuff 模型只用 freebuff 的号', selectOrder(FREE).order.map((a) => a.id), ['fb1', 'fb2']);
eq('opencode 免费模型只用 opencode 的号', selectOrder(OC_FREE).order.map((a) => a.id), ['oc1', 'oc2']);
eq('opencode 付费模型排除"仅免费"的 opencode 号', selectOrder(OC_PAID).order.map((a) => a.id), ['oc2']);

// 关键回归：所有 opencode 号都被标失效时，fail-open 不能把 freebuff 的号捞进来
store.data.accounts[2].status = { state: 'token_invalid' };
store.data.accounts[3].status = { state: 'banned' };
eq('opencode 号全失效时也不会跨上游取号', selectOrder(OC_FREE).order.map((a) => a.id), ['oc1', 'oc2']);
store.data.accounts[2].status = null;
store.data.accounts[3].status = null;

// 一个 opencode 号都没有时，opencode 模型不该借用 freebuff 的号
store.data.accounts = [{ id: 'fb1', email: 'one@x.com', token: 'tok-one-1234567890', pool: 'any', enabled: true, status: null }];
eq('没有 opencode 号 → 空（引擎再决定要不要走匿名）', selectOrder(OC_FREE).order.length, 0);

// ─────────────────────────── Anthropic ↔ OpenAI 协议桥
// Zen 按模型钉协议：chat 原生的模型只认 chat 格式，claude-* 只认 Anthropic 格式，
// 跟客户端用了哪个端点无关。所以这两个方向的转换都得对。
const { nativeProtocol, isSupportedProtocol } = await import('../src/models-opencode.js');
const bridge = await import('../src/anthropic-bridge.js');

eq('免费模型都是 chat 原生', ['mimo-v2.5-free', 'big-pickle', 'deepseek-v4-flash-free'].map(nativeProtocol), ['chat', 'chat', 'chat']);
eq('claude / qwen 是 Anthropic 原生', [nativeProtocol('claude-sonnet-5'), nativeProtocol('qwen3.6-plus')], ['anthropic', 'anthropic']);
eq('gpt / grok / muse 是 Responses 原生', ['gpt-5', 'grok-4.6', 'muse-spark-1.2'].map(nativeProtocol), ['responses', 'responses', 'responses']);
eq('gemini 是 Google 原生', nativeProtocol('gemini-3-flash'), 'google');
eq('只承接 chat 和 anthropic 两种', ['mimo-v2.5-free', 'claude-sonnet-5', 'gpt-5', 'gemini-3-flash'].map(isSupportedProtocol), [true, true, false, false]);

// a2c：Anthropic 请求 → chat 请求
const a2cReq = bridge.anthropicToChat(
  {
    system: '你很简洁',
    max_tokens: 64,
    temperature: 0.3,
    stop_sequences: ['STOP'],
    tools: [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
    tool_choice: { type: 'any' },
    messages: [
      { role: 'user', content: '北京天气' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: '北京' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '晴 25 度' }] },
    ],
  },
  'mimo-v2.5-free'
);
eq('a2c：system 变成第一条 system 消息', a2cReq.messages[0], { role: 'system', content: '你很简洁' });
eq('a2c：tool_use 变成 tool_calls', a2cReq.messages[2].tool_calls, [
  { id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } },
]);
eq('a2c：tool_result 拆成 role:tool 消息', a2cReq.messages[3], { role: 'tool', tool_call_id: 'toolu_1', content: '晴 25 度' });
eq('a2c：采样参数和工具都带过去', [a2cReq.max_tokens, a2cReq.temperature, a2cReq.stop, a2cReq.tool_choice, a2cReq.tools.length], [64, 0.3, ['STOP'], 'required', 1]);

// a2c：chat 响应 → Anthropic message
const a2cResp = bridge.chatToAnthropic(
  {
    id: 'gen-abc-123',
    choices: [
      {
        finish_reason: 'tool_calls',
        message: { role: 'assistant', content: '好的', tool_calls: [{ id: 'call_9', function: { name: 'get_weather', arguments: '{"city":"上海"}' } }] },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 6 } },
  },
  'opencode/mimo-v2.5-free'
);
eq('a2c：id 变成 msg_ 前缀且只留字母数字', a2cResp.id, 'msg_genabc123');
eq('a2c：文本 + tool_use 两个块', a2cResp.content, [
  { type: 'text', text: '好的' },
  { type: 'tool_use', id: 'call_9', name: 'get_weather', input: { city: '上海' } },
]);
eq('a2c：stop_reason 映射', a2cResp.stop_reason, 'tool_use');
eq('a2c：usage 带 cache 字段', a2cResp.usage, { input_tokens: 10, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 6 });
eq('a2c：空回复也给一个空文本块（规范不允许 content 为空数组）', bridge.chatToAnthropic({ choices: [{ message: {} }] }, 'm').content, [{ type: 'text', text: '' }]);
eq('a2c：HTTP 200 但正文是错误 → 转成 error 信封', bridge.chatToAnthropic({ error: { type: 'server_error', message: '上游炸了' } }, 'm').type, 'error');

// a2c 流式：事件顺序必须合规
const a2cStream = bridge.createChatToAnthropicStream('opencode/mimo-v2.5-free');
const oaiFrames =
  'data: {"id":"gen-1","choices":[{"delta":{"role":"assistant","content":"你"}}]}\n\n' +
  ': keep-alive\n\n' +
  'data: {"id":"gen-1","choices":[{"delta":{"content":"好"}}]}\n\n' +
  'data: {"id":"gen-1","choices":[{"finish_reason":"stop","delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n' +
  'data: [DONE]\n\n';
let a2cOut = '';
for (let i = 0; i < oaiFrames.length; i += 13) a2cOut += a2cStream.push(oaiFrames.slice(i, i + 13));
a2cOut += a2cStream.flush();
const a2cEvents = a2cOut.split('\n\n').filter(Boolean).map((e) => (e.match(/^event: (\S+)/m) || [])[1]);
eq('a2c 流式：Anthropic 的事件顺序', a2cEvents, [
  'message_start',
  'content_block_start',
  'content_block_delta',
  'content_block_delta',
  'content_block_stop',
  'message_delta',
  'message_stop',
]);
eq(
  'a2c 流式：文本拼得回来',
  a2cOut
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5)))
    .filter((d) => d.type === 'content_block_delta')
    .map((d) => d.delta.text)
    .join(''),
  '你好'
);
eq('a2c 流式：每个事件之间都是空行', a2cOut.endsWith('\n\n') && !a2cOut.includes('\n\n\n'), true);

// c2a：chat 请求 → Anthropic 请求
const c2aReq = bridge.chatToAnthropicRequest(
  {
    messages: [
      { role: 'system', content: '你很简洁' },
      { role: 'user', content: '北京天气' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '晴' },
    ],
    stop: 'END',
    tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
    tool_choice: 'required',
  },
  'claude-sonnet-5'
);
eq('c2a：system 提到顶层', c2aReq.system, '你很简洁');
eq('c2a：max_tokens 必填，客户端没给就补默认值', c2aReq.max_tokens, 4096);
eq('c2a：tool_calls 变成 tool_use 块', c2aReq.messages[1].content, [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: '北京' } }]);
eq('c2a：role:tool 变成 user 里的 tool_result', c2aReq.messages[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '晴' }] });
eq('c2a：stop 字符串包成数组、tool_choice 映射', [c2aReq.stop_sequences, c2aReq.tool_choice], [['END'], { type: 'any' }]);

// c2a：Anthropic 响应 → chat 响应
const c2aResp = bridge.anthropicToChatResponse(
  {
    id: 'msg_1',
    content: [{ type: 'text', text: '晴' }, { type: 'tool_use', id: 'toolu_2', name: 'f', input: { a: 1 } }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 4 },
  },
  'opencode/claude-sonnet-5'
);
eq('c2a：finish_reason 映射', c2aResp.choices[0].finish_reason, 'tool_calls');
eq('c2a：tool_use 变回 tool_calls', c2aResp.choices[0].message.tool_calls, [
  { id: 'toolu_2', type: 'function', function: { name: 'f', arguments: '{"a":1}' } },
]);
eq('c2a：usage 换成 OpenAI 的字段名', [c2aResp.usage.prompt_tokens, c2aResp.usage.completion_tokens, c2aResp.usage.total_tokens], [8, 3, 11]);

// c2a 流式
const c2aStream = bridge.createAnthropicToChatStream('opencode/claude-sonnet-5');
const antFrames =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_9","usage":{"input_tokens":5,"output_tokens":0}}}\n\n' +
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你"}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}\n\n' +
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';
let c2aOut = '';
for (let i = 0; i < antFrames.length; i += 17) c2aOut += c2aStream.push(antFrames.slice(i, i + 17));
c2aOut += c2aStream.flush();
const c2aChunks = c2aOut
  .split('\n\n')
  .filter(Boolean)
  .map((l) => l.replace(/^data: /, ''));
eq('c2a 流式：以 [DONE] 收尾', c2aChunks[c2aChunks.length - 1], '[DONE]');
eq(
  'c2a 流式：文本拼得回来',
  c2aChunks
    .filter((c) => c !== '[DONE]')
    .map((c) => JSON.parse(c))
    .map((c) => c.choices?.[0]?.delta?.content || '')
    .join(''),
  '你好'
);
eq(
  'c2a 流式：最后带一帧 usage',
  JSON.parse(c2aChunks[c2aChunks.length - 2]).usage,
  { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
);
eq('c2a 流式：第一帧带 role', JSON.parse(c2aChunks[0]).choices[0].delta.role, 'assistant');

console.log(`\n单元测试：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
