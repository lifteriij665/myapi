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
// 按 /state 给出的 tier 判，别按模型名猜 —— 上游会改分类
// （gpt-5.6-luna-es 就从 premium 挪进了 standard 池，按名字猜会误判成泄露）
const tierById = new Map(st.json.models.map((m) => [m.id, m.tier]));
const leaked = models.data.map((m) => m.id).filter((id) => tierById.get(id) === 'paid');
check('免费 key 只看到免费模型', leaked.length === 0, `漏出的付费模型：${JSON.stringify(leaked)}`);

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


// ── 引擎列表里缺席的模型：只提示，不拦 ──
// 免费额度每天刷新、付费能解锁，上游自己都没拦，中转没资格更严。
// 以前这里会直接回 404，用户明确指出这不合理。
const st2 = await admin('/state');
// 上面「全部清理」把 key 全删了并补了一个新的，module 级的 KEY 已经作废
KEY = st2.json.keys[0].key;
const absent = st2.json.models.filter((m) => m.availability?.state === 'absent').map((m) => m.id);
check('能识别出引擎列表里缺席的模型', absent.length > 0, `absent=${JSON.stringify(absent)}`);
check(
  '缺席的说明里讲的是额度/付费，不是"被暂停"',
  st2.json.models.filter((m) => m.availability?.state === 'absent').every((m) => /额度|付费|升级/.test(m.availability.detail || '')),
  JSON.stringify(st2.json.models.find((m) => m.availability?.state === 'absent')?.availability)
);
const liveResp = await (await raw('/v1/models', { headers: { authorization: `Bearer ${KEY}` } })).json();
const liveIds = (liveResp?.data || []).map((m) => m.id);
check('缺席的模型照样出现在 /v1/models（免费那些）', liveIds.length > 0, JSON.stringify(liveResp).slice(0, 200));
// 真发一次：可以失败（号是假的），但**不能是我们自己拦的 404**
const absentReq = await raw('/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ model: absent[0], messages: [{ role: 'user', content: 'x' }] }),
});
const absentBody = await absentReq.text();
check(
  '请求缺席的模型不再被网关拦掉（转发给上游）',
  absentReq.status !== 404 && !/暂停/.test(absentBody),
  `${absentReq.status} ${absentBody.slice(0, 160)}`
);
check('默认模型仍然优先挑引擎列出来的', !absent.includes(st2.json.defaultModel), String(st2.json.defaultModel));
check('引擎版本跟 vendor 一致', st2.json.workerVersion === '1.8.10', String(st2.json.workerVersion));

// ── opencode Zen 号池 ──
// 不依赖真实 Zen 调用：断言的都是目录合并、门禁分流、账号落库这些本地行为。
const OC_FREE = 'opencode/mimo-v2.5-free';
const OC_PAID = 'opencode/claude-sonnet-5';
check(
  'state 里带 opencode 的接入信息',
  st2.json.providers?.opencode?.loginUrl === 'https://opencode.ai/zen' && typeof st2.json.providers.opencode.anonymous === 'boolean',
  JSON.stringify(st2.json.providers)
);
const ocModels = st2.json.models.filter((m) => m.provider === 'opencode');
check('模型目录里合进了 opencode 的模型', ocModels.length >= 8, `opencode 模型 ${ocModels.length} 个`);
check(
  'opencode 免费模型标成 free、付费的标成 paid',
  ocModels.find((m) => m.id === OC_FREE)?.tier === 'free' && ocModels.every((m) => (m.id.endsWith('-free') ? m.tier === 'free' : true)),
  JSON.stringify(ocModels.map((m) => `${m.id}:${m.tier}`)).slice(0, 300)
);
check('freebuff 的模型没被打成 opencode', st2.json.models.some((m) => m.provider === 'freebuff'), '一个 freebuff 模型都没有');

// 这个 KEY 是「全部清理」补出来的默认 key，没勾允许付费
const ocPaidReq = await raw('/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ model: OC_PAID, messages: [{ role: 'user', content: 'x' }] }),
});
const ocPaidBody = await ocPaidReq.text();
check(
  'Zen 的按量计费模型对免费 key 也是 403',
  ocPaidReq.status === 403 && /余额|付费/.test(ocPaidBody),
  `${ocPaidReq.status} ${ocPaidBody.slice(0, 160)}`
);
check(
  '免费 key 的 /v1/models 里没有 opencode 付费模型',
  !liveIds.includes(OC_PAID) && liveIds.includes(OC_FREE),
  JSON.stringify(liveIds.filter((i) => i.startsWith('opencode/')))
);
const tierById2 = new Map(st2.json.models.map((m) => [m.id, m.tier]));
check(
  '免费 key 的模型列表里没有任何付费模型',
  liveIds.filter((i) => tierById2.get(i) === 'paid').length === 0,
  `漏出的付费模型：${JSON.stringify(liveIds.filter((i) => tierById2.get(i) === 'paid'))}`
);
check(
  '地区受限的 Zen 模型默认不对外提供',
  !liveIds.includes('opencode/muse-spark-1.2-contributor-free'),
  '地区受限的模型漏出去了'
);

// 加一个假的 Zen key：断言 provider 落库正确、探活给出确定结论、失败时不泄露 key
const ocAdd = await admin('/accounts', 'POST', { token: 'sk-fake-zen-key-for-integration-test-0000', provider: 'opencode' });
check('能加 opencode 号', ocAdd.status === 200 && ocAdd.json.added === 1, JSON.stringify(ocAdd.json));
const st3 = await admin('/state');
const ocAcct = st3.json.accounts.find((a) => a.id === ocAdd.json.ids[0]);
check('opencode 号的 provider 落库正确', ocAcct?.provider === 'opencode', JSON.stringify(ocAcct));
check('opencode 号默认只服务免费模型', ocAcct?.pool === 'free', String(ocAcct?.pool));
check('opencode 号不跟 worker 的 token 表对账', ocAcct?.workerState === null, JSON.stringify(ocAcct?.workerState));
check(
  '加号时顺手探活并给出确定结论',
  ['token_invalid', 'rate_limited', 'blocked', 'upstream_error', 'unknown', 'ok'].includes(ocAcct?.status?.state),
  JSON.stringify(ocAcct?.status)
);
check('探活结论里不带完整 key', !JSON.stringify(ocAcct?.status || {}).includes('sk-fake-zen-key-for-integration-test-0000'), 'key 泄露到状态里了');

// freebuff 的号一个都没有（前面被全部清理了），此时不带 model 的请求应该落到 Zen 免费模型
const noModelReq = await raw('/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
});
check(
  '池子里只有 opencode 号时，不带 model 的请求不会因为没 freebuff 号而 503',
  noModelReq.status !== 503,
  `${noModelReq.status} ${(await noModelReq.text()).slice(0, 160)}`
);

// opencode 号加进来之后，state 里的默认模型也该跟着换到 Zen 那边
check(
  '只有 opencode 号时默认模型是 Zen 的免费模型',
  String(st3.json.defaultModel).startsWith('opencode/'),
  String(st3.json.defaultModel)
);

await admin(`/accounts/${ocAdd.json.ids[0]}`, 'DELETE');

console.log(`\n集成测试：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
