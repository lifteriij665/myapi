// 入口：一个 Node http 服务同时提供
//   1) 管理控制台（静态页面 + /admin/api/*，密码解锁）
//   2) 内置浏览器画面推流（WebSocket /admin/ws/browser）
//   3) 对外 OpenAI / Anthropic 兼容 API（/v1/*，交给 vendor/worker.js 引擎）
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, normalize, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';

import { config, ensureDirs } from './config.js';
import { store } from './store.js';
import { usage } from './usage.js';
import { handleAdminApi, isAuthed } from './admin.js';
import { handleApiRequest, callWorker } from './engine.js';
import { getSession, closeAllBrowsers, browserFeature } from './browser.js';
import { refreshCatalog, noteEngineModelList } from './models.js';
import { sendJson, sendText, publicBaseUrl } from './util.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const API_EXACT = new Set(['/models', '/chat/completions', '/responses', '/messages', '/messages/count_tokens']);

function isApiPath(pathname) {
  return pathname === '/v1' || pathname.startsWith('/v1/') || API_EXACT.has(pathname);
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : normalize(pathname).replace(/^([/\\.]+)/, '');
  const file = resolve(config.publicDir, rel);
  // 必须是 publicDir 本身或它下面的文件；只用 startsWith 会把同前缀的兄弟目录
  // （/app/public-evil）也放进来
  if (file !== config.publicDir && !file.startsWith(config.publicDir + sep)) {
    sendText(res, 403, 'forbidden');
    return true;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    const body = await readFile(file);
    const isHtml = extname(file) === '.html';
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': isHtml ? 'no-store' : 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      ...(isHtml
        ? {
            'x-frame-options': 'DENY',
            'referrer-policy': 'no-referrer',
            // 页面模板里有少量内联 style（宽度/间距），所以 style-src 放开 unsafe-inline；
            // 脚本仍然只允许同源文件，XSS 的主要面已经堵住
            'content-security-policy':
              "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'",
          }
        : {}),
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

async function requestHandler(req, res) {
  let url;
  try {
    url = new URL(req.url, publicBaseUrl(req));
  } catch {
    sendText(res, 400, 'bad request');
    return;
  }
  const pathname = url.pathname;

  try {
    // 健康检查：免鉴权，给 Railway 的 healthcheck 和外部监控用。
    // 对外只说"活着 / 有没有号"，账号数、key 数这些留给登录后的 /admin/api/state，
    // 免得公网上任何人都能摸清这个部署的规模。
    if (pathname === '/healthz' || pathname === '/health') {
      const usable = store.accounts.filter((a) => a.enabled).length;
      const base = {
        status: store.accounts.length === 0 ? 'no_accounts' : usable === 0 ? 'no_enabled_accounts' : 'ok',
        version: config.version,
        time: new Date().toISOString(),
      };
      const detail = isAuthed(req)
        ? {
            accounts: usable,
            accounts_total: store.accounts.length,
            keys: store.keys.filter((k) => k.enabled !== false).length,
            storage_persistent: config.persistentData,
            browser_login: browserFeature().available,
          }
        : null;
      sendJson(res, 200, detail ? { ...base, ...detail } : base);
      return;
    }

    if (pathname.startsWith('/admin/api/')) {
      await handleAdminApi(req, res, url);
      return;
    }

    if (isApiPath(pathname)) {
      await handleApiRequest(req, res, url);
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (await serveStatic(req, res, pathname)) return;
      // 控制台是单页应用，未知路径回落到首页
      if (!pathname.startsWith('/admin/ws')) {
        if (await serveStatic(req, res, '/')) return;
      }
    }

    sendJson(res, 404, { error: { message: `Not found: ${pathname}`, type: 'not_found' } });
  } catch (err) {
    console.error(`[server] ${req.method} ${pathname} 出错: ${err.stack || err.message}`);
    if (!res.headersSent) {
      sendJson(res, err.statusCode || 500, { error: { message: err.message || 'internal error', type: 'server_error' } });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

export function createApp() {
  ensureDirs();
  try {
    store.load();
    usage.load();
  } catch (err) {
    // 数据目录有问题也要把服务起起来：至少 /healthz 和控制台能回话，
    // 用户才看得到"数据目录不可写"这种提示，而不是面对一个健康检查失败的部署。
    console.error(`[myapi] 读取数据失败，先用内存里的空配置启动：${err.message}`);
  }

  // 首次启动没设密码：生成一个随机密码打印到日志（Railway 面板里能看到）
  let generatedPassword = null;
  if (!store.hasPassword()) {
    generatedPassword = randomBytes(9).toString('base64url');
    try {
      store.setPassword(generatedPassword, { generated: true });
    } catch {}
    console.log('');
    console.log('==========================================================');
    console.log('  没有检测到 ADMIN_PASSWORD，已自动生成一个管理密码：');
    console.log(`      ${generatedPassword}`);
    console.log('  建议改用环境变量 ADMIN_PASSWORD 固定下来（改完重新部署）。');
    console.log('==========================================================');
    console.log('');
  }

  const server = createServer(requestHandler);
  server.headersTimeout = 65000;
  server.requestTimeout = 0; // 流式聊天可能很久，不要被默认超时掐断
  server.keepAliveTimeout = 61000;

  // 内置浏览器画面：WebSocket 只允许已登录的管理会话接入
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
   try {
    let url;
    try {
      url = new URL(req.url, 'http://internal');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/admin/ws/browser') {
      socket.destroy();
      return;
    }
    // WebSocket 握手不受 CORS 约束，所以自己校验 Origin：浏览器发起的跨站握手一律拒绝
    const origin = req.headers.origin;
    if (origin) {
      let sameSite = false;
      try {
        const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim();
        sameSite = new URL(origin).host === host;
      } catch {}
      if (!sameSite) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    if (!isAuthed(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const session = getSession(url.searchParams.get('flow') || '');
    if (!session) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      session.addClient(ws);
      ws.on('message', async (data) => {
        try {
          await session.enqueueInput(JSON.parse(data.toString()));
        } catch (err) {
          /* 单条输入失败不影响会话 */
        }
      });
      ws.on('close', () => session.removeClient(ws));
      ws.on('error', () => session.removeClient(ws));
    });
   } catch (err) {
    console.error(`[server] WebSocket 升级处理出错：${err.message}`);
    try { socket.destroy(); } catch {}
   }
  });

  return { server, generatedPassword };
}

const isMain = Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain || process.env.MYAPI_FORCE_START === '1') {
  const { server } = createApp();

  const ready = () => {
    const addr = server.address();
    const where = typeof addr === 'string' ? addr : `${addr.address}:${addr.port}`;
    console.log(`[myapi] v${config.version} 已监听 ${where}`);
    console.log(`[myapi] 数据目录 ${config.dataDir}（${config.persistentData ? '持久' : '⚠️ 非持久，重新部署会清空'}）`);
    console.log(`[myapi] 账号 ${store.accounts.length} 个，API key ${store.keys.length} 个`);
    const feat = browserFeature();
    console.log(
      `[myapi] 内置浏览器：${feat.available ? `可用（headless=${feat.headless}, DISPLAY=${feat.display || '无'}）` : `关闭（${feat.reason}）`}`
    );
    if (config.onRailway && !config.railwayVolume) {
      console.warn('[myapi] ⚠️ 没检测到 Railway Volume：账号和 key 在重新部署后会丢失，建议挂一个 Volume 到 /data');
    }
    refreshCatalog()
      .then(async () => {
        // 预热：问一次引擎自己的模型列表，把"上游已暂停"的那些先标出来
        try {
          const resp = await callWorker('/v1/models');
          const data = await resp.json();
          const ids = Array.isArray(data?.data) ? data.data.map((m) => m.id).filter(Boolean) : [];
          const paused = noteEngineModelList(ids);
          if (paused.size) console.log(`[myapi] 引擎已屏蔽的模型：${[...paused].join(', ')}`);
        } catch {}
      })
      .catch(() => {});
  };

  // 先试 IPv6 双栈，不行再退 IPv4；两个都失败才退出（并把原因打清楚）
  const bind = (host, isRetry = false) => {
    const onError = (err) => {
      if (!isRetry && host !== '0.0.0.0') {
        console.warn(`[myapi] 绑定 [${host}]:${config.port} 失败（${err.code || err.message}），退回 0.0.0.0`);
        bind('0.0.0.0', true);
        return;
      }
      console.error(`[myapi] 监听 ${host}:${config.port} 失败：${err.code || err.message}`);
      process.exit(1);
    };
    server.once('error', onError);
    server.listen(config.port, host, () => {
      server.removeListener('error', onError);
      ready();
    });
  };
  bind(config.host);

  const shutdown = async (signal) => {
    console.log(`[myapi] 收到 ${signal}，正在收尾…`);
    store.saveNow();
    usage.saveNow();
    await closeAllBrowsers().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => console.error('[myapi] unhandledRejection:', err));
  process.on('uncaughtException', (err) => console.error('[myapi] uncaughtException:', err));
}
