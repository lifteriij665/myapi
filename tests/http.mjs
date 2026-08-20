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
const FREE_MODEL = st.json.models.find((m) => m.tier === 'free' && m.enabled && !m.limitedOffer)?.id;
const PAID_MODEL = st.json.models.find((m) => m.tier === 'paid' && m.enabled)?.id;
const OTHER_FREE = st.json.models.find((m) => m.tier === 'free' && m.id !== FREE_MODEL)?.id;
check('能从 state 里挑出免费/付费模型', Boolean(FREE_MODEL && PAID_MODEL), `free=${FREE_MODEL} paid=${PAID_MODEL}`);
check('state 正常', st.status === 200 && Array.isArray(st.json.models), `${st.status}`);

const models = await (await raw('/v1/models', { headers: { authorization: `Bearer ${KEY}` } })).json();
check('免费 key 只看到免费模型', models.data.every((m) => !/luna|v4-pro|minimax|muse-spark|kimi/.test(m.id)), JSON.stringify(models.data?.map((m) => m.id)));

const paid = await raw('/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ model: PAID_MODEL, messages: [{ role: 'user', content: 'x' }] }),
});
check('付费模型对免费 key 仍然 403', paid.status === 403, `${PAID_MODEL} → ${paid.status}`);

const suffix = await raw('/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ model: PAID_MODEL.split('/').pop(), messages: [{ role: 'user', content: 'x' }] }),
});
check('去掉厂商前缀也绕不过付费门禁', suffix.status === 403, `${suffix.status} ${(await suffix.text()).slice(0, 120)}`);

await admin('/accounts', 'POST', { token: 'fake-token-for-sec-test-000000', email: 'sec@t.com', pool: 'any' });
const called = await raw('/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ model: FREE_MODEL, messages: [{ role: 'user', content: 'x' }] }),
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
  body: JSON.stringify({ model: FREE_MODEL, messages: [{ role: 'user', content: big }] }),
});
check('超过 8MB 的请求体被拒', tooBig.status === 413 || tooBig.status === 400, `${tooBig.status}`);


// ── 不带 model 也要过门禁 ──
const onlyMimo = (await admin('/keys', 'POST', { name: 'only-mimo', allowPaid: false })).json.key;
// 白名单里故意不放默认模型，这样"不带 model"的请求必须被拒
await admin(`/keys/${onlyMimo.id}`, 'PATCH', { models: [OTHER_FREE || PAID_MODEL] });
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


// ── 用量统计 ──
const before = (await admin('/usage')).json.usage.totals.requests;
await raw('/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ model: FREE_MODEL, messages: [{ role: 'user', content: '用量统计测试' }] }),
});
const u = (await admin('/usage')).json.usage;
check('请求被记进用量', u.totals.requests > before, `${before} → ${u.totals.requests}`);
check('用量里带模型维度', u.byModel.some((m) => m.id === FREE_MODEL), JSON.stringify(u.byModel.map((m) => m.id)));
check('明细里有耗时和状态', u.recent.length > 0 && typeof u.recent[0].latencyMs === 'number', JSON.stringify(u.recent[0] || null).slice(0, 120));
check('48 小时序列长度正确', u.hours.length === 48, String(u.hours.length));
check('30 天序列长度正确', u.days.length === 30, String(u.days.length));

// 被门禁拒掉的请求也要能看到
await raw('/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ model: PAID_MODEL, messages: [{ role: 'user', content: 'x' }] }),
});
const u2 = (await admin('/usage')).json.usage;
check('被门禁拒掉的请求也记进用量', u2.recent.some((e) => e.error === 'model_denied'), JSON.stringify(u2.recent.map((e) => e.error)));

// ── SSE 实时推送 ──
const sseText = await (async () => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3500);
  try {
    const r = await fetch(`${BASE}/admin/api/events`, { headers: { cookie }, signal: ctrl.signal });
    const reader = r.body.getReader();
    const { value } = await reader.read();
    await reader.cancel().catch(() => {});
    return new TextDecoder().decode(value);
  } catch {
    return '';
  } finally {
    clearTimeout(t);
  }
})();
check('SSE 能推出一帧数据', sseText.startsWith('data: ') && sseText.includes('"usage"'), sseText.slice(0, 80));

// ── 聊天记录 ──
await admin('/settings', 'PATCH', { chatLogEnabled: true });
await raw('/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ model: FREE_MODEL, messages: [{ role: 'user', content: '记录这句话' }] }),
});
const log = (await admin('/chatlog')).json;
check('聊天记录写进了文件', log.status.files >= 1 && log.status.bytes > 0, JSON.stringify(log.status));
check('记录能按最后一条用户消息预览', log.recent.some((r) => (r.preview || '').includes('记录这句话')), JSON.stringify(log.recent.map((r) => r.preview)));
const dl = await raw(`/admin/api/chatlog/file/${log.files[0].name}`, { headers: { cookie } });
check('记录文件能下载成 JSONL', dl.status === 200 && (await dl.text()).trim().split('\n').every((l) => l.startsWith('{')), String(dl.status));
await admin('/settings', 'PATCH', { chatLogEnabled: false });
const off = await raw('/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ model: FREE_MODEL, messages: [{ role: 'user', content: '这句不该被记下来' }] }),
});
void off;
const log2 = (await admin('/chatlog')).json;
check('关掉之后不再记新的', !log2.recent.some((r) => (r.preview || '').includes('这句不该被记下来')), 'off 之后还在记');

// ── 存储盘点 + 分级清理 ──
const store1 = (await admin('/storage')).json;
check('存储盘点列出了各类占用', store1.storage.items.length >= 5 && typeof store1.storage.totalBytes === 'number', JSON.stringify(store1.storage.items.map((i) => i.key)));
check('三档清理都有预览', ['routine', 'deep', 'full'].every((l) => store1.previews[l]?.rows), Object.keys(store1.previews).join(','));

const routine = await admin('/cleanup', 'POST', { level: 'routine' });
const afterRoutine = (await admin('/chatlog')).json;
const usageKept = (await admin('/usage')).json.usage.totals.requests;
check('日常清理删掉了聊天记录', routine.status === 200 && afterRoutine.status.files === 0, JSON.stringify(routine.json?.done));
check('日常清理保留了用量统计', usageKept > 0, `requests=${usageKept}`);

const deep = await admin('/cleanup', 'POST', { level: 'deep' });
const usageAfterDeep = (await admin('/usage')).json.usage.totals.requests;
const stateAfterDeep = (await admin('/state')).json;
check('清除不必要数据把用量也清了', deep.status === 200 && usageAfterDeep === 0, `requests=${usageAfterDeep}`);
check('清除不必要数据保留账号和 Key', stateAfterDeep.accounts.length > 0 && stateAfterDeep.keys.length > 0, `accounts=${stateAfterDeep.accounts.length} keys=${stateAfterDeep.keys.length}`);

const noConfirm = await admin('/cleanup', 'POST', { level: 'full' });
check('全部清理必须带 confirm', noConfirm.status === 400, String(noConfirm.status));
const full = await admin('/cleanup', 'POST', { level: 'full', confirm: 'DELETE' });
const stateAfterFull = (await admin('/state')).json;
check('全部清理清空账号并补一个新 Key', full.status === 200 && stateAfterFull.accounts.length === 0 && stateAfterFull.keys.length === 1, JSON.stringify(full.json?.done));
const stillLoggedIn = await admin('/session');
check('全部清理之后还能登录（密码保留）', stillLoggedIn.json?.authed === true, JSON.stringify(stillLoggedIn.json));

console.log(`\n集成测试：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
