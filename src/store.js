// 数据落盘：一个 JSON 文件放账号池 / API key / 设置。
// 原子写（tmp + rename）+ 0600 权限；写入做 200ms 合并，避免频繁 IO。
import { readFileSync, writeFileSync, renameSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { dirname } from 'node:path';
import { config } from './config.js';
import { randomId, generateApiKey, nowIso, constantTimeEqual } from './util.js';

const scryptAsync = promisify(scrypt);
const CURRENT_VERSION = 1;

// 内置上游。'freebuff' 走 vendor/worker.js，'opencode' 直连 opencode.ai/zen。
// 除这两个之外，用户还能在控制台加任意多个自定义上游（见 src/upstreams.js），
// 它们的 id 形如 'up_xxxx'，也会出现在 account.provider 上。
export const PROVIDERS = ['freebuff', 'opencode'];

const CUSTOM_ID_RE = /^up_[a-f0-9]{8}$/;

/** 这个字符串能不能当 provider 用（内置的两个，或者自定义上游的 id 形状） */
export function isProviderId(value) {
  const p = String(value || '');
  return PROVIDERS.includes(p) || CUSTOM_ID_RE.test(p);
}

/**
 * 账号属于哪个上游。老数据文件里的账号没有 provider 字段，一律当 freebuff ——
 * 这个默认值必须放在读取侧而不是只在 load() 里补，因为单测会直接给
 * store.data.accounts 赋值，绕过 load()。
 */
export function providerOf(account) {
  const p = account?.provider;
  return isProviderId(p) ? p : 'freebuff';
}

export function normalizeProvider(value) {
  const p = String(value || '').trim();
  if (isProviderId(p)) return p;
  const lower = p.toLowerCase();
  return PROVIDERS.includes(lower) ? lower : 'freebuff';
}

function emptyData() {
  return {
    version: CURRENT_VERSION,
    createdAt: nowIso(),
    secret: randomBytes(32).toString('hex'),
    // 会话世代号：改密码 / 一键登出会 +1，已经签发的 cookie 立刻作废。
    // 这样即使配了固定的 SESSION_SECRET（secret 不轮换），吊销也是真的生效。
    sessionEpoch: 1,
    adminPassword: null, // { salt, hash, generated? } —— 在控制台改过密码才有；否则用环境变量 ADMIN_PASSWORD
    settings: {
      allowPaidDefault: config.allowPaidDefault,
      disabledModels: [], // 手动下架的模型 id
      modelTierOverrides: {}, // modelId -> 'free' | 'paid'
      browserLoginEnabled: config.enableBrowserLogin,
      // 账号选择：钉住一个号用到失败为止（不轮询）。autoSwitch=false 时只用
      // activeAccountId 指定的那个号，失败也不自动换。
      autoSwitch: true,
      activeAccountId: null,
      // 模型列表：把实测确认不可用的模型从 /v1/models 里藏掉
      hideUnavailableModels: true,
      // 客户端不写 model 时用哪个；留空＝自动挑当前不限量的那一档
      defaultModel: '',
      // 每个上游一份换号策略：providerId -> { mode, activeAccountId }
      // 见 src/upstreams.js。缺省时按老的 autoSwitch 开关翻译，升级不改行为。
      rotationRules: {},
      // 聊天记录留存（默认关）
      chatLogEnabled: false,
      chatLogMaxMB: 200,
      chatLogMaxRecordKB: 256,
    },
    // 模型实测状态：id -> { state, at, detail, fails }
    modelStatus: {},
    // 自定义上游（内置那两个不在这里，见 src/upstreams.js 的 BUILTIN）
    upstreams: [],
    accounts: [],
    keys: [],
  };
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(String(password), salt, 32).toString('hex') };
}

class Store {
  constructor() {
    this.data = emptyData();
    this._timer = null;
    this._loaded = false;
  }

  load() {
    mkdirSync(dirname(config.dataFile), { recursive: true });
    if (existsSync(config.dataFile)) {
      try {
        const parsed = JSON.parse(readFileSync(config.dataFile, 'utf8'));
        this.data = { ...emptyData(), ...parsed };
        this.data.settings = { ...emptyData().settings, ...(parsed.settings || {}) };
        this.data.accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
        // 老数据文件里的账号没有 provider，补成 freebuff（这个版本之前只有那一个上游）
        for (const a of this.data.accounts) if (!isProviderId(a?.provider)) a.provider = 'freebuff';
        this.data.upstreams = Array.isArray(parsed.upstreams) ? parsed.upstreams : [];
        this.data.keys = Array.isArray(parsed.keys) ? parsed.keys : [];
        this.data.modelStatus = parsed.modelStatus && typeof parsed.modelStatus === 'object' ? parsed.modelStatus : {};
      } catch (err) {
        console.error(`[store] 数据文件损坏，已改名备份后重建: ${err.message}`);
        try {
          renameSync(config.dataFile, `${config.dataFile}.broken-${Date.now()}`);
        } catch {}
        this.data = emptyData();
      }
    }
    if (config.sessionSecret) this.data.secret = config.sessionSecret;
    if (!Number.isFinite(this.data.sessionEpoch)) this.data.sessionEpoch = 1;
    // 首次部署时自动生成的密码是明文打进部署日志的。一旦管理员补上了
    // ADMIN_PASSWORD，就把那个自动生成的作废 —— 否则躺在日志里的密码永久有效。
    if (config.adminPassword && this.data.adminPassword?.generated) {
      this.data.adminPassword = null;
      this.data.sessionEpoch += 1;
      console.warn('[store] 检测到 ADMIN_PASSWORD，已作废首次启动时自动生成的那个临时密码（它明文出现在部署日志里）');
    }
    this._invalidateKeyIndex();
    this._loaded = true;
    this.seedFromEnv();
    this.saveNow();
    return this.data;
  }

  /** 环境变量里的 key / token 只在缺失时导入一次，之后以控制台里的数据为准 */
  seedFromEnv() {
    let changed = false;
    if (config.seedApiKey && !this.data.keys.some((k) => k.key === config.seedApiKey)) {
      this.data.keys.push(this._newKey({ name: '环境变量 FREEBUFF_API_KEY', key: config.seedApiKey }));
      changed = true;
    }
    if (!this.data.keys.length) {
      this.data.keys.push(this._newKey({ name: '默认 key（自动生成）' }));
      changed = true;
    }
    if (config.seedTokens) {
      for (const raw of config.seedTokens.split(/[\n,]/)) {
        const token = raw.trim();
        if (token.length <= 8) continue;
        if (this.data.accounts.some((a) => a.token === token && providerOf(a) === 'freebuff')) continue;
        this.data.accounts.push({
          id: randomId(6),
          email: '',
          name: '环境变量导入',
          token,
          provider: 'freebuff',
          pool: 'any',
          enabled: true,
          source: 'env',
          createdAt: nowIso(),
          lastUsedAt: null,
          status: null,
        });
        changed = true;
      }
    }
    // opencode Zen 的 key 也支持用环境变量种一批（和 freebuff 的 token 各走各的）
    if (config.seedOpencodeKeys) {
      for (const raw of config.seedOpencodeKeys.split(/[\n,]/)) {
        const token = raw.trim();
        if (token.length <= 8) continue;
        if (this.data.accounts.some((a) => a.token === token && providerOf(a) === 'opencode')) continue;
        this.data.accounts.push({
          id: randomId(6),
          email: '',
          name: '环境变量导入（opencode）',
          token,
          provider: 'opencode',
          pool: 'free',
          enabled: true,
          source: 'env',
          createdAt: nowIso(),
          lastUsedAt: null,
          status: null,
        });
        changed = true;
      }
    }
    if (changed) {
      this._invalidateKeyIndex();
      this.save();
    }
  }

  save() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.saveNow();
    }, 200);
  }

  saveNow() {
    if (!this._loaded) return;
    const tmp = `${config.dataFile}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      renameSync(tmp, config.dataFile);
      try {
        chmodSync(config.dataFile, 0o600);
      } catch {}
    } catch (err) {
      console.error(`[store] 写入失败 (${config.dataFile}): ${err.message}`);
    }
  }

  // --- 管理密码 ---------------------------------------------------------

  hasPassword() {
    return Boolean(config.adminPassword || this.data.adminPassword);
  }

  /** 当前有几种可用的登录凭证，控制台里显示出来，免得用户不知道日志里那个还有效 */
  credentialSources() {
    return {
      env: Boolean(config.adminPassword),
      console: Boolean(this.data.adminPassword),
      consoleGenerated: Boolean(this.data.adminPassword?.generated),
    };
  }

  /**
   * 校验管理密码。用异步 scrypt（走 libuv 线程池）：scryptSync 每次要几十毫秒，
   * 并发爆破能靠它把单线程事件循环卡死，连 /healthz 都超时。
   */
  async verifyPassword(password) {
    const input = String(password ?? '');
    let ok = false;
    // 环境变量里的密码始终有效（避免在控制台改了密码又忘记后彻底进不去）
    if (config.adminPassword) {
      if (constantTimeEqual(input, config.adminPassword)) ok = true;
    }
    if (this.data.adminPassword) {
      const { salt, hash } = this.data.adminPassword;
      try {
        const attempt = await scryptAsync(input, salt, 32);
        const expect = Buffer.from(hash, 'hex');
        // 两边都算完再比，避免"哪一种密码匹配上了"从耗时上露出来
        if (attempt.length === expect.length && timingSafeEqual(attempt, expect)) ok = true;
      } catch {
        /* 数据文件里的 salt/hash 坏了就当不匹配 */
      }
    }
    return ok;
  }

  setPassword(password, { generated = false } = {}) {
    this.data.adminPassword = { ...hashPassword(password), generated };
    // 换密码就作废所有已签发的会话：世代号 +1（不依赖 secret 轮换，
    // 配了固定 SESSION_SECRET 时 secret 是不变的）
    this.data.sessionEpoch = (Number(this.data.sessionEpoch) || 1) + 1;
    if (!config.sessionSecret) this.data.secret = randomBytes(32).toString('hex');
    this.saveNow();
  }

  /** 一键把所有设备踢下线 */
  revokeSessions() {
    this.data.sessionEpoch = (Number(this.data.sessionEpoch) || 1) + 1;
    this.saveNow();
    return this.data.sessionEpoch;
  }

  get sessionEpoch() {
    return Number(this.data.sessionEpoch) || 1;
  }

  get secret() {
    return this.data.secret;
  }

  // --- 账号池 -----------------------------------------------------------

  get accounts() {
    return this.data.accounts;
  }

  addAccount({ token, email = '', name = '', pool = 'any', source = 'manual', user = null, provider = 'freebuff' }) {
    const clean = String(token || '').trim();
    const prov = normalizeProvider(provider);
    if (clean.length <= 8) throw Object.assign(new Error('token 太短，不像有效的 authToken'), { statusCode: 400 });
    // 同一个 token 在不同 provider 下是两条独立记录（凭据格式不同，撞不上；
    // 但真撞上了也不能把 freebuff 的号悄悄改成 opencode 的）
    const existing = this.data.accounts.find((a) => a.token === clean && providerOf(a) === prov);
    if (existing) {
      // 同一账号重新登录（token 轮换）时更新信息而不是插一条重复的
      existing.email = email || existing.email;
      existing.name = name || existing.name;
      existing.pool = pool || existing.pool;
      existing.enabled = true;
      existing.updatedAt = nowIso();
      this.save();
      return { account: existing, duplicated: true };
    }
    const sameEmail = email ? this.data.accounts.find((a) => a.email && a.email === email && providerOf(a) === prov) : null;
    if (sameEmail) {
      sameEmail.token = clean;
      sameEmail.name = name || sameEmail.name;
      sameEmail.pool = pool || sameEmail.pool;
      sameEmail.enabled = true;
      sameEmail.source = source;
      sameEmail.updatedAt = nowIso();
      sameEmail.status = null;
      this.save();
      return { account: sameEmail, refreshed: true };
    }
    const account = {
      id: randomId(6),
      email,
      name,
      token: clean,
      provider: prov,
      pool,
      enabled: true,
      source,
      upstreamId: user?.id ? String(user.id) : '',
      credits: user?.credits ?? null,
      createdAt: nowIso(),
      lastUsedAt: null,
      status: null,
    };
    this.data.accounts.push(account);
    this.save();
    return { account };
  }

  updateAccount(id, patch) {
    const acct = this.data.accounts.find((a) => a.id === id);
    if (!acct) return null;
    for (const field of ['email', 'name', 'pool', 'enabled', 'note']) {
      if (field in patch) acct[field] = patch[field];
    }
    if ('token' in patch && String(patch.token || '').trim().length > 8) {
      acct.token = String(patch.token).trim();
      acct.status = null;
    }
    acct.updatedAt = nowIso();
    // 停用了当前正在用的号就把指针放开，让下一次请求自己挑
    if (acct.enabled === false && this.data.settings.activeAccountId === id) {
      this.data.settings.activeAccountId = null;
    }
    this.save();
    return acct;
  }

  removeAccount(id) {
    const idx = this.data.accounts.findIndex((a) => a.id === id);
    if (idx < 0) return false;
    this.data.accounts.splice(idx, 1);
    if (this.data.settings.activeAccountId === id) this.data.settings.activeAccountId = null;
    this.save();
    return true;
  }

  /** 记录"现在正在用哪个号"，请求成功后由引擎层回写 */
  setActiveAccount(id) {
    if (this.data.settings.activeAccountId === id) return;
    this.data.settings.activeAccountId = id;
    this.save();
  }

  get activeAccount() {
    const id = this.data.settings.activeAccountId;
    return id ? this.data.accounts.find((a) => a.id === id) || null : null;
  }

  setAccountStatus(id, status) {
    const acct = this.data.accounts.find((a) => a.id === id);
    if (!acct) return null;
    acct.status = { ...status, checkedAt: nowIso() };
    this.save();
    return acct;
  }

  // --- API keys ---------------------------------------------------------

  get keys() {
    return this.data.keys;
  }

  _newKey({ name = '', key = null, allowPaid = null, models = [] } = {}) {
    return {
      id: randomId(6),
      name: name || '未命名',
      key: key || generateApiKey(),
      allowPaid: allowPaid === null ? Boolean(this.data.settings.allowPaidDefault) : Boolean(allowPaid),
      models: Array.isArray(models) ? models : [],
      enabled: true,
      createdAt: nowIso(),
      lastUsedAt: null,
      requests: 0,
    };
  }

  addKey(opts) {
    const key = this._newKey(opts);
    this.data.keys.push(key);
    this._invalidateKeyIndex();
    this.save();
    return key;
  }

  updateKey(id, patch) {
    const k = this.data.keys.find((x) => x.id === id);
    if (!k) return null;
    if ('name' in patch) k.name = String(patch.name || '未命名');
    if ('allowPaid' in patch) k.allowPaid = Boolean(patch.allowPaid);
    if ('enabled' in patch) k.enabled = Boolean(patch.enabled);
    if ('models' in patch) k.models = Array.isArray(patch.models) ? patch.models : [];
    k.updatedAt = nowIso();
    this.save();
    return k;
  }

  removeKey(id) {
    const idx = this.data.keys.findIndex((k) => k.id === id);
    if (idx < 0) return false;
    this.data.keys.splice(idx, 1);
    this._invalidateKeyIndex();
    this.save();
    return true;
  }

  findKey(presented) {
    if (!presented || typeof presented !== 'string') return null;
    // 用 Map 查而不是遍历逐字符比较：查表不会把 key 的公共前缀从耗时上露出来
    if (!this._keyIndex) this._keyIndex = new Map(this.data.keys.map((k) => [k.key, k]));
    return this._keyIndex.get(presented) || null;
  }

  /** keys 数组增删/整体替换后调用（改名、启停用是原地改同一个对象，索引仍然有效） */
  _invalidateKeyIndex() {
    this._keyIndex = null;
  }

  touchKey(id) {
    const k = this.data.keys.find((x) => x.id === id);
    if (!k) return;
    k.requests = (k.requests || 0) + 1;
    k.lastUsedAt = nowIso();
    this.save();
  }

  // --- 模型实测状态 -----------------------------------------------------

  get modelStatus() {
    if (!this.data.modelStatus || typeof this.data.modelStatus !== 'object') this.data.modelStatus = {};
    return this.data.modelStatus;
  }

  setModelStatus(id, patch) {
    if (!id) return null;
    const cur = this.modelStatus[id] || { fails: 0 };
    const next = { ...cur, ...patch, at: nowIso() };
    this.modelStatus[id] = next;
    this.save();
    return next;
  }

  clearModelStatus(id) {
    if (id) delete this.modelStatus[id];
    else this.data.modelStatus = {};
    this.save();
  }

  // --- 设置 -------------------------------------------------------------

  get settings() {
    return this.data.settings;
  }

  updateSettings(patch) {
    const s = this.data.settings;
    if ('allowPaidDefault' in patch) s.allowPaidDefault = Boolean(patch.allowPaidDefault);
    if ('browserLoginEnabled' in patch) s.browserLoginEnabled = Boolean(patch.browserLoginEnabled);
    if ('autoSwitch' in patch) s.autoSwitch = Boolean(patch.autoSwitch);
    if ('hideUnavailableModels' in patch) s.hideUnavailableModels = Boolean(patch.hideUnavailableModels);
    if ('defaultModel' in patch) s.defaultModel = String(patch.defaultModel || '').trim();
    if ('chatLogEnabled' in patch) s.chatLogEnabled = Boolean(patch.chatLogEnabled);
    if ('chatLogMaxMB' in patch) {
      const n = Number(patch.chatLogMaxMB);
      if (Number.isFinite(n) && n > 0 && n <= 100000) s.chatLogMaxMB = Math.floor(n);
    }
    if ('chatLogMaxRecordKB' in patch) {
      const n = Number(patch.chatLogMaxRecordKB);
      if (Number.isFinite(n) && n >= 4 && n <= 8192) s.chatLogMaxRecordKB = Math.floor(n);
    }
    if ('activeAccountId' in patch) {
      const id = patch.activeAccountId ? String(patch.activeAccountId) : null;
      s.activeAccountId = id && this.data.accounts.some((a) => a.id === id) ? id : null;
    }
    if (Array.isArray(patch.disabledModels)) s.disabledModels = patch.disabledModels.map(String);
    if (patch.rotationRules && typeof patch.rotationRules === 'object') {
      // 值的形状由 upstreams.js 校验过；这里只保证是个对象，别把整棵设置写坏
      s.rotationRules = {};
      for (const [id, rule] of Object.entries(patch.rotationRules)) {
        if (!rule || typeof rule !== 'object') continue;
        s.rotationRules[String(id)] = {
          ...(rule.mode ? { mode: String(rule.mode) } : {}),
          ...(rule.activeAccountId ? { activeAccountId: String(rule.activeAccountId) } : {}),
        };
      }
    }
    if (patch.modelTierOverrides && typeof patch.modelTierOverrides === 'object') {
      s.modelTierOverrides = {};
      for (const [id, tier] of Object.entries(patch.modelTierOverrides)) {
        if (tier === 'free' || tier === 'paid') s.modelTierOverrides[id] = tier;
      }
    }
    this.save();
    return s;
  }

  exportData() {
    return {
      exportedAt: nowIso(),
      settings: this.data.settings,
      upstreams: this.data.upstreams || [],
      accounts: this.data.accounts.map(({ status, ...rest }) => rest),
      keys: this.data.keys,
    };
  }

  importData(payload, { replace = false } = {}) {
    if (!payload || typeof payload !== 'object') throw Object.assign(new Error('导入内容格式不对'), { statusCode: 400 });
    const result = { accounts: 0, keys: 0, upstreams: 0 };
    if (replace) {
      this.data.accounts = [];
      this.data.keys = [];
      this.data.upstreams = [];
    }
    // 上游要先导：账号的 provider 指向它，顺序反了会让号变成孤儿
    if (!Array.isArray(this.data.upstreams)) this.data.upstreams = [];
    for (const u of Array.isArray(payload.upstreams) ? payload.upstreams : []) {
      if (!u?.id || !u?.baseUrl || this.data.upstreams.some((x) => x.id === u.id)) continue;
      this.data.upstreams.push({
        id: String(u.id),
        name: String(u.name || u.id),
        format: ['chat', 'responses', 'anthropic', 'gemini'].includes(u.format) ? u.format : 'chat',
        baseUrl: String(u.baseUrl),
        note: String(u.note || '').slice(0, 200),
        enabled: u.enabled !== false,
        defaultTier: u.defaultTier === 'free' ? 'free' : 'paid',
        models: Array.isArray(u.models) ? u.models.map(String) : [],
        modelsFetchedAt: u.modelsFetchedAt || null,
        createdAt: u.createdAt || nowIso(),
      });
      result.upstreams++;
    }
    for (const a of Array.isArray(payload.accounts) ? payload.accounts : []) {
      if (!a?.token) continue;
      const prov = normalizeProvider(a.provider);
      if (this.data.accounts.some((x) => x.token === a.token && providerOf(x) === prov)) continue;
      this.data.accounts.push({
        id: randomId(6),
        email: a.email || '',
        name: a.name || '',
        token: String(a.token),
        provider: prov,
        pool: ['any', 'free', 'paid'].includes(a.pool) ? a.pool : 'any',
        enabled: a.enabled !== false,
        source: 'import',
        createdAt: a.createdAt || nowIso(),
        lastUsedAt: null,
        status: null,
      });
      result.accounts++;
    }
    for (const k of Array.isArray(payload.keys) ? payload.keys : []) {
      if (!k?.key) continue;
      if (this.data.keys.some((x) => x.key === k.key)) continue;
      this.data.keys.push({ ...this._newKey({ name: k.name, key: k.key, allowPaid: k.allowPaid, models: k.models }) });
      result.keys++;
    }
    if (payload.settings) this.updateSettings(payload.settings);
    this._invalidateKeyIndex();
    this.saveNow();
    return result;
  }
}

export const store = new Store();
