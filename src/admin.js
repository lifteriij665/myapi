// 管理后台 API：/admin/api/*
// 鉴权：管理员密码 → HMAC 签名 cookie（无状态，重启后仍有效，除非改密码）。
// 防跨站：cookie 用 SameSite=Lax，另外对带 Origin 的写请求做同源校验。
import { store, providerOf, PROVIDERS } from './store.js';
import { config } from './config.js';
import { catalog, catalogMeta, refreshCatalog, tierOf, defaultModel, noteEngineModelList } from './models.js';
import { callWorker, eligibleAccounts, workerHealth } from './engine.js';
import { probeAccount } from './probe.js';
import { probeOpencodeKey, callOpencode } from './opencode.js';
import { isOpencodeModel, stripPrefix } from './models-opencode.js';
import {
  upstreamViews,
  addUpstream,
  updateUpstream,
  removeUpstream,
  getUpstream,
  addUpstreamModels,
  removeUpstreamModel,
  setRotationRule,
  setRotationRules,
  FORMAT_LABEL,
  ROTATION_LABEL,
  ROTATION_HINT,
} from './upstreams.js';
import { fetchUpstreamModels, probeUpstreamKey } from './protocols/index.js';
import { startFlow, getFlow, cancelFlow, publicFlow, startOpencodeFlow, finishOpencodeFlow } from './login-flow.js';
import { browserFeature, startBrowserForFlow, getSession } from './browser.js';
import { usage } from './usage.js';
import { chatLogStatus, chatLogFiles, recentChats, readChatLogFile, clearChatLog } from './chatlog.js';
import { inspectStorage, cleanupPreview, runCleanup } from './maintenance.js';
import {
  sendJson,
  sendText,
  readJson,
  parseCookies,
  serializeCookie,
  signToken,
  verifyToken,
  clientIp,
  publicBaseUrl,
  createRateLimiter,
  createGate,
  sleep,
  maskSecret,
  nowIso,
} from './util.js';

const COOKIE = 'myapi_admin';
// 按 IP 硬限流（10 次/10 分钟）。另外加一道全局软限速：X-Forwarded-For 左边是
// 客户端可控的，万一取 IP 的方式在某个平台上不准，攻击者可以靠伪造 IP 绕开按 IP 的
// 计数。全局这道超过阈值后只延迟不拒绝 —— 硬拒会变成"攻击者一直打，管理员自己
// 也进不来"的拒绝服务。
const loginLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 10 });
const loginGlobalLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 30 });
const LOGIN_THROTTLE_MS = parseInt(process.env.LOGIN_THROTTLE_MS || '2000', 10);
// 同一时刻只允许两个密码校验在跑：scrypt 每次几十毫秒，几百个并发请求
// 能把线程池和事件循环一起拖住，连 /healthz 都会超时
const loginGate = createGate(2);

/** 密码校验的公共入口：先记账再验证（fail-closed），并发也要走闸门 */
async function attemptPassword(req, password, ip) {
  const perIp = loginLimiter.check(`login:${ip}`);
  if (!perIp.ok) return { ok: false, status: 429, error: `尝试次数过多，请 ${Math.ceil(perIp.retryAfterMs / 60000)} 分钟后再试` };
  if (!loginGate.tryEnter()) return { ok: false, status: 503, error: '正在处理其它登录请求，稍等一秒再试' };
  try {
    // 关键顺序：先把这次尝试记进计数，再去验证。
    // 反过来（验证失败才记账）意味着同一批并发请求全部通过限流检查。
    loginLimiter.hit(`login:${ip}`);
    const globalOk = loginGlobalLimiter.check('login:all').ok;
    loginGlobalLimiter.hit('login:all');
    if (!globalOk) {
      console.warn(`[admin] 全局失败次数偏高，本次尝试延迟 ${LOGIN_THROTTLE_MS}ms（来源 ${ip}）`);
      await sleep(LOGIN_THROTTLE_MS);
    }
    const ok = await store.verifyPassword(password);
    if (ok) loginLimiter.reset(`login:${ip}`);
    else console.warn(`[admin] 密码错误 from ${ip}`);
    return ok ? { ok: true } : { ok: false, status: 401, error: '密码不对' };
  } finally {
    loginGate.leave();
  }
}

export function isAuthed(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return false;
  const payload = verifyToken(token, store.secret);
  if (!payload || payload.sub !== 'admin') return false;
  // 世代号对不上＝这张 cookie 已经被"改密码 / 一键登出"作废了
  return Number(payload.epoch || 0) === store.sessionEpoch;
}

function sameOrigin(req) {
  // 浏览器会带 Sec-Fetch-Site：cross-site 一律拒，比只看 Origin 可靠
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
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
  const token = signToken({ sub: 'admin', epoch: store.sessionEpoch, iat: Date.now(), exp }, store.secret);
  const secure = publicBaseUrl(req).startsWith('https://');
  // 后台没有"从别的站点跳进来"的需求，用 Strict 把 CSRF 的面再收一层
  return serializeCookie(COOKIE, token, { maxAge: config.sessionTtlMs / 1000, secure, sameSite: 'Strict' });
}

function accountView(acct, workerStates) {
  const provider = providerOf(acct);
  // token 前缀对账只对 freebuff 有意义：那张表是 worker 按 token 前缀记的
  const wk = provider === 'freebuff' ? workerStates?.get(acct.token.slice(0, 8)) || null : null;
  return {
    id: acct.id,
    email: acct.email || '',
    name: acct.name || '',
    provider,
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

/** 探活：每个上游的凭据格式和校验方式都不一样，按 provider 分流 */
async function checkAccount(acct) {
  const prov = providerOf(acct);
  if (prov === 'opencode') return probeOpencodeKey(acct.token);
  if (prov === 'freebuff') return probeAccount(acct.token);
  const up = getUpstream(prov);
  if (!up) return { state: 'unknown', verdict: '上游已删除', detail: '这个号所属的上游不在了，删掉它吧', httpStatus: 0 };
  return probeUpstreamKey(up, acct.token);
}

/**
 * 批量探活。串行跑的话 400 个 key 要好几分钟（每个都是一次真实网络往返），
 * 所以按固定并发跑；上限不能太高，不然会被上游当成扫号。
 */
const PROBE_CONCURRENCY = 6;

async function checkAccounts(accounts) {
  const results = [];
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= accounts.length) return;
      const acct = accounts[i];
      try {
        const result = await checkAccount(acct);
        store.setAccountStatus(acct.id, result);
        results.push({ id: acct.id, ...result });
      } catch (err) {
        // 单个号探活抛错不能带崩整批
        results.push({ id: acct.id, state: 'unknown', verdict: '探测失败', detail: err.message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, accounts.length) }, worker));
  return results;
}

async function liveModelIds() {
  try {
    const resp = await callWorker('/v1/models');
    const data = await resp.json();
    const ids = Array.isArray(data?.data) ? data.data.map((m) => m.id).filter(Boolean) : [];
    // 引擎列表里缺的那些＝引擎按上游"已暂停"名单屏蔽掉的，同步给 models 层
    noteEngineModelList(ids);
    return ids;
  } catch {
    return [];
  }
}

/** SSE 推送用的轻量快照：不碰上游、不遍历磁盘（chatLogStatus 内部有 10 秒缓存） */
function liveSnapshot() {
  const chat = chatLogStatus();
  return {
    at: nowIso(),
    usage: {
      totals: usage.data.totals,
      today: usage.snapshot({ recentLimit: 0 }).today,
      windows: {
        m5: usage.windowStats(5 * 60_000),
        h1: usage.bucketWindow(1),
        h24: usage.bucketWindow(24),
      },
      recent: usage.recent(14),
      eventsHeld: usage.events.length,
    },
    accounts: store.accounts.map((a) => ({
      id: a.id,
      email: a.email || '',
      provider: providerOf(a),
      active: store.settings.activeAccountId === a.id,
      enabled: a.enabled !== false,
      state: a.status?.state || null,
      verdict: a.status?.verdict || null,
      quota: a.status?.quota || '',
    })),
    keys: store.keys.map((k) => ({ id: k.id, name: k.name, requests: k.requests || 0, lastUsedAt: k.lastUsedAt })),
    chatlog: { enabled: chat.enabled, files: chat.files, bytes: chat.bytes, full: chat.full },
  };
}

/**
 * 模型表的指纹。只把"会影响渲染"的字段揉进去（id / 分类 / 启停 / 可用状态），
 * note 和 displayName 这些是从同样的输入算出来的，跟着一起变，不用单独进指纹。
 */
function modelFingerprint(models) {
  let h = 5381;
  for (const m of models) {
    const s = `${m.id}|${m.tier}|${m.enabled ? 1 : 0}|${m.availability?.state || ''}|${m.overridden ? 1 : 0}`;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return `${models.length}-${h.toString(36)}`;
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
  const byProvider = {};
  for (const a of store.accounts) {
    const p = providerOf(a);
    byProvider[p] = (byProvider[p] || 0) + (a.enabled === false ? 0 : 1);
  }
  // 模型表是 /state 里最大的一块（几百个模型时 200KB+），但它几乎不变。
  // 给它算一个指纹：控制台每 20 秒轮询一次，指纹没变就不用重发。
  const modelsTag = modelFingerprint(models);
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
    modelsTag,
    models,
    modelStats: { total: models.length, free: freeCount, paid: models.length - freeCount, ...catalogMeta() },
    defaultModel: defaultModel({ hasFreebuff: store.accounts.some((a) => a.enabled && providerOf(a) === 'freebuff') }),
    providers: {
      counts: byProvider,
      list: upstreamViews(),
      formats: FORMAT_LABEL,
      rotations: ROTATION_LABEL,
      rotationHints: ROTATION_HINT,
      opencode: {
        base: config.opencodeBase,
        anonymous: config.opencodeAnonymous,
        loginUrl: 'https://opencode.ai/zen',
      },
    },
    usageSummary: {
      totals: usage.data.totals,
      today: usage.snapshot({ recentLimit: 0 }).today,
      h1: usage.bucketWindow(1),
      eventsHeld: usage.events.length,
    },
    chatlog: chatLogStatus(),
    health: health
      ? {
          status: health.status,
          accounts: health.accounts,
          alive: health.alive_accounts,
          unknown: health.unknown_accounts,
          states: health.account_states,
        }
      : null,
    credentials: store.credentialSources(),
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
    if (!store.hasPassword()) {
      return sendJson(res, 500, { ok: false, error: '服务端没有设置 ADMIN_PASSWORD，请在 Railway 变量里加上后重新部署' });
    }
    const body = await readJson(req, 8 * 1024);
    const verdict = await attemptPassword(req, body.password, clientIp(req, config.trustProxyHops));
    if (!verdict.ok) return sendJson(res, verdict.status, { ok: false, error: verdict.error });
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
    // 控制台每 20 秒拉一次 /state，模型表却几百 KB 且几乎不变 ——
    // 带上次拿到的指纹（?models=<tag>）时就不重发，只回一个 modelsUnchanged 标记
    const known = url.searchParams.get('models') || '';
    const state = await buildState(req);
    if (known && known === state.modelsTag) {
      const { models, ...rest } = state;
      return sendJson(res, 200, { ...rest, modelsUnchanged: true });
    }
    return sendJson(res, 200, state);
  }

  if (path === '/password' && method === 'POST') {
    const body = await readJson(req, 8 * 1024);
    const next = String(body.next || '');
    // 必须先验当前密码：只偷到一份 cookie 的人不该能改掉密码把真管理员锁在外面
    const verdict = await attemptPassword(req, body.current, clientIp(req, config.trustProxyHops));
    if (!verdict.ok) {
      return sendJson(res, verdict.status === 401 ? 403 : verdict.status, {
        ok: false,
        error: verdict.status === 401 ? '当前密码不对' : verdict.error,
      });
    }
    if (next.length < 10) return sendJson(res, 400, { ok: false, error: '新密码至少 10 位' });
    if (/^\d+$/.test(next)) return sendJson(res, 400, { ok: false, error: '别用纯数字密码' });
    store.setPassword(next);
    return sendJson(
      res,
      200,
      { ok: true, note: '密码已更新，其它设备上的登录状态已全部失效' },
      { 'set-cookie': issueCookie(req) }
    );
  }

  if (path === '/logout-all' && method === 'POST') {
    store.revokeSessions();
    return sendJson(res, 200, { ok: true, note: '所有设备都已登出' }, { 'set-cookie': issueCookie(req) });
  }

  // --- 账号池 ---
  if (path === '/accounts' && method === 'POST') {
    const body = await readJson(req, 256 * 1024);
    const raw = String(body.token || '');
    const provider = PROVIDERS.includes(body.provider) ? body.provider : 'freebuff';
    // opencode 号池默认只服务免费模型（用户明确要求）：pool 不传就按 'free' 落库，
    // 想让它烧 Zen 余额得自己在账号上改成 any/paid
    const pool = body.pool || (provider === 'opencode' ? 'free' : 'any');
    const tokens = raw.split(/[\s,]+/).map((t) => t.trim()).filter((t) => t.length > 8);
    if (!tokens.length) return sendJson(res, 400, { ok: false, error: '没解析出有效 token' });
    const added = [];
    for (const token of tokens) {
      const { account } = store.addAccount({
        token,
        email: tokens.length === 1 ? String(body.email || '') : '',
        name: tokens.length === 1 ? String(body.name || '') : '',
        provider,
        pool,
        source: 'manual',
      });
      added.push(account.id);
    }
    // opencode 的 key 加完顺手探一次活：它没有"登录"步骤，粘错了得马上看出来
    if (provider === 'opencode' && added.length === 1) {
      const acct = store.accounts.find((a) => a.id === added[0]);
      if (acct) {
        const result = await probeOpencodeKey(acct.token).catch(() => null);
        if (result) store.setAccountStatus(acct.id, result);
      }
    }
    return sendJson(res, 200, { ok: true, added: added.length, ids: added });
  }

  if (path === '/accounts/check-all' && method === 'POST') {
    const results = await checkAccounts([...store.accounts]);
    return sendJson(res, 200, { ok: true, results });
  }

  const acctMatch = path.match(/^\/accounts\/([\w-]+)(\/check|\/activate)?$/);
  if (acctMatch) {
    const id = acctMatch[1];
    const acct = store.accounts.find((a) => a.id === id);
    if (!acct) return sendJson(res, 404, { ok: false, error: '账号不存在' });

    if (acctMatch[2] === '/check' && method === 'POST') {
      const result = await checkAccount(acct);
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
    const provider = PROVIDERS.includes(body.provider) ? body.provider : 'freebuff';
    const mode = body.mode === 'browser' ? 'browser' : 'link';
    if (mode === 'browser' && !browserFeature().available) {
      return sendJson(res, 501, { ok: false, error: browserFeature().reason || '内置浏览器不可用' });
    }
    // opencode 没有授权码轮询，只能开页面让用户自己复制 key，所以必须走内置浏览器
    if (provider === 'opencode') {
      if (mode !== 'browser') {
        return sendJson(res, 400, {
          ok: false,
          error: 'opencode 没有授权码登录：请直接去 https://opencode.ai/zen 复制 API key 粘进来，或者用内置浏览器登录',
        });
      }
      const flow = startOpencodeFlow({ pool: body.pool });
      try {
        await startBrowserForFlow(flow, { profile: body.profile === 'shared' ? 'shared' : 'fresh' });
      } catch (err) {
        cancelFlow(flow.id);
        return sendJson(res, err.statusCode || 500, { ok: false, error: err.message, flow: publicFlow(flow) });
      }
      return sendJson(res, 200, { ok: true, flow: publicFlow(flow) });
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

  const flowMatch = path.match(/^\/login-flow\/([\w-]+)(\/cancel|\/browser|\/navigate|\/submit-key)?$/);
  if (flowMatch) {
    const flow = getFlow(flowMatch[1]);
    if (!flow) return sendJson(res, 404, { ok: false, error: '登录流程不存在或已过期' });
    const action = flowMatch[2] || '';
    if (method === 'GET' && !action) return sendJson(res, 200, { ok: true, flow: publicFlow(flow) });
    // 内置浏览器里登录完 opencode，把复制到的 key 交回来
    if (action === '/submit-key' && method === 'POST') {
      if (flow.provider !== 'opencode') return sendJson(res, 400, { ok: false, error: '这个流程不是 opencode 登录' });
      const body = await readJson(req, 16 * 1024);
      let account;
      try {
        account = finishOpencodeFlow(flow, body.token, { name: body.name });
      } catch (err) {
        return sendJson(res, err.statusCode || 400, { ok: false, error: err.message });
      }
      const result = await probeOpencodeKey(account.token).catch(() => null);
      if (result) store.setAccountStatus(account.id, result);
      return sendJson(res, 200, { ok: true, flow: publicFlow(flow), status: result });
    }
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
  // 用 POST 而不是 GET：GET 会落进"恶意页面顶层导航也能触发"的口子里
  // （SameSite 在顶层导航时仍可能带上 cookie），而这个接口吐的是全量明文 token
  if (path === '/export' && method === 'POST') {
    return sendJson(res, 200, store.exportData(), { 'cross-origin-resource-policy': 'same-origin' });
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
    const messages = [{ role: 'user', content: String(body.prompt || '只回复两个字：收到') }];
    // opencode 的模型不经过 vendor/worker.js，自检也得走它自己那条路
    const resp = isOpencodeModel(model)
      ? await callOpencode({
          pathname: '/v1/chat/completions',
          body: { model: stripPrefix(model), messages, stream: false },
          token: accounts[0].token,
        })
      : await callWorker('/v1/chat/completions', {
          method: 'POST',
          tokens: accounts.map((a) => a.token),
          body: { model, messages, stream: false },
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

  // --- 用量统计 ---
  if (path === '/usage' && method === 'GET') {
    return sendJson(res, 200, { ok: true, usage: usage.snapshot({ recentLimit: 80 }) });
  }

  if (path === '/usage/reset' && method === 'POST') {
    usage.reset();
    for (const k of store.keys) k.requests = 0;
    store.saveNow();
    return sendJson(res, 200, { ok: true, note: '用量统计已清零' });
  }

  // 实时推送：控制台不用手动刷新（每 2 秒一帧，只带轻量数据）
  if (path === '/events' && method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const push = () => {
      if (res.writableEnded) return;
      try {
        res.write(`data: ${JSON.stringify(liveSnapshot())}\n\n`);
      } catch {
        /* 客户端断了，下面的 close 会清理 */
      }
    };
    push();
    const tick = setInterval(push, 2000);
    const ping = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 25000);
    res.on('close', () => {
      clearInterval(tick);
      clearInterval(ping);
    });
    return undefined;
  }

  // --- 聊天记录 ---
  if (path === '/chatlog' && method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      status: chatLogStatus(),
      files: chatLogFiles(),
      recent: recentChats(30),
    });
  }

  if (path === '/chatlog/clear' && method === 'POST') {
    const r = clearChatLog();
    return sendJson(res, 200, { ok: true, ...r, note: `已删除 ${r.removed} 个记录文件` });
  }

  const chatFileMatch = path.match(/^\/chatlog\/file\/(chat-\d{4}-\d{2}-\d{2}\.jsonl)$/);
  if (chatFileMatch && method === 'GET') {
    const text = readChatLogFile(chatFileMatch[1]);
    if (text === null) return sendJson(res, 404, { ok: false, error: '文件不存在或过大' });
    return sendText(res, 200, text, 'application/x-ndjson; charset=utf-8', {
      'content-disposition': `attachment; filename="${chatFileMatch[1]}"`,
      'cross-origin-resource-policy': 'same-origin',
    });
  }

  // --- 存储 / 清理 ---
  if (path === '/storage' && method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      storage: inspectStorage(),
      previews: {
        routine: cleanupPreview('routine'),
        deep: cleanupPreview('deep'),
        full: cleanupPreview('full'),
      },
    });
  }

  if (path === '/cleanup' && method === 'POST') {
    const body = await readJson(req, 8 * 1024);
    const level = String(body.level || '');
    if (!['routine', 'deep', 'full'].includes(level)) {
      return sendJson(res, 400, { ok: false, error: '级别只能是 routine / deep / full' });
    }
    // full 会把账号和 key 都删掉，要求前端显式带确认标记，避免误点
    if (level === 'full' && body.confirm !== 'DELETE') {
      return sendJson(res, 400, { ok: false, error: '全部清理需要带 confirm="DELETE"' });
    }
    try {
      const result = await runCleanup(level);
      console.warn(`[maintenance] 执行了「${result.label}」：${result.done.join('、')}`);
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      return sendJson(res, err.statusCode || 500, { ok: false, error: err.message });
    }
  }

  const modelStatusMatch = path.match(/^\/models\/status\/reset$/);
  if (modelStatusMatch && method === 'POST') {
    const body = await readJson(req, 8 * 1024);
    store.clearModelStatus(body.id ? String(body.id) : null);
    return sendJson(res, 200, { ok: true });
  }

  // --- 自定义上游 ---
  if (path === '/upstreams' && method === 'GET') {
    return sendJson(res, 200, { ok: true, upstreams: upstreamViews(), formats: FORMAT_LABEL, rotations: ROTATION_LABEL, rotationHints: ROTATION_HINT });
  }

  if (path === '/upstreams' && method === 'POST') {
    const body = await readJson(req, 64 * 1024);
    let up;
    try {
      up = addUpstream(body);
    } catch (err) {
      return sendJson(res, err.statusCode || 400, { ok: false, error: err.message });
    }
    // 顺手把一起提交的 key 加进号池（一行一个，支持一次贴几十个）
    const added = [];
    for (const raw of String(body.keys || '').split(/[\s,]+/)) {
      const token = raw.trim();
      if (token.length <= 8) continue;
      try {
        const { account } = store.addAccount({ token, provider: up.id, pool: up.defaultTier === 'free' ? 'free' : 'any', source: 'manual' });
        added.push(account.id);
      } catch {
        /* 单个 key 不合格就跳过，不要让整批失败 */
      }
    }
    return sendJson(res, 200, { ok: true, upstream: up, addedKeys: added.length });
  }

  const upMatch = path.match(/^\/upstreams\/([\w-]+)(\/models|\/models\/fetch|\/keys|\/rotation|\/check)?$/);
  if (upMatch) {
    const id = upMatch[1];
    const up = getUpstream(id);
    if (!up) return sendJson(res, 404, { ok: false, error: '上游不存在' });
    const action = upMatch[2] || '';

    if (action === '/rotation' && method === 'POST') {
      const body = await readJson(req, 16 * 1024);
      try {
        const rule = setRotationRule(id, body);
        return sendJson(res, 200, { ok: true, rotation: rule });
      } catch (err) {
        return sendJson(res, err.statusCode || 400, { ok: false, error: err.message });
      }
    }

    // 用池子里的 key 去问上游要模型列表
    if (action === '/models/fetch' && method === 'POST') {
      if (up.builtin) return sendJson(res, 400, { ok: false, error: '内置上游的模型表是自动维护的，不用手动拉' });
      const keys = store.accounts.filter((a) => providerOf(a) === id && a.enabled !== false);
      if (!keys.length) return sendJson(res, 400, { ok: false, error: '这个上游还没有 API key，先加一个再拉模型' });
      let ids = null;
      let tried = 0;
      // 依次试，直到有一个 key 能拉到（有的 key 可能已经废了）。
      // 但最多试 5 个：一个上游可能挂着几十个 key，全试一遍要几分钟，
      // 而且如果前 5 个都拉不到，基本就是这个上游没实现 /models。
      const MAX_TRY = 5;
      for (const acct of keys.slice(0, MAX_TRY)) {
        tried++;
        ids = await fetchUpstreamModels(up, acct.token).catch(() => null);
        if (ids?.length) break;
      }
      if (!ids?.length) {
        return sendJson(res, 502, {
          ok: false,
          error: `试了 ${tried} 个 key 都没拉到模型列表（这个上游可能没实现 /models 接口）—— 直接手动填模型名即可`,
        });
      }
      addUpstreamModels(id, ids, { replace: true });
      return sendJson(res, 200, { ok: true, models: ids, count: ids.length });
    }

    // 手动增删模型
    if (action === '/models' && method === 'POST') {
      const body = await readJson(req, 64 * 1024);
      const list = Array.isArray(body.models) ? body.models : String(body.models || '').split(/[\s,]+/);
      const clean = list.map((s) => String(s).trim()).filter(Boolean);
      if (!clean.length) return sendJson(res, 400, { ok: false, error: '没解析出模型名' });
      const next = addUpstreamModels(id, clean, { replace: Boolean(body.replace) });
      return sendJson(res, 200, { ok: true, models: next.models });
    }
    if (action === '/models' && method === 'DELETE') {
      const body = await readJson(req, 16 * 1024);
      const next = removeUpstreamModel(id, String(body.model || ''));
      return sendJson(res, 200, { ok: true, models: next?.models || [] });
    }

    // 批量加 key
    if (action === '/keys' && method === 'POST') {
      const body = await readJson(req, 512 * 1024);
      const tokens = String(body.keys || body.token || '').split(/[\s,]+/).map((t) => t.trim()).filter((t) => t.length > 8);
      if (!tokens.length) return sendJson(res, 400, { ok: false, error: '没解析出有效的 API key' });
      const pool = body.pool || (up.defaultTier === 'free' ? 'free' : 'any');
      const added = [];
      let skipped = 0;
      for (const token of tokens) {
        try {
          const before = store.accounts.length;
          const { account } = store.addAccount({ token, provider: id, pool, source: 'manual' });
          if (store.accounts.length === before) skipped++;
          added.push(account.id);
        } catch {
          skipped++;
        }
      }
      return sendJson(res, 200, { ok: true, added: added.length, skipped, ids: added });
    }

    // 逐个探活这个上游名下的 key
    if (action === '/check' && method === 'POST') {
      const results = await checkAccounts(store.accounts.filter((a) => providerOf(a) === id));
      return sendJson(res, 200, { ok: true, results });
    }

    if (method === 'PATCH') {
      try {
        const next = updateUpstream(id, await readJson(req, 64 * 1024));
        return sendJson(res, 200, { ok: true, upstream: next });
      } catch (err) {
        return sendJson(res, err.statusCode || 400, { ok: false, error: err.message });
      }
    }
    if (method === 'DELETE') {
      if (up.builtin) return sendJson(res, 400, { ok: false, error: '内置上游不能删' });
      const r = removeUpstream(id);
      return sendJson(res, 200, { ok: true, removedAccounts: r?.removedAccounts || 0 });
    }
    if (method === 'GET') {
      return sendJson(res, 200, { ok: true, upstream: upstreamViews().find((u) => u.id === id) || null });
    }
  }

  // 批量套用同一个换号策略（控制台的「一键应用」）
  if (path === '/rotation/bulk' && method === 'POST') {
    const body = await readJson(req, 16 * 1024);
    try {
      const applied = setRotationRules(body.providers, body.mode);
      return sendJson(res, 200, { ok: true, applied, mode: body.mode });
    } catch (err) {
      return sendJson(res, err.statusCode || 400, { ok: false, error: err.message });
    }
  }

  // ADMIN_ROUTES_MARKER


  return sendJson(res, 404, { ok: false, error: `未知接口 ${method} ${path}` });
}
