// 端到端验协议转换：起一个假上游（四种协议），在网关里各建一个自定义上游，
// 然后用 OpenAI 和 Anthropic 两种客户端协议分别打过去，非流式 + 流式都验。
//
// 为什么要这么绕：协议适配器的单测只能证明"函数本身对"，证明不了
// engine 那条链路（归一 → 门禁 → 上游 → 翻回）接对了。这个测就是补那一段。
const BASE = process.env.TEST_BASE || 'http://localhost:8941';
const PASSWORD = process.env.TEST_PASSWORD || 'proto-e2e-pw';
const MOCK = process.env.MOCK_BASE || 'http://127.0.0.1:8971';
const MOCK_KEY = 'sk-mock-key-0000000000';

let cookie = '';
let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✔' : '✘'} ${name}${cond ? '' : `  ← ${extra}`}`);
  cond ? pass++ : fail++;
};

async function admin(path, method = 'GET', body) {
  const r = await fetch(`${BASE}/admin/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: r.status, json: await r.json().catch(() => null) };
}

const login = await admin('/login', 'POST', { password: PASSWORD });
check('登录', login.status === 200, JSON.stringify(login.json));

// 建四个自定义上游，每个说一种协议，都指向同一个假上游。
// 先把同名的旧上游清掉：这个测试可能在留有上次数据的目录上重跑。
const existing = await admin('/upstreams');
for (const u of existing.json?.upstreams || []) {
  if (!u.builtin && /^mock-/.test(u.name)) await admin(`/upstreams/${u.id}`, 'DELETE');
}

const FORMATS = [
  ['chat', 'mock-chat'],
  ['responses', 'mock-resp'],
  ['anthropic', 'mock-ant'],
  ['gemini', 'mock-gem'],
];
const created = {};
for (const [format, name] of FORMATS) {
  const r = await admin('/upstreams', 'POST', {
    name,
    format,
    baseUrl: MOCK,
    defaultTier: 'free', // 免费才能用默认 key 打，省得再造一个允许付费的 key
    keys: MOCK_KEY,
  });
  check(`建 ${format} 上游`, r.status === 200 && r.json?.ok, JSON.stringify(r.json).slice(0, 160));
  created[format] = r.json?.upstream;
  if (created[format]) {
    await admin(`/upstreams/${created[format].id}/models`, 'POST', { models: 'mock-model' });
  }
}

// 拉取模型：验证 /models 的四种返回形状都能认
for (const [format] of FORMATS) {
  const up = created[format];
  if (!up) continue;
  const r = await admin(`/upstreams/${up.id}/models/fetch`, 'POST');
  check(
    `${format}：能从上游拉到模型列表`,
    r.status === 200 && Array.isArray(r.json?.models) && r.json.models.length > 0,
    JSON.stringify(r.json).slice(0, 140)
  );
  // 拉取会 replace 掉清单，把测试用的模型名加回去
  await admin(`/upstreams/${up.id}/models`, 'POST', { models: 'mock-model' });
}

// 探活：/models 能拉到就算可用，不用真花钱发请求
for (const [format] of FORMATS) {
  const up = created[format];
  if (!up) continue;
  const r = await admin(`/upstreams/${up.id}/check`, 'POST');
  const ok = (r.json?.results || []).every((x) => x.state === 'ok');
  check(`${format}：key 探活通过`, ok, JSON.stringify(r.json?.results).slice(0, 160));
}

const st = await admin('/state');
const KEY = st.json.keys[0].key;
const model = (format) => `${format === 'chat' ? 'mock-chat' : format === 'responses' ? 'mock-resp' : format === 'anthropic' ? 'mock-ant' : 'mock-gem'}/mock-model`;

// ── OpenAI 客户端协议 → 四种上游协议 ──
for (const [format] of FORMATS) {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: model(format), messages: [{ role: 'user', content: '喂' }], max_tokens: 32 }),
  });
  const j = await r.json().catch(() => null);
  const text = j?.choices?.[0]?.message?.content || '';
  check(
    `OpenAI 客户端 → ${format} 上游（非流式）`,
    r.status === 200 && /收到:喂/.test(text),
    `${r.status} ${JSON.stringify(j).slice(0, 200)}`
  );
  check(
    `OpenAI 客户端 → ${format} 上游：响应外壳是 chat.completion`,
    j?.object === 'chat.completion' && typeof j?.usage?.prompt_tokens === 'number',
    JSON.stringify(j).slice(0, 160)
  );
  check(`OpenAI 客户端 → ${format} 上游：走的是这个上游`, r.headers.get('x-myapi-provider') === created[format].id, r.headers.get('x-myapi-provider'));
}

// ── OpenAI 客户端协议 → 四种上游协议（流式）──
for (const [format] of FORMATS) {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: model(format), messages: [{ role: 'user', content: '喂' }], stream: true }),
  });
  const raw = await r.text();
  const frames = raw.split('\n\n').filter(Boolean);
  const objs = frames
    .filter((f) => f.startsWith('data: ') && !f.includes('[DONE]'))
    .map((f) => {
      try {
        return JSON.parse(f.slice(6));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const joined = objs.map((o) => o.choices?.[0]?.delta?.content || '').join('');
  check(`OpenAI 客户端 → ${format} 上游（流式）文本拼得回来`, /流$/.test(joined), `${r.status} ${JSON.stringify(joined)} ${raw.slice(0, 160)}`);
  check(`OpenAI 客户端 → ${format} 上游（流式）以 [DONE] 收尾`, raw.trimEnd().endsWith('data: [DONE]'), raw.slice(-80));
  check(`OpenAI 客户端 → ${format} 上游（流式）事件间空行完好`, !raw.includes('\n\n\n'), '出现了连续空行');
}

// ── Anthropic 客户端协议 → 四种上游协议 ──
for (const [format] of FORMATS) {
  const r = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: model(format), max_tokens: 32, messages: [{ role: 'user', content: '喂' }] }),
  });
  const j = await r.json().catch(() => null);
  const text = (j?.content || []).map((b) => b.text || '').join('');
  check(
    `Anthropic 客户端 → ${format} 上游（非流式）`,
    r.status === 200 && /收到:喂/.test(text),
    `${r.status} ${JSON.stringify(j).slice(0, 200)}`
  );
  check(
    `Anthropic 客户端 → ${format} 上游：响应外壳是 message + msg_ 前缀`,
    j?.type === 'message' && String(j?.id || '').startsWith('msg_') && typeof j?.usage?.input_tokens === 'number',
    JSON.stringify(j).slice(0, 160)
  );
}

// ── Anthropic 客户端协议 → 四种上游协议（流式）──
for (const [format] of FORMATS) {
  const r = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: model(format), max_tokens: 32, stream: true, messages: [{ role: 'user', content: '喂' }] }),
  });
  const raw = await r.text();
  const events = raw
    .split('\n\n')
    .filter(Boolean)
    .map((e) => (e.match(/^event: (\S+)/m) || [])[1])
    .filter(Boolean);
  const text = raw
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => {
      try {
        return JSON.parse(l.slice(6));
      } catch {
        return null;
      }
    })
    .filter((d) => d?.type === 'content_block_delta')
    .map((d) => d.delta?.text || '')
    .join('');
  check(`Anthropic 客户端 → ${format} 上游（流式）文本拼得回来`, /流$/.test(text), `${r.status} ${JSON.stringify(text)} ${raw.slice(0, 200)}`);
  check(
    `Anthropic 客户端 → ${format} 上游（流式）事件顺序合规`,
    events[0] === 'message_start' && events.at(-1) === 'message_stop' && events.includes('content_block_delta'),
    events.join(' → ')
  );
  check(`Anthropic 客户端 → ${format} 上游（流式）事件间空行完好`, !raw.includes('\n\n\n'), '出现了连续空行');
}

// ── 换号策略真的生效 ──
const chatUp = created.chat;
await admin(`/upstreams/${chatUp.id}/keys`, 'POST', { keys: `${MOCK_KEY}\nsk-mock-second-000000000\nsk-mock-third-0000000000` });
await admin(`/upstreams/${chatUp.id}/rotation`, 'POST', { mode: 'roundrobin' });
const seen = new Set();
for (let i = 0; i < 6; i++) {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: model('chat'), messages: [{ role: 'user', content: '喂' }] }),
  });
  seen.add(r.headers.get('x-myapi-rotation'));
  await r.text();
}
check('轮询策略：响应头标出 roundrobin', seen.has('roundrobin'), [...seen].join(','));

await admin(`/upstreams/${chatUp.id}/rotation`, 'POST', { mode: 'single' });
const singleResp = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ model: model('chat'), messages: [{ role: 'user', content: '喂' }] }),
});
await singleResp.text();
check('单号策略：响应头标出 single', singleResp.headers.get('x-myapi-rotation') === 'single', singleResp.headers.get('x-myapi-rotation'));
check('单号策略：只试了一个号', singleResp.headers.get('x-myapi-accounts-tried') === '1', singleResp.headers.get('x-myapi-accounts-tried'));

// 一个坏 key 的上游：onerror 会一路换号，最后给出明确失败。
// 注意 tokenMasked 对这几个 key 是一样的（中间都被打码了），没法靠它区分，
// 所以先把这个上游的号全删掉，只加两个坏 key。
await admin(`/upstreams/${chatUp.id}/rotation`, 'POST', { mode: 'onerror' });
const st2 = await admin('/state');
for (const a of st2.json.accounts.filter((x) => x.provider === chatUp.id)) {
  await admin(`/accounts/${a.id}`, 'DELETE');
}
await admin(`/upstreams/${chatUp.id}/keys`, 'POST', { keys: 'sk-bad-one-000000000000\nsk-bad-two-000000000000' });
const badResp = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ model: model('chat'), messages: [{ role: 'user', content: '喂' }] }),
});
const badText = await badResp.text();
check('全是坏 key 时给出明确失败', badResp.status >= 400 && /token 失效|上游调用失败/.test(badText), `${badResp.status} ${badText.slice(0, 160)}`);
check('一出错就换：两个坏号都试过了', badResp.headers.get('x-myapi-accounts-tried') === '2', badResp.headers.get('x-myapi-accounts-tried'));
const st3 = await admin('/state');
const badAccts = st3.json.accounts.filter((a) => a.provider === chatUp.id);
check(
  '坏 key 的状态被归类成 token_invalid',
  badAccts.length === 2 && badAccts.every((a) => a.status?.state === 'token_invalid'),
  JSON.stringify(badAccts.map((a) => a.status?.state))
);
check('失败详情里不含完整 key', !JSON.stringify(st3.json.accounts).includes('sk-bad-one-000000000000'), 'key 泄露到状态里了');

// single 模式下即使失败也只试一个号
await admin(`/upstreams/${chatUp.id}/rotation`, 'POST', { mode: 'single' });
const singleBad = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ model: model('chat'), messages: [{ role: 'user', content: '喂' }] }),
});
await singleBad.text();
check('单号模式失败也不换号（只试 1 个）', singleBad.headers.get('x-myapi-accounts-tried') === '1', singleBad.headers.get('x-myapi-accounts-tried'));

// ── 模型列表把所有上游合起来 ──
const models = await (await fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${KEY}` } })).json();
const ids = (models.data || []).map((m) => m.id);
check(
  '/v1/models 里有四个自定义上游的模型',
  FORMATS.every(([f]) => ids.includes(model(f))),
  JSON.stringify(ids.filter((i) => i.includes('mock')))
);

// 停用上游后模型就不该再出现
await admin(`/upstreams/${created.gemini.id}`, 'PATCH', { enabled: false });
const models2 = await (await fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${KEY}` } })).json();
check('停用的上游不出现在 /v1/models', !(models2.data || []).map((m) => m.id).includes(model('gemini')), '停用后还在列表里');
const off = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ model: model('gemini'), messages: [{ role: 'user', content: '喂' }] }),
});
const offText = await off.text();
check('请求停用上游的模型给出明确原因', off.status === 503 && /已停用/.test(offText), `${off.status} ${offText.slice(0, 140)}`);

// ── 删上游连带清号 ──
const before = (await admin('/state')).json.accounts.length;
const del = await admin(`/upstreams/${created.responses.id}`, 'DELETE');
const after = (await admin('/state')).json.accounts.length;
check('删上游连它的 key 一起删', del.status === 200 && after < before, `${before} → ${after}`);

console.log(`\n协议端到端：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
