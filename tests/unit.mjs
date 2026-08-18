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

console.log(`\n单元测试：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
