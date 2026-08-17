// 服务器内置浏览器（patchright Chromium）+ CDP 截屏推流，把远程浏览器画面搬进管理页面。
//
// 为什么用 patchright：它是 playwright 的补丁分支，去掉了 CDP Runtime.enable 之类的
// 自动化指纹泄漏点，配合 Xvfb 下的 headful 模式，指纹接近真实浏览器 —— 这就是「指纹浏览器」
// 效果的来源。注意 patchright 官方明确不建议再手动改 UA / 加 --disable-blink-features
// 之类的参数，那样反而更容易被识别，所以这里的启动参数保持最小集。
//
// 画面：CDP Page.startScreencast → Page.screencastFrame(JPEG base64) → WebSocket → <img>
// 操作：浏览器端把鼠标/键盘事件（坐标归一化 0~1）发回来 → page.mouse / page.keyboard
import { rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config, browserHeadless } from './config.js';
import { randomId } from './util.js';

let chromiumPromise = null;
let loadError = null;

async function loadChromium() {
  if (!chromiumPromise) {
    chromiumPromise = import('patchright')
      .then((mod) => mod.chromium || mod.default?.chromium)
      .catch((err) => {
        loadError = err;
        return null;
      });
  }
  return chromiumPromise;
}

export function browserFeature() {
  if (!config.enableBrowserLogin) {
    return { available: false, reason: '已通过 ENABLE_BROWSER_LOGIN=false 关闭内置浏览器' };
  }
  return {
    available: true,
    headless: browserHeadless(),
    display: process.env.DISPLAY || null,
    proxy: config.browserProxy ? config.browserProxy.replace(/\/\/.*@/, '//***@') : null,
    loadError: loadError?.message || null,
  };
}

const KEY_MAP = {
  Enter: 'Enter',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Delete: 'Delete',
  Escape: 'Escape',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Shift: 'Shift',
  Control: 'Control',
  Alt: 'Alt',
  Meta: 'Meta',
  CapsLock: 'CapsLock',
  Insert: 'Insert',
  F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
  F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
};

class BrowserSession {
  constructor({ profile = 'fresh' } = {}) {
    this.id = randomId(4);
    this.profile = profile;
    this.profileDir =
      profile === 'shared'
        ? resolve(config.browserProfileDir, 'shared')
        : resolve(config.browserProfileDir, `fresh-${this.id}`);
    this.ephemeralProfile = profile !== 'shared';
    this.context = null;
    this.page = null;
    this.cdp = null;
    this.clients = new Set();
    this.ready = false;
    this.error = null;
    this.closed = false;
    this.lastFrame = null; // 新客户端连上来先补一帧
    this.metadata = null;
    this.viewport = { w: 1440, h: 900 };
    this.idleTimer = null;
    this.inputChain = Promise.resolve();
  }

  async launch(startUrl) {
    const chromium = await loadChromium();
    if (!chromium) {
      throw Object.assign(
        new Error(
          `内置浏览器不可用：${loadError?.message || 'patchright 未安装'}。` +
            '镜像构建时用 --build-arg INSTALL_CHROMIUM=false 会跳过 Chromium 下载；' +
            '请改用「授权链接」或「手动粘贴 token」方式添加账号。'
        ),
        { statusCode: 501 }
      );
    }
    await mkdir(this.profileDir, { recursive: true });
    const headless = browserHeadless();
    const args = [
      '--no-sandbox', // 容器里通常是 root，没有这个 Chromium 起不来
      '--disable-dev-shm-usage', // 容器 /dev/shm 常常只有 64MB
      `--window-size=${this.viewport.w},${this.viewport.h}`,
      '--no-first-run',
      '--no-default-browser-check',
    ];
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless,
      viewport: null, // patchright 建议交给真实窗口尺寸，别设虚拟 viewport
      args,
      locale: process.env.BROWSER_LOCALE || 'en-US',
      timezoneId: process.env.BROWSER_TIMEZONE || 'America/Los_Angeles',
      proxy: config.browserProxy ? { server: config.browserProxy } : undefined,
      acceptDownloads: false,
    });
    this.context.setDefaultTimeout(45000);
    this.context.on('page', (page) => {
      // OAuth 常常开新标签/弹窗，画面自动跟过去
      this.attachPage(page).catch(() => {});
    });
    this.context.on('close', () => {
      this.closed = true;
      this.broadcast({ t: 'closed' });
    });

    const page = this.context.pages()[0] || (await this.context.newPage());
    await this.attachPage(page);
    this.ready = true;
    if (startUrl) await this.navigate(startUrl);
    this.armIdleTimer();
    return this;
  }

  async attachPage(page) {
    if (this.closed || !page || page === this.page) return;
    if (this.cdp) {
      try {
        await this.cdp.send('Page.stopScreencast');
      } catch {}
      try {
        await this.cdp.detach();
      } catch {}
      this.cdp = null;
    }
    this.page = page;
    page.on('close', () => {
      if (this.page !== page) return;
      const rest = this.context?.pages().filter((p) => p !== page && !p.isClosed()) || [];
      this.page = null;
      if (rest.length) this.attachPage(rest[rest.length - 1]).catch(() => {});
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) this.pushStatus();
    });
    this.cdp = await this.context.newCDPSession(page);
    await this.cdp.send('Page.enable');
    this.cdp.on('Page.screencastFrame', async (frame) => {
      // 必须 ack，不然上游不再推下一帧
      try {
        await this.cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
      } catch {}
      this.metadata = frame.metadata;
      this.lastFrame = frame.data;
      this.broadcast({ t: 'frame', data: frame.data, meta: frame.metadata });
    });
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: parseInt(process.env.SCREENCAST_QUALITY || '55', 10),
      maxWidth: 1440,
      maxHeight: 900,
      everyNthFrame: 1,
    });
    this.pushStatus();
  }

  async pushStatus() {
    if (this.closed || !this.page) return;
    try {
      const [url, title] = await Promise.all([Promise.resolve(this.page.url()), this.page.title().catch(() => '')]);
      this.broadcast({ t: 'status', url, title, pages: this.context?.pages().length || 1 });
    } catch {}
  }

  async viewportSize() {
    if (this.metadata?.deviceWidth) {
      return { w: this.metadata.deviceWidth, h: this.metadata.deviceHeight };
    }
    try {
      const size = await this.page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      if (size?.w) return size;
    } catch {}
    return this.viewport;
  }

  // --- 客户端 ----------------------------------------------------------

  addClient(ws) {
    this.clients.add(ws);
    this.armIdleTimer();
    if (this.lastFrame) {
      this.sendTo(ws, { t: 'frame', data: this.lastFrame, meta: this.metadata });
    }
    this.pushStatus();
  }

  removeClient(ws) {
    this.clients.delete(ws);
    this.armIdleTimer();
  }

  sendTo(ws, obj) {
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    } catch {}
  }

  broadcast(obj) {
    const payload = JSON.stringify(obj);
    for (const ws of this.clients) {
      try {
        // 客户端积压太多就丢帧，宁可掉帧也不要让内存涨起来
        if (ws.readyState === 1 && (obj.t !== 'frame' || ws.bufferedAmount < 512 * 1024)) ws.send(payload);
      } catch {}
    }
  }

  armIdleTimer() {
    clearTimeout(this.idleTimer);
    if (this.closed) return;
    this.idleTimer = setTimeout(() => {
      if (!this.clients.size) {
        console.log(`[browser ${this.id}] 空闲超时，关闭浏览器`);
        this.close().catch(() => {});
      } else {
        this.armIdleTimer();
      }
    }, config.browserIdleTimeoutMs);
  }

  // --- 操作 ------------------------------------------------------------

  /**
   * 输入事件必须串行执行：mousedown / mouseup 是两条独立的 WebSocket 消息，
   * 如果并发处理，mouseup 可能抢在 mousedown 前面发给浏览器，点击就丢了。
   */
  enqueueInput(msg) {
    this.inputChain = this.inputChain.then(() => this.handleInput(msg)).catch(() => {});
    return this.inputChain;
  }

  async navigate(url) {
    if (!this.page) return;
    const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    await this.page.goto(target, { waitUntil: 'domcontentloaded' }).catch((err) => {
      this.broadcast({ t: 'error', message: `打开 ${target} 失败：${err.message}` });
    });
    this.pushStatus();
  }

  async handleInput(msg) {
    if (!this.page || this.closed) return;
    const { w, h } = await this.viewportSize();
    const x = Math.max(0, Math.min(1, Number(msg.x) || 0)) * w;
    const y = Math.max(0, Math.min(1, Number(msg.y) || 0)) * h;
    const button = msg.button === 2 ? 'right' : msg.button === 1 ? 'middle' : 'left';
    switch (msg.t) {
      case 'move':
        await this.page.mouse.move(x, y);
        break;
      case 'down':
        await this.page.mouse.move(x, y);
        await this.page.mouse.down({ button, clickCount: msg.clickCount || 1 });
        break;
      case 'up':
        await this.page.mouse.up({ button, clickCount: msg.clickCount || 1 });
        break;
      case 'wheel':
        await this.page.mouse.move(x, y);
        await this.page.mouse.wheel(Number(msg.dx) || 0, Number(msg.dy) || 0);
        break;
      case 'text':
        if (typeof msg.text === 'string' && msg.text) await this.page.keyboard.insertText(msg.text);
        break;
      case 'key': {
        const mapped = KEY_MAP[msg.key];
        if (mapped) {
          const mods = [];
          if (msg.ctrl) mods.push('Control');
          if (msg.alt) mods.push('Alt');
          if (msg.meta) mods.push('Meta');
          if (msg.shift && mapped !== 'Shift') mods.push('Shift');
          const combo = [...mods.filter((m) => m !== mapped), mapped].join('+');
          await this.page.keyboard.press(combo);
        } else if (typeof msg.key === 'string' && msg.key.length === 1) {
          if (msg.ctrl || msg.meta) {
            await this.page.keyboard.press(`${msg.meta ? 'Meta' : 'Control'}+${msg.key}`);
          } else {
            await this.page.keyboard.insertText(msg.key);
          }
        }
        break;
      }
      case 'back':
        await this.page.goBack().catch(() => {});
        break;
      case 'forward':
        await this.page.goForward().catch(() => {});
        break;
      case 'reload':
        await this.page.reload().catch(() => {});
        break;
      case 'navigate':
        if (msg.url) await this.navigate(String(msg.url));
        break;
      default:
        break;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    this.broadcast({ t: 'closed' });
    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {}
    }
    this.clients.clear();
    try {
      await this.context?.close();
    } catch {}
    if (this.ephemeralProfile) {
      await rm(this.profileDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

const sessions = new Map(); // flowId -> BrowserSession

export function getSession(flowId) {
  return sessions.get(flowId) || null;
}

/** 给某个登录 flow 起一个内置浏览器，并直接打开授权链接 */
export async function startBrowserForFlow(flow, { profile = 'fresh' } = {}) {
  if (sessions.has(flow.id)) return sessions.get(flow.id);
  const session = new BrowserSession({ profile });
  sessions.set(flow.id, session);
  flow.browser = {
    ready: false,
    error: null,
    session,
    close: async () => {
      sessions.delete(flow.id);
      await session.close();
    },
  };
  try {
    await session.launch(flow.loginUrl);
    flow.browser.ready = true;
  } catch (err) {
    flow.browser.error = err.message;
    sessions.delete(flow.id);
    await session.close().catch(() => {});
    throw err;
  }
  return session;
}

export async function closeAllBrowsers() {
  for (const [id, session] of sessions) {
    sessions.delete(id);
    await session.close().catch(() => {});
  }
}
