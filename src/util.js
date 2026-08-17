// 通用小工具：没有第三方依赖，全部基于 node 标准库。
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

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

export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/** 反代后面拿真实的对外地址（Railway 会带 x-forwarded-proto / host） */
export function publicBaseUrl(req) {
  const envDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  const host = (req.headers['x-forwarded-host'] || req.headers.host || envDomain || 'localhost').toString().split(',')[0].trim();
  let proto = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim();
  if (!proto) proto = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ? 'http' : 'https';
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
    if (k) out[k] = decodeURIComponent(v);
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
  if (mac.length !== expect.length) return null;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
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
