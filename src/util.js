// 通用小工具：没有第三方依赖，全部基于 node 标准库。
import { randomBytes, createHmac, timingSafeEqual, createHash } from 'node:crypto';

export function nowIso() {
  return new Date().toISOString();
}

export function randomId(bytes = 8) {
  return randomBytes(bytes).toString('hex');
}

/** 生成给用户复制的 API key：sk-xxxx 形式，方便各种 OpenAI 客户端识别 */
export function generateApiKey() {
  return 'sk-fb-' + randomBytes(24).toString('base64url');
}

/**
 * 定长时序安全比较：先各自 sha256 再比，这样连"长度不同"这一位都不泄露
 * （直接 timingSafeEqual 需要先判长度，等于把长度告诉了攻击者）。
 */
export function constantTimeEqual(a, b) {
  const da = createHash('sha256').update(String(a ?? ''), 'utf8').digest();
  const db = createHash('sha256').update(String(b ?? ''), 'utf8').digest();
  return timingSafeEqual(da, db);
}

export function maskSecret(value, keep = 6) {
  const s = String(value || '');
  if (s.length <= keep + 4) return s.slice(0, 2) + '***';
  return s.slice(0, keep) + '…' + s.slice(-4);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

export function sendJson(res, status, obj, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  const body = Buffer.from(text);
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    ...extraHeaders,
  });
  res.end(body);
}

/** 读取请求体，带上限保护（默认 2MB，聊天请求可以更大，由调用方传） */
export async function readBody(req, limitBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      const err = new Error('请求体过大');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, limitBytes) {
  const raw = await readBody(req, limitBytes);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    const err = new Error('请求体不是合法 JSON');
    err.statusCode = 400;
    throw err;
  }
}

/**
 * 取客户端 IP。注意 X-Forwarded-For 的左边是客户端自己能随便写的，
 * 只有最右边那几跳是可信代理追加的 —— 取错方向会让限流被 XFF 伪造绕过。
 * hops = 你前面有几层可信代理（Railway 是 1）。
 */
export function clientIp(req, hops = 1) {
  const raw = req.headers['x-forwarded-for'];
  if (typeof raw === 'string' && raw.trim()) {
    const parts = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) {
      const idx = Math.max(0, parts.length - Math.max(1, hops));
      return parts[idx];
    }
  }
  return req.socket?.remoteAddress || 'unknown';
}

const HOST_RE = /^[a-z0-9.\-\[\]:]+$/i;

/** 反代后面拿对外地址；Host 头是客户端可控的，所以要校验并优先用部署平台给的域名 */
export function publicBaseUrl(req) {
  const configured = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;

  const railway = (process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
  const raw = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim();
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(raw);
  // Host 头带了奇怪字符（换行、路径、@ 之类）就不认，回落到平台域名
  const host = HOST_RE.test(raw) ? raw : '';
  if (!host) return railway ? `https://${railway}` : 'http://localhost';
  // 平台给了固定域名时，只接受它或本机地址，避免 Host 头注入把控制台里显示的
  // Base URL 换成攻击者的域名（管理员照着复制就会把 API key 发到别处）
  if (railway && !local && host.toLowerCase() !== railway.toLowerCase()) {
    return `https://${railway}`;
  }
  let proto = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim();
  if (!/^https?$/.test(proto)) proto = local ? 'http' : 'https';
  return `${proto}://${host}`;
}

// ---------------------------------------------------------------------------
// Cookie + 签名会话
// ---------------------------------------------------------------------------

export function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    // 非法百分号序列（例如 "a=%"）会让 decodeURIComponent 抛 URIError。
    // 这个函数在 WebSocket 升级路径上也会被调用，抛出去就是没人接的异常。
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function serializeCookie(name, value, opts = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge != null) bits.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  bits.push(`Path=${opts.path || '/'}`);
  if (opts.httpOnly !== false) bits.push('HttpOnly');
  if (opts.secure) bits.push('Secure');
  bits.push(`SameSite=${opts.sameSite || 'Lax'}`);
  return bits.join('; ');
}

/** payload(JSON) → base64url.hmac 的简易签名 token（无状态会话，重启后凭密钥继续有效） */
export function signToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyToken(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.', 2);
  const expect = createHmac('sha256', secret).update(body).digest('base64url');
  // 必须比字节长度：字符串长度相等但字节长度不等时 timingSafeEqual 会直接抛
  const a = Buffer.from(mac, 'utf8');
  const b = Buffer.from(expect, 'utf8');
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    // exp 缺失或不是有限数字一律当过期（fail-closed）：
    // SESSION_TTL_HOURS 配成非数字会让 exp 变成 null，那时候不能签出永久有效的 cookie
    if (!Number.isFinite(payload?.exp) || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 简易滑动窗口限流（内存，够用于单实例后台登录防爆破）
// ---------------------------------------------------------------------------

export function createRateLimiter({ windowMs = 15 * 60 * 1000, max = 12 } = {}) {
  const hits = new Map(); // key -> number[]（时间戳）
  return {
    check(key) {
      const now = Date.now();
      const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
      hits.set(key, arr);
      if (arr.length >= max) {
        return { ok: false, retryAfterMs: windowMs - (now - arr[0]) };
      }
      return { ok: true, remaining: max - arr.length - 1 };
    },
    hit(key) {
      const now = Date.now();
      const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
      arr.push(now);
      hits.set(key, arr);
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 简单的在飞计数闸门：超过上限直接拒，避免请求堆积把内存/事件循环打满 */
export function createGate(max) {
  let inflight = 0;
  return {
    get inflight() {
      return inflight;
    },
    tryEnter() {
      if (inflight >= max) return false;
      inflight++;
      return true;
    },
    leave() {
      inflight = Math.max(0, inflight - 1);
    },
  };
}

/** 带超时的 fetch，返回 { status, data, text } */
export async function httpJson(url, { method = 'GET', headers = {}, body, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { status: resp.status, data, text, headers: resp.headers };
  } catch (err) {
    return { status: 0, data: null, text: '', error: err.name === 'AbortError' ? '请求超时' : err.message };
  } finally {
    clearTimeout(timer);
  }
}
