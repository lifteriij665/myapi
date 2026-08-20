// 聊天记录留存（默认关闭）。
//
// 打开之后，每个成功的 /v1 请求会往 <数据目录>/chatlog/chat-YYYY-MM-DD.jsonl 追加一行
// JSON：请求消息 + 模型回复 + 用量。自用场景下这就是一份现成的训练/复盘素材。
//
// 几条硬性约束：
//   * 默认关，打开要显式操作 —— 这东西会把你和模型说过的每句话都落到磁盘上
//   * 有总容量上限，写满就停止记录（不自动删旧的：那可能是你要的数据）
//   * 单条有长度上限，超了截断并打标记，别让一次长上下文把磁盘写爆
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { store } from './store.js';
import { randomId, nowIso } from './util.js';

const DIR = resolve(config.dataDir, 'chatlog');

let sizeCache = { bytes: 0, files: 0, at: 0 };
let full = false;
let lastError = null;

function ensureDir() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true, mode: 0o700 });
}

function limitBytes() {
  const mb = Number(store.settings?.chatLogMaxMB);
  return Math.max(1, Number.isFinite(mb) && mb > 0 ? mb : 200) * 1024 * 1024;
}

function recordLimitBytes() {
  const kb = Number(store.settings?.chatLogMaxRecordKB);
  return Math.max(4, Number.isFinite(kb) && kb > 0 ? kb : 256) * 1024;
}

/** 目录体积（缓存 10 秒，避免每条请求都 stat 一遍） */
export function chatLogSize(force = false) {
  if (!force && Date.now() - sizeCache.at < 10_000) return sizeCache;
  let bytes = 0;
  let files = 0;
  let oldest = null;
  let newest = null;
  try {
    ensureDir();
    for (const name of readdirSync(DIR)) {
      if (!name.endsWith('.jsonl')) continue;
      const st = statSync(resolve(DIR, name));
      bytes += st.size;
      files += 1;
      if (!oldest || name < oldest) oldest = name;
      if (!newest || name > newest) newest = name;
    }
  } catch (err) {
    lastError = err.message;
  }
  sizeCache = { bytes, files, at: Date.now(), oldest, newest };
  return sizeCache;
}

export function chatLogStatus() {
  const size = chatLogSize();
  return {
    enabled: Boolean(store.settings?.chatLogEnabled),
    dir: DIR,
    files: size.files,
    bytes: size.bytes,
    limitBytes: limitBytes(),
    full,
    oldest: size.oldest || null,
    newest: size.newest || null,
    lastError,
  };
}

function clip(value, budget) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  if (text == null) return { value: null, truncated: false };
  if (text.length <= budget) return { value, truncated: false };
  return { value: text.slice(0, budget), truncated: true };
}

/**
 * 写一条聊天记录。默认关闭时直接返回。
 * 失败只记 lastError，绝不影响正在进行的请求。
 */
export function appendChat(entry) {
  if (!store.settings?.chatLogEnabled) return false;
  const size = chatLogSize();
  if (size.bytes >= limitBytes()) {
    if (!full) console.warn(`[chatlog] 已达容量上限（${Math.round(size.bytes / 1048576)}MB），停止记录`);
    full = true;
    return false;
  }
  full = false;

  const budget = recordLimitBytes();
  const req = clip(entry.request ?? null, budget);
  const resp = clip(entry.response ?? null, Math.floor(budget / 2));
  const row = {
    id: randomId(8),
    at: nowIso(),
    model: entry.model || '',
    tier: entry.tier || '',
    protocol: entry.protocol || '',
    stream: Boolean(entry.stream),
    status: entry.status ?? 0,
    ok: Boolean(entry.ok),
    latencyMs: entry.latencyMs ?? null,
    keyId: entry.keyId || '',
    keyName: entry.keyName || '',
    accountId: entry.accountId || '',
    usage: entry.usage || null,
    request: req.value,
    response: resp.value,
    truncated: req.truncated || resp.truncated,
    error: entry.error || null,
  };
  try {
    ensureDir();
    const name = `chat-${new Date().toISOString().slice(0, 10)}.jsonl`;
    const file = resolve(DIR, name);
    // 新开一个文件时缓存里的文件数也要跟上，否则控制台会显示"有字节但 0 个文件"
    const isNewFile = !existsSync(file);
    const line = JSON.stringify(row) + '\n';
    appendFileSync(file, line, { mode: 0o600 });
    sizeCache.bytes += Buffer.byteLength(line);
    if (isNewFile) {
      sizeCache.files += 1;
      sizeCache.newest = name;
      if (!sizeCache.oldest) sizeCache.oldest = name;
    }
    return true;
  } catch (err) {
    lastError = err.message;
    console.error(`[chatlog] 写入失败：${err.message}`);
    return false;
  }
}

/** 列出所有记录文件（新的在前） */
export function chatLogFiles() {
  try {
    ensureDir();
    return readdirSync(DIR)
      .filter((n) => n.endsWith('.jsonl'))
      .sort()
      .reverse()
      .map((name) => {
        const st = statSync(resolve(DIR, name));
        return { name, bytes: st.size, mtime: st.mtime.toISOString() };
      });
  } catch {
    return [];
  }
}

/** 读一个文件的原始内容（导出用），带体积上限保护 */
export function readChatLogFile(name) {
  if (!/^chat-\d{4}-\d{2}-\d{2}\.jsonl$/.test(String(name || ''))) return null;
  const file = resolve(DIR, name);
  if (!existsSync(file)) return null;
  const st = statSync(file);
  if (st.size > 200 * 1024 * 1024) return null;
  return readFileSync(file, 'utf8');
}

/** 预览用：优先显示最后一条用户消息，而不是整段 JSON */
function previewOfRequest(request) {
  let obj = request;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      return obj;
    }
  }
  const msgs = obj?.messages;
  if (Array.isArray(msgs)) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m?.role !== 'user') continue;
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        const t = m.content.find((c) => c?.type === 'text' && typeof c.text === 'string');
        if (t) return t.text;
      }
    }
  }
  return JSON.stringify(obj ?? '');
}

/** 最近若干条（给控制台预览用，不含完整正文） */
export function recentChats(limit = 30) {
  const files = chatLogFiles();
  const out = [];
  for (const f of files) {
    let lines;
    try {
      lines = readFileSync(resolve(DIR, f.name), 'utf8').trim().split('\n');
    } catch {
      continue;
    }
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const row = JSON.parse(lines[i]);
        const reqText = previewOfRequest(row.request);
        const respText = typeof row.response === 'string' ? row.response : JSON.stringify(row.response ?? '');
        out.push({
          id: row.id,
          at: row.at,
          model: row.model,
          ok: row.ok,
          status: row.status,
          latencyMs: row.latencyMs,
          usage: row.usage,
          keyName: row.keyName,
          preview: reqText.slice(0, 160),
          replyPreview: respText.slice(0, 160),
          bytes: Buffer.byteLength(lines[i]),
        });
      } catch {
        /* 坏行跳过 */
      }
    }
    if (out.length >= limit) break;
  }
  return out;
}

/** 清空聊天记录 */
export function clearChatLog() {
  let removed = 0;
  let bytes = 0;
  try {
    ensureDir();
    for (const name of readdirSync(DIR)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = resolve(DIR, name);
      bytes += statSync(file).size;
      unlinkSync(file);
      removed += 1;
    }
  } catch (err) {
    lastError = err.message;
  }
  sizeCache = { bytes: 0, files: 0, at: Date.now() };
  full = false;
  return { removed, bytes };
}
