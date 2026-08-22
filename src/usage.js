// 用量统计：每个 /v1 请求记一条，内存里留最近若干条明细（算分位数和实时速率），
// 长期只保留分桶聚合并落盘。目标是"看得细"又不会把小容器的磁盘/内存吃掉。
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { config } from './config.js';

const FILE = resolve(config.dataDir, 'usage.json');
const EVENT_CAP = 3000; // 内存里保留的明细条数
const KEEP_DAYS = 120;
const KEEP_HOURS = 72;

const FIELDS = [
  'requests',
  'ok',
  'failed',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheCreateTokens',
  'reasoningTokens',
  'estimated',
  'streamed',
  'latencySumMs',
  'latencyMaxMs',
  'ttfbSumMs',
  'ttfbCount',
  'bytesIn',
  'bytesOut',
];

function emptyBucket() {
  const b = {};
  for (const f of FIELDS) b[f] = 0;
  return b;
}

function addTo(bucket, ev) {
  bucket.requests += 1;
  if (ev.ok) bucket.ok += 1;
  else bucket.failed += 1;
  bucket.inputTokens += ev.usage?.input || 0;
  bucket.outputTokens += ev.usage?.output || 0;
  bucket.cacheReadTokens += ev.usage?.cacheRead || 0;
  bucket.cacheCreateTokens += ev.usage?.cacheCreate || 0;
  bucket.reasoningTokens += ev.usage?.reasoning || 0;
  if (ev.usage?.estimated) bucket.estimated += 1;
  if (ev.stream) bucket.streamed += 1;
  bucket.latencySumMs += ev.latencyMs || 0;
  bucket.latencyMaxMs = Math.max(bucket.latencyMaxMs, ev.latencyMs || 0);
  if (ev.ttfbMs) {
    bucket.ttfbSumMs += ev.ttfbMs;
    bucket.ttfbCount += 1;
  }
  bucket.bytesIn += ev.bytesIn || 0;
  bucket.bytesOut += ev.bytesOut || 0;
}

const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);
const hourKey = (ts) => new Date(ts).toISOString().slice(0, 13);

class Usage {
  constructor() {
    this.data = { version: 1, totals: emptyBucket(), days: {}, hours: {}, models: {}, keys: {}, accounts: {}, providers: {}, firstAt: null, lastAt: null };
    this.events = [];
    this._timer = null;
    this._loaded = false;
  }

  load() {
    try {
      mkdirSync(dirname(FILE), { recursive: true });
      if (existsSync(FILE)) {
        const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          this.data = {
            version: 1,
            totals: { ...emptyBucket(), ...(parsed.totals || {}) },
            days: parsed.days || {},
            hours: parsed.hours || {},
            models: parsed.models || {},
            keys: parsed.keys || {},
            accounts: parsed.accounts || {},
            providers: parsed.providers || {},
            firstAt: parsed.firstAt || null,
            lastAt: parsed.lastAt || null,
          };
        }
      }
    } catch (err) {
      console.error(`[usage] 读取 ${FILE} 失败，从空表开始：${err.message}`);
    }
    this._loaded = true;
    this.prune();
    return this.data;
  }

  save() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.saveNow();
    }, 2000);
  }

  saveNow() {
    if (!this._loaded) return;
    try {
      const tmp = `${FILE}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      renameSync(tmp, FILE);
    } catch (err) {
      console.error(`[usage] 写入失败：${err.message}`);
    }
  }

  prune() {
    const days = Object.keys(this.data.days).sort();
    for (const k of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) delete this.data.days[k];
    const hours = Object.keys(this.data.hours).sort();
    for (const k of hours.slice(0, Math.max(0, hours.length - KEEP_HOURS))) delete this.data.hours[k];
  }

  /** 记一条请求。ev 由 engine 组装，字段缺失都当 0 处理 */
  record(ev) {
    const ts = ev.ts || Date.now();
    const e = { ...ev, ts };
    this.events.push(e);
    if (this.events.length > EVENT_CAP) this.events.splice(0, this.events.length - EVENT_CAP);

    const d = this.data;
    addTo(d.totals, e);
    const dk = dayKey(ts);
    const hk = hourKey(ts);
    (d.days[dk] ||= emptyBucket()) && addTo(d.days[dk], e);
    (d.hours[hk] ||= emptyBucket()) && addTo(d.hours[hk], e);
    if (e.model) (d.models[e.model] ||= emptyBucket()) && addTo(d.models[e.model], e);
    if (e.keyId) (d.keys[e.keyId] ||= emptyBucket()) && addTo(d.keys[e.keyId], e);
    if (e.accountId) (d.accounts[e.accountId] ||= emptyBucket()) && addTo(d.accounts[e.accountId], e);
    if (e.provider) (d.providers[e.provider] ||= emptyBucket()) && addTo(d.providers[e.provider], e);
    d.firstAt ||= new Date(ts).toISOString();
    d.lastAt = new Date(ts).toISOString();
    if (Object.keys(d.hours).length > KEEP_HOURS + 6) this.prune();
    this.save();
    return e;
  }

  /**
   * 按持久化的小时桶算时间窗。
   * 明细只在内存里（重启清空），所以 1 小时 / 24 小时这种"应该跟总数对得上"的
   * 数字必须走桶，不能走明细 —— 否则重启后会看到"24 小时 4 次、今天 16 次"这种自相矛盾。
   */
  bucketWindow(hoursBack) {
    const bucket = emptyBucket();
    const now = Date.now();
    for (let i = 0; i < hoursBack; i++) {
      const b = this.data.hours[hourKey(now - i * 3600_000)];
      if (!b) continue;
      for (const f of FIELDS) {
        if (f === 'latencyMaxMs') bucket[f] = Math.max(bucket[f], b[f] || 0);
        else bucket[f] += b[f] || 0;
      }
    }
    // 分位数只有明细才算得出来，桶里没有；这里给出这段时间内明细覆盖到的部分
    const since = now - hoursBack * 3600_000;
    const lat = this.events.filter((e) => e.ts >= since && e.latencyMs).map((e) => e.latencyMs).sort((a, b) => a - b);
    const pick = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor((lat.length * p) / 100))] : 0);
    return {
      ...bucket,
      windowMs: hoursBack * 3600_000,
      fromBuckets: true,
      p50: pick(50),
      p95: pick(95),
      p99: pick(99),
      latencySamples: lat.length,
      rpm: bucket.requests / (hoursBack * 60),
    };
  }

  /** 从内存明细里按时间窗算聚合（只用于分钟级窗口：桶的粒度是小时，不够用） */
  windowStats(ms) {
    const since = Date.now() - ms;
    const bucket = emptyBucket();
    const lat = [];
    for (const e of this.events) {
      if (e.ts < since) continue;
      addTo(bucket, e);
      if (e.latencyMs) lat.push(e.latencyMs);
    }
    lat.sort((a, b) => a - b);
    const pick = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor((lat.length * p) / 100))] : 0);
    return {
      ...bucket,
      windowMs: ms,
      sampleFromEvents: true,
      p50: pick(50),
      p95: pick(95),
      p99: pick(99),
      rpm: bucket.requests / (ms / 60000),
    };
  }

  /** 把分桶还原成时间序列，给前端画图/列表 */
  series(kind, count) {
    const src = kind === 'hour' ? this.data.hours : this.data.days;
    const now = Date.now();
    const out = [];
    for (let i = count - 1; i >= 0; i--) {
      const ts = kind === 'hour' ? now - i * 3600_000 : now - i * 86_400_000;
      const key = kind === 'hour' ? hourKey(ts) : dayKey(ts);
      const b = src[key] || emptyBucket();
      out.push({ key, ...b });
    }
    return out;
  }

  topBy(kind, limit = 10) {
    const src = this.data[kind] || {};
    return Object.entries(src)
      .map(([id, b]) => ({ id, ...b }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, limit);
  }

  recent(limit = 60) {
    return this.events.slice(-limit).reverse();
  }

  reset() {
    this.data = { version: 1, totals: emptyBucket(), days: {}, hours: {}, models: {}, keys: {}, accounts: {}, providers: {}, firstAt: null, lastAt: null };
    this.events = [];
    this.saveNow();
  }

  /** 控制台一次性要的全部数据 */
  /** 今天那个桶。SSE 每 2 秒要一次，单独开个口子省掉整份 snapshot 的开销 */
  today() {
    return this.data.days[dayKey(Date.now())] || emptyBucket();
  }

  snapshot({ recentLimit = 60 } = {}) {
    return {
      totals: this.data.totals,
      firstAt: this.data.firstAt,
      lastAt: this.data.lastAt,
      today: this.data.days[dayKey(Date.now())] || emptyBucket(),
      thisHour: this.data.hours[hourKey(Date.now())] || emptyBucket(),
      windows: {
        m5: this.windowStats(5 * 60_000),
        h1: this.bucketWindow(1),
        h24: this.bucketWindow(24),
      },
      hours: this.series('hour', 48),
      days: this.series('day', 30),
      byModel: this.topBy('models', 20),
      byKey: this.topBy('keys', 20),
      byAccount: this.topBy('accounts', 20),
      byProvider: this.topBy('providers', 10),
      recent: this.recent(recentLimit),
      eventsHeld: this.events.length,
      eventCap: EVENT_CAP,
    };
  }
}

export const usage = new Usage();

/**
 * 粗估 token 数（只在上游没给 usage 时用，会在明细里标 estimated）。
 * ASCII 大约 4 字符 1 token；CJK 基本 1 字 1 token。
 */
export function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  let ascii = 0;
  let wide = 0;
  for (const ch of s) {
    if (ch.codePointAt(0) < 128) ascii++;
    else wide++;
  }
  return Math.ceil(ascii / 4) + wide;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** 从非流式响应体里取 usage（OpenAI / Anthropic / Responses 三种形状都认） */
export function usageFromJson(obj) {
  const u = obj?.usage;
  if (!u || typeof u !== 'object') return null;
  const input = num(u.prompt_tokens) || num(u.input_tokens);
  const output = num(u.completion_tokens) || num(u.output_tokens);
  if (!input && !output) return null;
  return {
    input,
    output,
    cacheRead: num(u.cache_read_input_tokens) || num(u.prompt_tokens_details?.cached_tokens),
    cacheCreate: num(u.cache_creation_input_tokens),
    reasoning: num(u.completion_tokens_details?.reasoning_tokens) || num(u.output_tokens_details?.reasoning_tokens),
    estimated: false,
  };
}

/**
 * SSE 用量嗅探器：把每个 chunk 喂进来（原样透传，不改内容），
 * 结束时给出 usage。上游没报 usage 就用累计到的正文长度粗估。
 */
export function createUsageSniffer({ collectText = false } = {}) {
  let buf = '';
  let text = '';
  let found = null;
  let estTokens = 0;
  let events = 0;

  const eat = (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      return;
    }
    events++;
    // Anthropic：message_start 给 input，message_delta 给 output
    if (obj.type === 'message_start' && obj.message?.usage) {
      const u = usageFromJson(obj.message);
      if (u) found = { ...(found || {}), ...u, output: found?.output || u.output };
    } else if (obj.type === 'message_delta' && obj.usage) {
      const out = num(obj.usage.output_tokens);
      found = { input: found?.input || 0, output: out || found?.output || 0, cacheRead: found?.cacheRead || 0, cacheCreate: found?.cacheCreate || 0, reasoning: found?.reasoning || 0, estimated: false };
    } else if (obj.usage) {
      // OpenAI / Responses：带 usage 的那一帧（通常是最后一帧）
      const u = usageFromJson(obj);
      if (u) found = u;
    }
    // 正文长度（估算兜底用）
    const t = obj.delta?.text ?? obj.choices?.[0]?.delta?.content ?? obj.delta?.content ?? obj.text;
    if (typeof t === 'string' && t) {
      estTokens += estimateTokens(t);
      if (collectText && text.length < 512 * 1024) text += t;
    }
  };

  return {
    push(text) {
      buf += text;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        eat(buf.slice(0, idx).trim());
        buf = buf.slice(idx + 1);
      }
      if (buf.length > 64 * 1024) buf = buf.slice(-1024); // 防御：不正常的流别把内存吃了
    },
    result() {
      if (buf.trim()) eat(buf.trim());
      if (found) return found;
      if (!estTokens) return null;
      return { input: 0, output: estTokens, cacheRead: 0, cacheCreate: 0, reasoning: 0, estimated: true };
    },
    get events() {
      return events;
    },
    get text() {
      return text;
    },
  };
}
