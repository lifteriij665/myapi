// 存储盘点 + 分级清理。
//
// 三档，对应"我要腾空间"的三种心情：
//   routine  日常清理：只删聊天记录、浏览器 profile、临时/损坏文件 —— 用量统计留着
//   deep     清除不必要数据：再加上用量统计和账号状态快照 —— 账号、key、密码、设置留着
//   full     全部清理：连账号和 key 都删，回到首次部署的状态
//            （管理密码和签名密钥必须留下，否则你就把自己关在门外了）
import { existsSync, mkdirSync, readdirSync, statSync, rmSync, statfsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { store } from './store.js';
import { usage } from './usage.js';
import { clearChatLog, chatLogSize } from './chatlog.js';
import { closeAllBrowsers } from './browser.js';

function dirSize(path) {
  if (!existsSync(path)) return { bytes: 0, files: 0 };
  let bytes = 0;
  let files = 0;
  const walk = (p) => {
    let st;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      let entries = [];
      try {
        entries = readdirSync(p);
      } catch {
        return;
      }
      for (const e of entries) walk(resolve(p, e));
    } else {
      bytes += st.size;
      files += 1;
    }
  };
  walk(path);
  return { bytes, files };
}

function fileSize(path) {
  try {
    const st = statSync(path);
    return { bytes: st.size, files: 1 };
  } catch {
    return { bytes: 0, files: 0 };
  }
}

function tempFiles() {
  const out = [];
  try {
    for (const name of readdirSync(config.dataDir)) {
      if (/\.tmp-\d+$/.test(name) || /\.broken-\d+$/.test(name)) out.push(resolve(config.dataDir, name));
    }
  } catch {}
  return out;
}

const PATHS = () => ({
  data: resolve(config.dataDir, 'myapi-data.json'),
  usage: resolve(config.dataDir, 'usage.json'),
  chatlog: resolve(config.dataDir, 'chatlog'),
  browser: config.browserProfileDir,
});

/** 盘点：每一类占了多少、以及磁盘本身还剩多少 */
export function inspectStorage() {
  const p = PATHS();
  const temps = tempFiles();
  let tempBytes = 0;
  for (const t of temps) tempBytes += fileSize(t).bytes;

  const items = [
    { key: 'core', label: '账号 / API key / 设置 / 密码', path: p.data, ...fileSize(p.data), keepIn: ['routine', 'deep'] },
    { key: 'usage', label: '用量统计（请求数、token 数）', path: p.usage, ...fileSize(p.usage), keepIn: ['routine'] },
    { key: 'chatlog', label: '聊天记录', path: p.chatlog, ...dirSize(p.chatlog), keepIn: [] },
    { key: 'browser', label: '内置浏览器 profile（cookie / 缓存）', path: p.browser, ...dirSize(p.browser), keepIn: [] },
    { key: 'temp', label: '临时文件 / 损坏备份', path: config.dataDir, bytes: tempBytes, files: temps.length, keepIn: [] },
  ];

  let disk = null;
  try {
    const st = statfsSync(config.dataDir);
    disk = {
      totalBytes: st.blocks * st.bsize,
      freeBytes: st.bavail * st.bsize,
    };
  } catch {
    /* 有些平台不支持 statfs，不影响功能 */
  }

  return {
    dir: config.dataDir,
    persistent: config.persistentData,
    totalBytes: items.reduce((n, i) => n + i.bytes, 0),
    items,
    disk,
    chatlog: chatLogSize(true),
  };
}

const LEVELS = {
  routine: { label: '日常清理', targets: ['chatlog', 'browser', 'temp'] },
  deep: { label: '清除不必要数据', targets: ['chatlog', 'browser', 'temp', 'usage', 'status'] },
  full: { label: '全部清理', targets: ['chatlog', 'browser', 'temp', 'usage', 'status', 'accounts', 'keys', 'settings'] },
};

export function cleanupPreview(level) {
  const spec = LEVELS[level];
  if (!spec) return null;
  const snapshot = inspectStorage();
  const byKey = Object.fromEntries(snapshot.items.map((i) => [i.key, i]));
  const rows = [];
  let bytes = 0;
  for (const t of spec.targets) {
    if (byKey[t]) {
      rows.push({ key: t, label: byKey[t].label, bytes: byKey[t].bytes, files: byKey[t].files });
      bytes += byKey[t].bytes;
    } else if (t === 'status') {
      rows.push({ key: 'status', label: '账号状态快照（探活结果、额度快照）', bytes: 0, files: store.accounts.length });
    } else if (t === 'accounts') {
      rows.push({ key: 'accounts', label: `账号池（${store.accounts.length} 个号，含 token）`, bytes: 0, files: store.accounts.length });
    } else if (t === 'keys') {
      rows.push({ key: 'keys', label: `API key（${store.keys.length} 个）`, bytes: 0, files: store.keys.length });
    } else if (t === 'settings') {
      rows.push({ key: 'settings', label: '设置（模型分类、下架列表、切换策略）', bytes: 0, files: 1 });
    }
  }
  return { level, label: spec.label, freesBytes: bytes, rows, keepsPassword: true };
}

/** 真正执行清理。返回做了什么、腾出多少空间 */
export async function runCleanup(level) {
  const spec = LEVELS[level];
  if (!spec) throw Object.assign(new Error(`未知的清理级别 ${level}`), { statusCode: 400 });
  const before = inspectStorage();
  const done = [];
  const targets = new Set(spec.targets);

  if (targets.has('chatlog')) {
    const r = clearChatLog();
    done.push(`聊天记录 ${r.removed} 个文件`);
  }

  if (targets.has('browser')) {
    // profile 目录可能正被 Chromium 占着，先把浏览器都关掉
    await closeAllBrowsers().catch(() => {});
    try {
      rmSync(config.browserProfileDir, { recursive: true, force: true });
      mkdirSync(config.browserProfileDir, { recursive: true, mode: 0o700 });
      done.push('内置浏览器 profile');
    } catch (err) {
      done.push(`内置浏览器 profile 清理失败：${err.message}`);
    }
  }

  if (targets.has('temp')) {
    let n = 0;
    for (const f of tempFiles()) {
      try {
        rmSync(f, { force: true });
        n += 1;
      } catch {}
    }
    if (n) done.push(`临时/损坏文件 ${n} 个`);
  }

  if (targets.has('usage')) {
    usage.reset();
    for (const k of store.keys) k.requests = 0;
    done.push('用量统计');
  }

  if (targets.has('status')) {
    for (const a of store.accounts) a.status = null;
    done.push('账号状态快照');
  }

  if (targets.has('accounts')) {
    const n = store.accounts.length;
    store.data.accounts = [];
    store.settings.activeAccountId = null;
    done.push(`账号池（${n} 个号）`);
  }

  if (targets.has('keys')) {
    const n = store.keys.length;
    store.data.keys = [];
    store._invalidateKeyIndex();
    // 一个 key 都没有的话对外 API 直接不可用，补一个新的
    store.addKey({ name: '清理后自动生成' });
    done.push(`API key（${n} 个，已生成一个新的）`);
  }

  if (targets.has('settings')) {
    store.settings.disabledModels = [];
    store.settings.modelTierOverrides = {};
    store.settings.autoSwitch = true;
    store.settings.chatLogEnabled = false;
    done.push('设置');
  }

  store.saveNow();
  const after = inspectStorage();
  return {
    level,
    label: spec.label,
    done,
    freedBytes: Math.max(0, before.totalBytes - after.totalBytes),
    before: before.totalBytes,
    after: after.totalBytes,
    // 密码和签名密钥永远不动 —— 清完还得能登进来
    keptPassword: true,
  };
}

