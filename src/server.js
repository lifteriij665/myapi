// 入口：一个 Node http 服务同时提供
//   1) 管理控制台（静态页面 + /admin/api/*，密码解锁）
//   2) 内置浏览器画面推流（WebSocket /admin/ws/browser）
//   3) 对外 OpenAI / Anthropic 兼容 API（/v1/*，交给 vendor/worker.js 引擎）
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, normalize, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';

import { config, ensureDirs } from './config.js';
import { store } from './store.js';
import { handleAdminApi, isAuthed } from './admin.js';
import { handleApiRequest } from './engine.js';
import { getSession, closeAllBrowsers, browserFeature } from './browser.js';
import { refreshCatalog } from './models.js';
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
  if (!file.startsWith(config.publicDir)) {
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
    // 健康检查：免鉴权，给 Railway 的 healthcheck 和外部监控用
    if (pathname === '/healthz' || pathname === '/health') {
      const accounts = store.accounts.filter((a) => a.enabled);
      sendJson(res, 200, {
        status: accounts.length ? 'ok' : 'no_accounts',
        version: config.version,
        accounts: accounts.length,
        accounts_total: store.accounts.length,
        keys: store.keys.filter((k) => k.enabled !== false).length,
        storage_persistent: config.persistentData,
        browser_login: browserFeature().available,
        time: new Date().toISOString(),
      });
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
  store.load();

  // 首次启动没设密码：生成一个随机密码打印到日志（Railway 面板里能看到）
  let generatedPassword = null;
  if (!store.hasPassword()) {
    generatedPassword = randomBytes(9).toString('base64url');
    store.setPassword(generatedPassword);
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
  });

  return { server, generatedPassword };
}

const isMain = Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain || process.env.MYAPI_FORCE_START === '1') {
  const { server } = createApp();

  server.listen(config.port, config.host, () => {
    console.log(`[myapi] v${config.version} 已启动 → http://${config.host}:${config.port}`);
    console.log(`[myapi] 数据目录 ${config.dataDir}（${config.persistentData ? '持久' : '⚠️ 非持久，重新部署会清空'}）`);
    console.log(`[myapi] 账号 ${store.accounts.length} 个，API key ${store.keys.length} 个`);
    const feat = browserFeature();
    console.log(
      `[myapi] 内置浏览器：${feat.available ? `可用（headless=${feat.headless}, DISPLAY=${feat.display || '无'}）` : `关闭（${feat.reason}）`}`
    );
    if (config.onRailway && !config.railwayVolume) {
      console.warn('[myapi] ⚠️ 没检测到 Railway Volume：账号和 key 在重新部署后会丢失，建议挂一个 Volume 到 /data');
    }
    refreshCatalog().catch(() => {});
  });

  const shutdown = async (signal) => {
    console.log(`[myapi] 收到 ${signal}，正在收尾…`);
    store.saveNow();
    await closeAllBrowsers().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => console.error('[myapi] unhandledRejection:', err));
  process.on('uncaughtException', (err) => console.error('[myapi] uncaughtException:', err));
}
