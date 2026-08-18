// 临时集成测试：HTTP 层的安全加固 + 功能回归
const BASE = process.env.TEST_BASE || 'http://localhost:8817';
const PASSWORD = process.env.TEST_PASSWORD || 'sec9999';
let cookie = '';
let KEY = '';
let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✔' : '✘'} ${name}${cond ? '' : `  ← ${extra}`}`);
  cond ? pass++ : fail++;
};
const raw = (path, opts = {}) => fetch(`${BASE}${path}`, opts);
async function admin(path, method = 'GET', body, headers = {}) {
  const r = await raw(`/admin/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: r.status, json: await r.json().catch(() => null) };
}

// 先正常登录拿 cookie（限流测试放在最后，否则会把自己锁在外面）
const ok = await admin('/login', 'POST', { password: PASSWORD }, { 'x-forwarded-for': '8.8.8.8' });
check('正确密码能登录', ok.status === 200, `${ok.status} ${JSON.stringify(ok.json)}`);

// ── /healthz 信息量 ──
const anon = await (await raw('/healthz')).json();
check('未登录的 /healthz 只有 status/version/time', Object.keys(anon).sort().join(',') === 'status,time,version', JSON.stringify(anon));
const authed = await (await raw('/healthz', { headers: { cookie } })).json();
check('登录后 /healthz 才给账号/key 细节', typeof authed.accounts_total === 'number' && typeof authed.storage_persistent === 'boolean', JSON.stringify(authed));

// ── 静态文件路径穿越 ──
for (const p of [
  '/../package.json',
  '/..%2fpackage.json',
  '/%2e%2e/package.json',
  '/....//....//package.json',
  '/../src/store.js',
  '/../../../../etc/passwd',
]) {
  const r = await raw(p);
  const body = await r.text();
  const leaked = /"dependencies":|scryptSync|root:x:|FREEBUFF_TOKEN =/.test(body);
  check(`穿越 ${p} 没读到仓库文件`, !leaked, `status=${r.status} body=${body.slice(0, 60)}`);
}

// ── 功能回归 ──
const st = await admin('/state');
KEY = st.json.keys[0].key;
check('state 正常', st.status === 200 && Array.isArray(st.json.models), `${st.status}`);

const models = await (await raw('/v1/models', { headers: { authorization: `Bearer ${KEY}` } })).json();
check('免费 key 只看到免费模型', models.data.every((m) => !/luna|v4-pro|minimax|muse-spark|kimi/.test(m.id)), JSON.stringify(models.data?.map((m) => m.id)));

const paid = await raw('/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ model: 'openai/gpt-5.6-luna', messages: [{ role: 'user', content: 'x' }] }),
});
check('付费模型对免费 key 仍然 403', paid.status === 403, `${paid.status}`);

const suffix = await raw('/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'x' }] }),
});
check('去掉厂商前缀也绕不过付费门禁', suffix.status === 403, `${suffix.status} ${(await suffix.text()).slice(0, 120)}`);

await admin('/accounts', 'POST', { token: 'fake-token-for-sec-test-000000', email: 'sec@t.com', pool: 'any' });
const called = await raw('/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'x' }] }),
});
const text = await called.text();
check('上游失败的错误里不含账号邮箱', !text.includes('sec@t.com'), text.slice(0, 200));
check('试过的账号数只给数量', /^\d+$/.test(called.headers.get('x-myapi-accounts-tried') || ''), called.headers.get('x-myapi-accounts-tried'));

// ── 跨站写请求 ──
const csrf = await admin('/keys', 'POST', { name: 'x' }, { origin: 'https://evil.example' });
check('带外站 Origin 的写请求被拒', csrf.status === 403, `${csrf.status}`);

// ── 请求体上限 ──
const big = 'x'.repeat(9 * 1024 * 1024);
const tooBig = await raw('/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: big }] }),
});
check('超过 8MB 的请求体被拒', tooBig.status === 413 || tooBig.status === 400, `${tooBig.status}`);


// ── 不带 model 也要过门禁 ──
const onlyMimo = (await admin('/keys', 'POST', { name: 'only-mimo', allowPaid: false })).json.key;
await admin(`/keys/${onlyMimo.id}`, 'PATCH', { models: ['mimo/mimo-v2.5'] });
const bypass = await raw('/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${onlyMimo.key}` },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
});
check('不带 model 的请求仍然要过 key 白名单', bypass.status === 403, `${bypass.status} ${(await bypass.text()).slice(0, 120)}`);

// ── 停用 key 与不存在 key 不可区分 ──
const dead = (await admin('/keys', 'POST', { name: 'to-disable' })).json.key;
await admin(`/keys/${dead.id}`, 'PATCH', { enabled: false });
const r1 = await raw('/v1/models', { headers: { authorization: `Bearer ${dead.key}` } });
const r2 = await raw('/v1/models', { headers: { authorization: 'Bearer sk-fb-definitely-not-real' } });
const b1 = await r1.text();
const b2 = await r2.text();
check('停用 key 与不存在 key 的响应完全一致', r1.status === r2.status && b1 === b2, `${r1.status} vs ${r2.status}`);

// ── 改密码必须带当前密码 ──
const noCur = await admin('/password', 'POST', { next: 'brand-new-password-1' });
check('改密码不带当前密码 → 403', noCur.status === 403, `${noCur.status} ${JSON.stringify(noCur.json)}`);
const weak = await admin('/password', 'POST', { current: PASSWORD, next: '1234567890' });
check('纯数字新密码被拒', weak.status === 400, `${weak.status} ${JSON.stringify(weak.json)}`);

// ── 导出改成 POST ──
const getExport = await raw('/admin/api/export', { headers: { cookie } });
check('GET /export 已不可用', getExport.status === 404, `${getExport.status}`);
const postExport = await admin('/export', 'POST');
check('POST /export 正常', postExport.status === 200 && Array.isArray(postExport.json.accounts), `${postExport.status}`);

// ── 一键登出：旧 cookie 失效、当前浏览器自动续上 ──
const oldCookie = cookie;
const logoutAll = await admin('/logout-all', 'POST');
const afterLogout = await admin('/state');
check('一键登出成功且当前会话续上', logoutAll.status === 200 && afterLogout.status === 200, `${logoutAll.status}/${afterLogout.status}`);
const withOld = await fetch(`${BASE}/admin/api/state`, { headers: { cookie: oldCookie } });
check('旧 cookie 已被作废', withOld.status === 401, `${withOld.status}`);

// ── 畸形 Cookie 不该把进程搞崩 ──
const weirdCookie = await fetch(`${BASE}/admin/api/session`, { headers: { cookie: 'myapi_admin=%' } });
check('非法百分号的 cookie 不报错', weirdCookie.status === 200, `${weirdCookie.status}`);
const mb = await fetch(`${BASE}/admin/api/state`, { headers: { cookie: 'myapi_admin=aaa.äää' } });
check('多字节签名段不触发 timingSafeEqual 抛错', mb.status === 401, `${mb.status}`);
const stillAlive = await fetch(`${BASE}/healthz`);
check('上面两下之后服务还活着', stillAlive.status === 200, `${stillAlive.status}`);

// ── 登录限流（放最后，会把自己锁掉）──
let hard = null;
for (let i = 0; i < 12; i++) {
  const r = await admin('/login', 'POST', { password: 'wrong' });
  if (r.status === 429) { hard = i + 1; break; }
}
check('同一来源连错十几次被 429 挡住', hard !== null, '试了 12 次都没挡住');
let throttled = false;
for (let i = 0; i < 40; i++) {
  const t0 = Date.now();
  const r = await admin('/login', 'POST', { password: 'wrong' }, { 'x-forwarded-for': `9.9.${i}.${i}` });
  if (r.status === 401 && Date.now() - t0 >= 1800) { throttled = true; break; }
}
check('伪造 XFF 绕过按 IP 计数后被全局软限速拖慢', throttled, '40 次都没触发延迟');

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
