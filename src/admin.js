// 管理后台 API：/admin/api/*
// 鉴权：管理员密码 → HMAC 签名 cookie（无状态，重启后仍有效，除非改密码）。
// 防跨站：cookie 用 SameSite=Lax，另外对带 Origin 的写请求做同源校验。
import { store } from './store.js';
import { config } from './config.js';
import { catalog, catalogMeta, refreshCatalog, tierOf } from './models.js';
import { callWorker, eligibleAccounts, workerHealth } from './engine.js';
import { probeAccount } from './probe.js';
import { startFlow, getFlow, cancelFlow, publicFlow } from './login-flow.js';
import { browserFeature, startBrowserForFlow, getSession } from './browser.js';
import {
  sendJson,
  readJson,
  parseCookies,
  serializeCookie,
  signToken,
  verifyToken,
  clientIp,
  publicBaseUrl,
  createRateLimiter,
  maskSecret,
  nowIso,
} from './util.js';

const COOKIE = 'myapi_admin';
const loginLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 10 });

export function isAuthed(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return false;
  const payload = verifyToken(token, store.secret);
  return Boolean(payload && payload.sub === 'admin');
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // 非浏览器发起（curl 之类）不做限制
  try {
    const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim();
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function issueCookie(req) {
  const exp = Date.now() + config.sessionTtlMs;
  const token = signToken({ sub: 'admin', iat: Date.now(), exp }, store.secret);
  const secure = publicBaseUrl(req).startsWith('https://');
  return serializeCookie(COOKIE, token, { maxAge: config.sessionTtlMs / 1000, secure, sameSite: 'Lax' });
}

function accountView(acct, workerStates) {
  const wk = workerStates?.get(acct.token.slice(0, 8)) || null;
  return {
    id: acct.id,
    email: acct.email || '',
    name: acct.name || '',
    pool: acct.pool || 'any',
    enabled: acct.enabled !== false,
    active: store.settings.activeAccountId === acct.id,
    source: acct.source || 'manual',
    createdAt: acct.createdAt,
    lastUsedAt: acct.lastUsedAt,
    tokenMasked: maskSecret(acct.token, 8),
    status: acct.status || null,
    workerState: wk ? { state: wk.state, alive: wk.alive } : null,
  };
}

function keyView(k) {
  return {
    id: k.id,
    name: k.name,
    key: k.key,
    allowPaid: Boolean(k.allowPaid),
    models: k.models || [],
    enabled: k.enabled !== false,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
    requests: k.requests || 0,
  };
}

async function liveModelIds() {
  try {
    const resp = await callWorker('/v1/models');
    const data = await resp.json();
    return Array.isArray(data?.data) ? data.data.map((m) => m.id).filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function buildState(req) {
  const base = publicBaseUrl(req);
  let health = null;
  const workerStates = new Map();
  try {
    health = await workerHealth();
    for (const d of health?.account_details || []) {
      if (d.token) workerStates.set(String(d.token).replace(/\.\.\.$/, ''), d);
    }
  } catch {}
  await refreshCatalog().catch(() => {});
  const models = catalog(await liveModelIds());
  const freeCount = models.filter((m) => m.tier === 'free').length;
  return {
    ok: true,
    version: config.version,
    now: nowIso(),
    baseUrl: base,
    apiBase: `${base}/v1`,
    workerVersion: health?.version || null,
    storage: {
      dir: config.dataDir,
      persistent: config.persistentData,
      onRailway: config.onRailway,
      volume: config.railwayVolume || null,
    },
    browser: browserFeature(),
    settings: store.settings,
    accounts: store.accounts.map((a) => accountView(a, workerStates)),
    keys: store.keys.map(keyView),
    models,
    modelStats: { total: models.length, free: freeCount, paid: models.length - freeCount, ...catalogMeta() },
    health: health
      ? {
          status: health.status,
          accounts: health.accounts,
          alive: health.alive_accounts,
          unknown: health.unknown_accounts,
          states: health.account_states,
        }
      : null,
    hasCustomPassword: Boolean(store.data.adminPassword),
  };
}

export async function handleAdminApi(req, res, url) {
  const path = url.pathname.replace(/^\/admin\/api/, '') || '/';
  const method = req.method || 'GET';

  // --- 免鉴权：查会话 + 登录 ---
  if (path === '/session' && method === 'GET') {
    return sendJson(res, 200, {
      authed: isAuthed(req),
      hasPassword: store.hasPassword(),
      version: config.version,
      needsSetup: !store.hasPassword(),
    });
  }

  if (path === '/login' && method === 'POST') {
    const ip = clientIp(req);
    const limit = loginLimiter.check(`login:${ip}`);
    if (!limit.ok) {
      return sendJson(res, 429, {
        ok: false,
        error: `密码错误次数过多，请 ${Math.ceil(limit.retryAfterMs / 60000)} 分钟后再试`,
      });
    }
    const body = await readJson(req, 8 * 1024);
    if (!store.hasPassword()) {
      return sendJson(res, 500, { ok: false, error: '服务端没有设置 ADMIN_PASSWORD，请在 Railway 变量里加上后重新部署' });
    }
    if (!store.verifyPassword(body.password)) {
      loginLimiter.hit(`login:${ip}`);
      console.warn(`[admin] 密码错误 from ${ip}`);
      return sendJson(res, 401, { ok: false, error: '密码不对' });
    }
    loginLimiter.reset(`login:${ip}`);
    return sendJson(res, 200, { ok: true }, { 'set-cookie': issueCookie(req) });
  }

  if (path === '/logout' && method === 'POST') {
    return sendJson(res, 200, { ok: true }, { 'set-cookie': serializeCookie(COOKIE, '', { maxAge: 0 }) });
  }

  // --- 以下全部需要登录 ---
  if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: '未登录或会话已过期' });
  if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(req)) {
    return sendJson(res, 403, { ok: false, error: '跨站请求被拒绝' });
  }

  if (path === '/state' && method === 'GET') {
    return sendJson(res, 200, await buildState(req));
  }

  if (path === '/password' && method === 'POST') {
    const body = await readJson(req, 8 * 1024);
    const next = String(body.next || '');
    if (next.length < 6) return sendJson(res, 400, { ok: false, error: '新密码至少 6 位' });
    store.setPassword(next);
    return sendJson(res, 200, { ok: true, note: '密码已更新，其它设备的登录状态已失效' }, { 'set-cookie': issueCookie(req) });
  }

  // --- 账号池 ---
  if (path === '/accounts' && method === 'POST') {
    const body = await readJson(req, 256 * 1024);
    const raw = String(body.token || '');
    const pool = body.pool || 'any';
    const tokens = raw.split(/[\s,]+/).map((t) => t.trim()).filter((t) => t.length > 8);
    if (!tokens.length) return sendJson(res, 400, { ok: false, error: '没解析出有效 token' });
    const added = [];
    for (const token of tokens) {
      const { account } = store.addAccount({
        token,
        email: tokens.length === 1 ? String(body.email || '') : '',
        name: tokens.length === 1 ? String(body.name || '') : '',
        pool,
        source: 'manual',
      });
      added.push(account.id);
    }
    return sendJson(res, 200, { ok: true, added: added.length, ids: added });
  }

  if (path === '/accounts/check-all' && method === 'POST') {
    const results = [];
    for (const acct of store.accounts) {
      const result = await probeAccount(acct.token);
      store.setAccountStatus(acct.id, result);
      results.push({ id: acct.id, ...result });
    }
    return sendJson(res, 200, { ok: true, results });
  }

  const acctMatch = path.match(/^\/accounts\/([\w-]+)(\/check|\/activate)?$/);
  if (acctMatch) {
    const id = acctMatch[1];
    const acct = store.accounts.find((a) => a.id === id);
    if (!acct) return sendJson(res, 404, { ok: false, error: '账号不存在' });

    if (acctMatch[2] === '/check' && method === 'POST') {
      const result = await probeAccount(acct.token);
      store.setAccountStatus(id, result);
      return sendJson(res, 200, { ok: true, status: store.accounts.find((a) => a.id === id).status });
    }
    if (acctMatch[2] === '/activate' && method === 'POST') {
      if (!acct.enabled) return sendJson(res, 400, { ok: false, error: '这个账号是停用状态，先启用再设为当前' });
      store.setActiveAccount(id);
      return sendJson(res, 200, { ok: true, activeAccountId: id });
    }
    if (method === 'PATCH') {
      const body = await readJson(req, 64 * 1024);
      store.updateAccount(id, body);
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'DELETE') {
      store.removeAccount(id);
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'GET') {
      // 显式索取完整 token（备份/迁移用）
      return sendJson(res, 200, { ok: true, token: acct.token, email: acct.email });
    }
  }

  // --- API keys ---
  if (path === '/keys' && method === 'POST') {
    const body = await readJson(req, 64 * 1024);
    const key = store.addKey({
      name: String(body.name || '未命名'),
      allowPaid: body.allowPaid,
      models: Array.isArray(body.models) ? body.models.map(String) : [],
    });
    return sendJson(res, 200, { ok: true, key: keyView(key) });
  }

  const keyMatch = path.match(/^\/keys\/([\w-]+)$/);
  if (keyMatch) {
    const id = keyMatch[1];
    if (method === 'PATCH') {
      const body = await readJson(req, 64 * 1024);
      const updated = store.updateKey(id, body);
      if (!updated) return sendJson(res, 404, { ok: false, error: 'key 不存在' });
      return sendJson(res, 200, { ok: true, key: keyView(updated) });
    }
    if (method === 'DELETE') {
      if (store.keys.length <= 1) return sendJson(res, 400, { ok: false, error: '至少保留一个 API key' });
      store.removeKey(id);
      return sendJson(res, 200, { ok: true });
    }
  }

  // --- 设置 / 模型 ---
  if (path === '/settings' && method === 'PATCH') {
    const body = await readJson(req, 256 * 1024);
    return sendJson(res, 200, { ok: true, settings: store.updateSettings(body) });
  }

  if (path === '/models' && method === 'GET') {
    await refreshCatalog().catch(() => {});
    const models = catalog(await liveModelIds());
    return sendJson(res, 200, { ok: true, models, meta: catalogMeta() });
  }

  if (path === '/models/refresh' && method === 'POST') {
    await refreshCatalog(true).catch(() => {});
    const models = catalog(await liveModelIds());
    return sendJson(res, 200, { ok: true, models, meta: catalogMeta() });
  }

  if (path === '/models/tier' && method === 'POST') {
    const body = await readJson(req, 16 * 1024);
    const overrides = { ...(store.settings.modelTierOverrides || {}) };
    if (body.tier === 'auto') delete overrides[String(body.id)];
    else overrides[String(body.id)] = body.tier === 'paid' ? 'paid' : 'free';
    store.updateSettings({ modelTierOverrides: overrides });
    return sendJson(res, 200, { ok: true, tier: tierOf(String(body.id)) });
  }

  // --- 登录流程（授权链接 / 内置浏览器）---
  if (path === '/login-flow' && method === 'POST') {
    const body = await readJson(req, 16 * 1024);
    const mode = body.mode === 'browser' ? 'browser' : 'link';
    if (mode === 'browser' && !browserFeature().available) {
      return sendJson(res, 501, { ok: false, error: browserFeature().reason || '内置浏览器不可用' });
    }
    let flow;
    try {
      flow = await startFlow({ mode, pool: body.pool });
    } catch (err) {
      return sendJson(res, err.statusCode || 502, { ok: false, error: err.message });
    }
    if (mode === 'browser') {
      try {
        await startBrowserForFlow(flow, { profile: body.profile === 'shared' ? 'shared' : 'fresh' });
      } catch (err) {
        cancelFlow(flow.id); // 浏览器起不来就别让轮询在后台空转 10 分钟
        return sendJson(res, err.statusCode || 500, { ok: false, error: err.message, flow: publicFlow(flow) });
      }
    }
    return sendJson(res, 200, { ok: true, flow: publicFlow(flow) });
  }

  const flowMatch = path.match(/^\/login-flow\/([\w-]+)(\/cancel|\/browser|\/navigate)?$/);
  if (flowMatch) {
    const flow = getFlow(flowMatch[1]);
    if (!flow) return sendJson(res, 404, { ok: false, error: '登录流程不存在或已过期' });
    const action = flowMatch[2] || '';
    if (method === 'GET' && !action) return sendJson(res, 200, { ok: true, flow: publicFlow(flow) });
    if (action === '/cancel' && method === 'POST') {
      cancelFlow(flow.id);
      return sendJson(res, 200, { ok: true, flow: publicFlow(flow) });
    }
    if (action === '/browser' && method === 'POST') {
      const body = await readJson(req, 16 * 1024);
      try {
        await startBrowserForFlow(flow, { profile: body.profile === 'shared' ? 'shared' : 'fresh' });
      } catch (err) {
        return sendJson(res, err.statusCode || 500, { ok: false, error: err.message });
      }
      return sendJson(res, 200, { ok: true, flow: publicFlow(flow) });
    }
    if (action === '/navigate' && method === 'POST') {
      const body = await readJson(req, 16 * 1024);
      const session = getSession(flow.id);
      if (!session) return sendJson(res, 400, { ok: false, error: '这个流程没有内置浏览器会话' });
      await session.enqueueInput({ t: 'navigate', url: String(body.url || flow.loginUrl) });
      return sendJson(res, 200, { ok: true });
    }
  }

  // --- 备份 / 恢复 / 自检 ---
  if (path === '/export' && method === 'GET') {
    return sendJson(res, 200, store.exportData(), {
      'content-disposition': `attachment; filename="myapi-backup-${Date.now()}.json"`,
    });
  }

  if (path === '/import' && method === 'POST') {
    const body = await readJson(req, 2 * 1024 * 1024);
    try {
      const result = store.importData(body.payload || body, { replace: Boolean(body.replace) });
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      return sendJson(res, err.statusCode || 400, { ok: false, error: err.message });
    }
  }

  // 自检：用当前账号池真实打一次最便宜的免费模型，确认端到端可用
  if (path === '/selftest' && method === 'POST') {
    const body = await readJson(req, 16 * 1024);
    const model = String(body.model || 'deepseek/deepseek-v4-flash');
    const accounts = eligibleAccounts(model);
    if (!accounts.length) return sendJson(res, 400, { ok: false, error: '账号池里没有可用账号' });
    const started = Date.now();
    const resp = await callWorker('/v1/chat/completions', {
      method: 'POST',
      tokens: accounts.map((a) => a.token),
      body: { model, messages: [{ role: 'user', content: String(body.prompt || '只回复两个字：收到') }], stream: false },
    });
    const text = await resp.text();
    let reply = '';
    try {
      reply = JSON.parse(text)?.choices?.[0]?.message?.content || '';
    } catch {}
    return sendJson(res, 200, {
      ok: resp.status === 200,
      status: resp.status,
      ms: Date.now() - started,
      model,
      reply: reply.slice(0, 500),
      raw: resp.status === 200 ? undefined : text.slice(0, 800),
    });
  }

  // ADMIN_ROUTES_MARKER


  return sendJson(res, 404, { ok: false, error: `未知接口 ${method} ${path}` });
}
