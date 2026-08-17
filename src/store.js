// 数据落盘：一个 JSON 文件放账号池 / API key / 设置。
// 原子写（tmp + rename）+ 0600 权限；写入做 200ms 合并，避免频繁 IO。
import { readFileSync, writeFileSync, renameSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { dirname } from 'node:path';
import { config } from './config.js';
import { randomId, generateApiKey, nowIso } from './util.js';

const CURRENT_VERSION = 1;

function emptyData() {
  return {
    version: CURRENT_VERSION,
    createdAt: nowIso(),
    secret: randomBytes(32).toString('hex'),
    adminPassword: null, // { salt, hash } —— 在控制台改过密码才有；否则用环境变量 ADMIN_PASSWORD
    settings: {
      allowPaidDefault: config.allowPaidDefault,
      disabledModels: [], // 手动下架的模型 id
      modelTierOverrides: {}, // modelId -> 'free' | 'paid'
      browserLoginEnabled: config.enableBrowserLogin,
    },
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
        this.data.keys = Array.isArray(parsed.keys) ? parsed.keys : [];
      } catch (err) {
        console.error(`[store] 数据文件损坏，已改名备份后重建: ${err.message}`);
        try {
          renameSync(config.dataFile, `${config.dataFile}.broken-${Date.now()}`);
        } catch {}
        this.data = emptyData();
      }
    }
    if (config.sessionSecret) this.data.secret = config.sessionSecret;
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
        if (this.data.accounts.some((a) => a.token === token)) continue;
        this.data.accounts.push({
          id: randomId(6),
          email: '',
          name: '环境变量导入',
          token,
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
    if (changed) this.save();
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

  verifyPassword(password) {
    const input = String(password ?? '');
    let ok = false;
    // 环境变量里的密码始终有效（避免在控制台改了密码又忘记后彻底进不去）
    if (config.adminPassword) {
      const a = Buffer.from(input);
      const b = Buffer.from(config.adminPassword);
      if (a.length === b.length && timingSafeEqual(a, b)) ok = true;
    }
    if (!ok && this.data.adminPassword) {
      const { salt, hash } = this.data.adminPassword;
      const attempt = scryptSync(input, salt, 32);
      const expect = Buffer.from(hash, 'hex');
      if (attempt.length === expect.length && timingSafeEqual(attempt, expect)) ok = true;
    }
    return ok;
  }

  setPassword(password) {
    this.data.adminPassword = hashPassword(password);
    // 换密码顺手换签名密钥，让旧的登录 cookie 立即失效
    if (!config.sessionSecret) this.data.secret = randomBytes(32).toString('hex');
    this.saveNow();
  }

  get secret() {
    return this.data.secret;
  }

  // --- 账号池 -----------------------------------------------------------

  get accounts() {
    return this.data.accounts;
  }

  addAccount({ token, email = '', name = '', pool = 'any', source = 'manual', user = null }) {
    const clean = String(token || '').trim();
    if (clean.length <= 8) throw Object.assign(new Error('token 太短，不像有效的 authToken'), { statusCode: 400 });
    const existing = this.data.accounts.find((a) => a.token === clean);
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
    const sameEmail = email ? this.data.accounts.find((a) => a.email && a.email === email) : null;
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
    this.save();
    return acct;
  }

  removeAccount(id) {
    const idx = this.data.accounts.findIndex((a) => a.id === id);
    if (idx < 0) return false;
    this.data.accounts.splice(idx, 1);
    this.save();
    return true;
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
    this.save();
    return true;
  }

  findKey(presented) {
    if (!presented) return null;
    return this.data.keys.find((k) => k.key === presented) || null;
  }

  touchKey(id) {
    const k = this.data.keys.find((x) => x.id === id);
    if (!k) return;
    k.requests = (k.requests || 0) + 1;
    k.lastUsedAt = nowIso();
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
    if (Array.isArray(patch.disabledModels)) s.disabledModels = patch.disabledModels.map(String);
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
      accounts: this.data.accounts.map(({ status, ...rest }) => rest),
      keys: this.data.keys,
    };
  }

  importData(payload, { replace = false } = {}) {
    if (!payload || typeof payload !== 'object') throw Object.assign(new Error('导入内容格式不对'), { statusCode: 400 });
    const result = { accounts: 0, keys: 0 };
    if (replace) {
      this.data.accounts = [];
      this.data.keys = [];
    }
    for (const a of Array.isArray(payload.accounts) ? payload.accounts : []) {
      if (!a?.token) continue;
      if (this.data.accounts.some((x) => x.token === a.token)) continue;
      this.data.accounts.push({
        id: randomId(6),
        email: a.email || '',
        name: a.name || '',
        token: String(a.token),
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
    this.saveNow();
    return result;
  }
}

export const store = new Store();
