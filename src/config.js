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
  host: process.env.HOST || '0.0.0.0',

  adminPassword: (process.env.ADMIN_PASSWORD || '').trim(),
  sessionSecret: (process.env.SESSION_SECRET || '').trim(),
  sessionTtlMs: parseInt(process.env.SESSION_TTL_HOURS || '168', 10) * 3600 * 1000,

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
