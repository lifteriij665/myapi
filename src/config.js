// 运行配置：只在这里读 process.env，其它模块从这里拿值。
import { existsSync, mkdirSync, accessSync, constants } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function bool(value, dflt = false) {
  if (value === undefined || value === null || value === '') return dflt;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function writable(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function positiveInt(value, dflt, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return dflt;
  return Math.floor(n);
}

// Railway 挂了 Volume 时会注入 RAILWAY_VOLUME_MOUNT_PATH，用它当数据目录最稳。
const railwayVolume = process.env.RAILWAY_VOLUME_MOUNT_PATH || '';
const onRailway = Boolean(
  process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID
);

function resolveDataDir() {
  const candidates = [];
  if (process.env.DATA_DIR) candidates.push(process.env.DATA_DIR);
  if (railwayVolume) candidates.push(railwayVolume);
  candidates.push('/data', resolve(ROOT, 'data'));
  for (const dir of candidates) {
    if (writable(dir)) return { dir, fallback: dir === resolve(ROOT, 'data') };
  }
  return { dir: resolve(ROOT, 'data'), fallback: true };
}

const dataDir = resolveDataDir();

export const config = {
  port: parseInt(process.env.PORT || '8787', 10),
  // 默认绑 IPv6 通配地址：Linux 上是双栈，IPv4 也能进来（Railway 的内网是 IPv6，
  // 只绑 0.0.0.0 有可能收不到内网流量）。绑不上会自动退回 0.0.0.0。
  host: process.env.HOST || '::',

  adminPassword: (process.env.ADMIN_PASSWORD || '').trim(),
  sessionSecret: (process.env.SESSION_SECRET || '').trim(),
  // 会话有效期：配成非数字时回落到默认，不能让它变成 NaN（NaN 会签出永不过期的 cookie）
  sessionTtlMs: positiveInt(process.env.SESSION_TTL_HOURS, 168, { min: 1, max: 24 * 365 }) * 3600 * 1000,
  // 前面有几层可信代理（Railway = 1）。取 X-Forwarded-For 最右边这几跳，
  // 左边是客户端自己能写的，取错方向登录限流就能被伪造 XFF 绕过。
  trustProxyHops: Math.max(1, parseInt(process.env.TRUST_PROXY_HOPS || '1', 10) || 1),

  dataDir: dataDir.dir,
  dataFile: resolve(dataDir.dir, 'myapi-data.json'),
  browserProfileDir: resolve(dataDir.dir, 'browser-profiles'),
  // Railway 上：挂了 Volume 才算持久（没挂的话每次部署都会清空）；本地跑就是自己的磁盘
  persistentData: Boolean(railwayVolume) || !onRailway,
  onRailway,
  railwayVolume,
  dataDirFallback: dataDir.fallback,

  seedApiKey: (process.env.FREEBUFF_API_KEY || process.env.API_KEY || '').trim(),
  seedTokens: (process.env.FREEBUFF_TOKEN || '').trim(),
  allowPaidDefault: bool(process.env.ALLOW_PAID_DEFAULT, false),
  workerDebug: bool(process.env.FREEBUFF_DEBUG, false),

  enableBrowserLogin: bool(process.env.ENABLE_BROWSER_LOGIN, true),
  browserHeadless: (process.env.BROWSER_HEADLESS || 'auto').trim().toLowerCase(),
  browserProxy: (process.env.BROWSER_PROXY || '').trim(),
  browserIdleTimeoutMs: parseInt(process.env.BROWSER_IDLE_TIMEOUT_MS || '600000', 10),

  // 单个 API 请求的体积上限：JSON.parse 会把内存放大好几倍，太大很容易把小容器打满
  maxBodyBytes: Math.max(1, parseFloat(process.env.MAX_BODY_MB || '8')) * 1024 * 1024,
  // 同时最多开几个内置浏览器：一个 Chromium 就要 300~500MB，开多了容器直接 OOM，
  // 连带把 /v1 也一起弄挂
  maxBrowserSessions: Math.max(1, parseInt(process.env.MAX_BROWSER_SESSIONS || '2', 10) || 2),
  // 同时最多处理几个 /v1 请求：每个请求可能带几 MB 的 body 和一条上游流，
  // 不设闸门的话一个 key 就能把小容器打到 OOM
  maxInflightApi: positiveInt(process.env.MAX_INFLIGHT_API, 32, { min: 1, max: 1024 }),
  upstreamBase: (process.env.CODEBUFF_API || 'https://www.codebuff.com').replace(/\/+$/, ''),
  loginPollTimeoutMs: parseInt(process.env.LOGIN_POLL_TIMEOUT_MS || '600000', 10),
  loginPollIntervalMs: parseInt(process.env.LOGIN_POLL_INTERVAL_MS || '4000', 10),

  publicDir: resolve(ROOT, 'public'),
  version: '1.0.0',
};

/** 内置浏览器实际是否 headless */
export function browserHeadless() {
  if (config.browserHeadless === 'true') return true;
  if (config.browserHeadless === 'false') return false;
  return !process.env.DISPLAY; // auto：有 Xvfb/X11 就 headful
}

export function ensureDirs() {
  if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true });
}
