// 授权码轮询登录（和官方 CLI 同一条链路，不需要机器人、不需要本地脚本）：
//   1. POST /api/auth/cli/code  {fingerprintId}          → { loginUrl, fingerprintHash, expiresAt }
//   2. 用户在浏览器里打开 loginUrl 完成 Google / GitHub 登录
//   3. 轮询 GET /api/auth/cli/status?fingerprintId&fingerprintHash&expiresAt
//      401 = 还没授权；200 + user.authToken = 成功
// 第 2 步既可以在「你自己的浏览器」打开（推荐），也可以由服务器内置的 patchright
// Chromium 打开（browser.js），两种方式共用同一个 flow 对象。
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { store } from './store.js';
import { httpJson, randomId, nowIso } from './util.js';

const flows = new Map(); // id -> flow
const FLOW_TTL_MS = 30 * 60 * 1000;

function fingerprintId() {
  return 'codebuff-cli-' + randomBytes(6).toString('base64url').slice(0, 8);
}

function log(flow, message) {
  flow.log.push({ at: nowIso(), message });
  if (flow.log.length > 60) flow.log.shift();
  console.log(`[login ${flow.id}] ${message}`);
}

export function publicFlow(flow) {
  if (!flow) return null;
  return {
    id: flow.id,
    state: flow.state,
    mode: flow.mode,
    provider: flow.provider || 'freebuff',
    pool: flow.pool,
    loginUrl: flow.loginUrl,
    expiresAt: flow.expiresAt,
    createdAt: flow.createdAt,
    deadline: flow.deadline,
    error: flow.error || null,
    account: flow.account
      ? { id: flow.account.id, email: flow.account.email, name: flow.account.name, pool: flow.account.pool }
      : null,
    browser: flow.browser ? { ready: Boolean(flow.browser.ready), error: flow.browser.error || null } : null,
    log: flow.log.slice(-12),
  };
}

export function getFlow(id) {
  return flows.get(id) || null;
}

export function listFlows() {
  return [...flows.values()].map(publicFlow);
}

function cleanup() {
  const now = Date.now();
  for (const [id, flow] of flows) {
    if (now - flow.createdAt > FLOW_TTL_MS) {
      if (flow.browser?.close) flow.browser.close().catch(() => {});
      flows.delete(id);
    }
  }
}

export const OPENCODE_LOGIN_URL = 'https://opencode.ai/zen';

/**
 * opencode Zen 的"登录"流程。
 *
 * 它没有 CLI 授权码那一套（/auth/* 是浏览器回调端点，探过：GET 回 500
 * "No authorization code found."，也没有 oauth-authorization-server 发现文档），
 * 官方文档写的就是"登录网页 → 复制 API key → 粘进客户端"。
 * 所以这里不轮询，只负责把 Zen 控制台开在内置浏览器里，用户登录后把 key
 * 粘到旁边的输入框（也可以在自己电脑上登录后再粘过来）。
 */
export function startOpencodeFlow({ pool = 'free' } = {}) {
  cleanup();
  const flow = {
    id: randomId(6),
    state: 'pending',
    mode: 'browser',
    provider: 'opencode',
    pool: ['any', 'free', 'paid'].includes(pool) ? pool : 'free',
    loginUrl: OPENCODE_LOGIN_URL,
    expiresAt: null,
    createdAt: Date.now(),
    deadline: Date.now() + FLOW_TTL_MS,
    attempts: 0,
    error: null,
    account: null,
    browser: null,
    log: [],
  };
  flows.set(flow.id, flow);
  log(flow, '已打开 opencode Zen 控制台：登录后在页面里复制 API key，粘到右边的输入框');
  return flow;
}

/** opencode 流程的收尾：把用户粘进来的 key 落库 */
export function finishOpencodeFlow(flow, token, { name = '' } = {}) {
  const clean = String(token || '').trim();
  if (clean.length <= 8) {
    throw Object.assign(new Error('这个 key 太短了，确认整段都复制到了？'), { statusCode: 400 });
  }
  const { account, duplicated } = store.addAccount({
    token: clean,
    name: name || 'opencode Zen',
    provider: 'opencode',
    pool: flow?.pool || 'free',
    source: 'browser-login',
  });
  if (flow) {
    flow.account = account;
    flow.state = 'done';
    log(flow, duplicated ? `已更新已存在的 opencode 号 ${account.id}` : `opencode key 已加入号池（${account.id}）`);
    if (flow.browser?.close) setTimeout(() => flow.browser?.close?.().catch(() => {}), 3000);
  }
  return account;
}

/** 向上游申请一次登录授权码 */
export async function startFlow({ mode = 'link', pool = 'any' } = {}) {
  cleanup();
  const fid = fingerprintId();
  const resp = await httpJson(`${config.upstreamBase}/api/auth/cli/code`, {
    method: 'POST',
    body: { fingerprintId: fid },
    headers: {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
  });
  if (resp.status !== 200 || !resp.data?.loginUrl) {
    const detail = resp.error || resp.text?.slice(0, 200) || `HTTP ${resp.status}`;
    throw Object.assign(new Error(`向上游申请登录链接失败：${detail}`), { statusCode: 502 });
  }

  // loginUrl 是上游给的，不能无条件信：必须是 https 的公网地址，
  // 否则内置浏览器就会被上游牵着去访问容器内网 / 本地文件
  let loginUrl;
  try {
    const u = new URL(String(resp.data.loginUrl));
    const host = u.hostname.toLowerCase();
    const privateHost =
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.internal') ||
      /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
      host === '::1';
    if (u.protocol !== 'https:' || privateHost) throw new Error('协议或地址不可信');
    loginUrl = u.toString();
    const upstreamHost = new URL(config.upstreamBase).hostname;
    if (host !== upstreamHost.toLowerCase()) {
      console.warn(`[login] 上游返回的登录域名 ${host} 与 ${upstreamHost} 不一致，仍继续但请留意`);
    }
  } catch (err) {
    throw Object.assign(new Error(`上游返回的登录链接不可信（${err.message}），已中止`), { statusCode: 502 });
  }

  const flow = {
    id: randomId(6),
    state: 'pending',
    mode,
    provider: 'freebuff',
    pool: ['any', 'free', 'paid'].includes(pool) ? pool : 'any',
    fingerprintId: fid,
    fingerprintHash: resp.data.fingerprintHash,
    expiresAt: resp.data.expiresAt,
    loginUrl,
    createdAt: Date.now(),
    deadline: Date.now() + config.loginPollTimeoutMs,
    attempts: 0,
    error: null,
    account: null,
    browser: null,
    log: [],
  };
  flows.set(flow.id, flow);
  log(flow, `已申请授权链接（fingerprint=${fid}），等待完成登录`);
  poll(flow);
  return flow;
}

async function poll(flow) {
  const query = new URLSearchParams({
    fingerprintId: flow.fingerprintId,
    fingerprintHash: flow.fingerprintHash,
    expiresAt: String(flow.expiresAt),
  });
  while (flow.state === 'pending') {
    if (Date.now() > flow.deadline) {
      flow.state = 'timeout';
      flow.error = '等待授权超时，请重新开始';
      log(flow, flow.error);
      break;
    }
    await new Promise((r) => setTimeout(r, config.loginPollIntervalMs));
    if (flow.state !== 'pending') break;
    flow.attempts++;
    const resp = await httpJson(`${config.upstreamBase}/api/auth/cli/status?${query}`, { timeoutMs: 20000 });

    if (resp.status === 200 && resp.data?.user?.authToken) {
      const user = resp.data.user;
      try {
        const { account, duplicated, refreshed } = store.addAccount({
          token: user.authToken,
          email: user.email || '',
          name: user.name || user.email || '',
          pool: flow.pool,
          source: flow.mode === 'browser' ? 'browser-login' : 'link-login',
          user,
        });
        flow.account = account;
        flow.state = 'done';
        log(
          flow,
          duplicated
            ? `登录成功：${account.email || account.id}（账号已存在，已刷新信息）`
            : refreshed
              ? `登录成功：${account.email || account.id}（同邮箱账号已更新 token）`
              : `登录成功：${account.email || account.id}，已加入账号池`
        );
      } catch (err) {
        flow.state = 'error';
        flow.error = err.message;
        log(flow, `保存账号失败：${err.message}`);
      }
      break;
    }
    if (resp.status === 400) {
      flow.state = 'error';
      flow.error = '授权链接已失效，请重新开始';
      log(flow, flow.error);
      break;
    }
    if (resp.status === 401) {
      if (flow.attempts % 5 === 0) log(flow, `仍在等待授权（第 ${flow.attempts} 次轮询）`);
      continue;
    }
    if (resp.status === 0) {
      log(flow, `轮询网络异常：${resp.error}`);
      continue;
    }
    if (flow.attempts % 5 === 0) log(flow, `上游返回 ${resp.status}，继续等待`);
  }

  // 登录结束后关掉内置浏览器（成功/失败都关，省内存）
  if (flow.browser?.close) {
    setTimeout(() => {
      flow.browser?.close?.().catch(() => {});
    }, flow.state === 'done' ? 3000 : 60000);
  }
}

export function cancelFlow(id) {
  const flow = flows.get(id);
  if (!flow) return false;
  if (flow.state === 'pending') {
    flow.state = 'cancelled';
    flow.error = '已手动取消';
    log(flow, flow.error);
  }
  if (flow.browser?.close) flow.browser.close().catch(() => {});
  return true;
}
