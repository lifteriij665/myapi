// myapi 控制台 —— 原生 ES module，无框架无构建。
// 约定：所有服务端交互都走 api()，渲染函数只读 STATE。
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let STATE = null;
let VIEW = 'overview';
let syncTimer = null;
let lastSync = 0;
let clockTimer = null;

function toast(message, kind = 'ok', ms = 4200) {
  const el = document.createElement('div');
  el.className = `toast ${kind === 'ok' ? '' : kind}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, ms);
}

async function api(path, { method = 'GET', body } = {}) {
  const resp = await fetch(`/admin/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  let data = {};
  try {
    data = await resp.json();
  } catch {}
  if (resp.status === 401 && !path.startsWith('/login')) {
    lock('登录状态过期了，重新输一次密码。');
    throw new Error('未登录');
  }
  if (!resp.ok || data.ok === false) throw new Error(data.error || `请求失败（HTTP ${resp.status}）`);
  return data;
}

async function copy(text, label = '已复制') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
    return;
  } catch {}
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    toast(label);
  } catch {
    toast('浏览器拦了复制操作，手动选中复制吧', 'warn');
  }
  ta.remove();
}

function ago(iso) {
  if (!iso) return '—';
  const d = Date.now() - new Date(iso).getTime();
  if (d < 60000) return '刚刚';
  if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
  return `${Math.floor(d / 86400000)} 天前`;
}

/** 从额度快照文本里取"用得最满"的那个比例，画通道条上的小刻度 */
function quotaRatio(text) {
  if (!text) return null;
  let worst = null;
  for (const m of String(text).matchAll(/(\d+)\s*\/\s*(\d+)/g)) {
    const used = Number(m[1]);
    const limit = Number(m[2]);
    if (!limit) continue;
    const r = Math.min(1, used / limit);
    if (worst === null || r > worst) worst = r;
  }
  return worst;
}

const POOL_LABEL = { any: '全部', free: '仅免费', paid: '付费优先' };
const POOL_FULL = { any: '全部模型', free: '仅免费模型', paid: '付费模型优先' };
const LAMP_BY_STATE = {
  ok: 'ok',
  model_locked: 'warn',
  rate_limited: 'warn',
  ip_capped: 'warn',
  country_blocked: 'warn',
  blocked: 'warn',
  network_error: 'warn',
  token_invalid: 'bad',
  banned: 'bad',
};

function lampFor(acct) {
  if (acct.enabled === false) return '';
  if (acct.status?.state) return LAMP_BY_STATE[acct.status.state] || '';
  if (acct.workerState?.alive === true) return 'ok';
  if (acct.workerState?.alive === false) return 'bad';
  return '';
}

// ─────────────────────────────────────────────── 解锁 / 会话
function lock(hint) {
  clearInterval(syncTimer);
  clearInterval(clockTimer);
  $('#shell').classList.add('hidden');
  $('#gate').classList.remove('hidden');
  if (hint) $('#gate-hint').textContent = hint;
  setTimeout(() => $('#gate-pass')?.focus(), 50);
}

async function unlock() {
  $('#gate').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  await sync();
  clearInterval(syncTimer);
  syncTimer = setInterval(() => sync(true), 20000);
  clearInterval(clockTimer);
  clockTimer = setInterval(paintSynced, 5000);
}

$('#gate-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = $('#gate-btn');
  btn.disabled = true;
  btn.textContent = '验证中…';
  try {
    await api('/login', { method: 'POST', body: { password: $('#gate-pass').value } });
    $('#gate-pass').value = '';
    await unlock();
  } catch (err) {
    toast(err.message, 'err');
    $('#gate-pass').select();
  } finally {
    btn.disabled = false;
    btn.textContent = '解锁控制台';
  }
});

$('#btn-logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' }).catch(() => {});
  lock('已退出。');
});

// ─────────────────────────────────────────────── 视图切换
const VIEW_TITLE = { overview: '概览', accounts: '账号池', keys: 'API Key', models: '模型', settings: '设置' };

function show(view) {
  VIEW = view;
  $$('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
  $$('.view').forEach((s) => s.classList.toggle('hidden', s.dataset.view !== view));
  $('#view-title').textContent = VIEW_TITLE[view] || view;
  if (location.hash.slice(1) !== view) history.replaceState(null, '', `#${view}`);
  window.scrollTo({ top: 0 });
}

$('#nav').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.nav-item');
  if (btn) show(btn.dataset.view);
});
window.addEventListener('hashchange', () => {
  const v = location.hash.slice(1);
  if (VIEW_TITLE[v] && v !== VIEW) show(v);
});

// ─────────────────────────────────────────────── 同步 + 渲染
$('#btn-sync').addEventListener('click', () => sync());

function paintSynced() {
  if (!lastSync) return;
  const s = Math.round((Date.now() - lastSync) / 1000);
  $('#synced').textContent = s < 8 ? '刚刚同步' : `${s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分钟`}前同步`;
}

async function sync(quiet = false) {
  const btn = $('#btn-sync');
  if (!quiet) {
    btn.disabled = true;
    btn.textContent = '刷新中…';
  }
  try {
    STATE = await api('/state');
    lastSync = Date.now();
    render();
    paintSynced();
  } catch (err) {
    if (!quiet) toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '刷新';
  }
}

function render() {
  const s = STATE;
  if (!s) return;

  $('#nc-accounts').textContent = s.accounts.length;
  $('#nc-keys').textContent = s.keys.length;
  $('#nc-models').textContent = s.models.filter((m) => m.enabled).length;
  $('#m-engine').textContent = s.workerVersion ? `worker ${s.workerVersion}` : '未知';
  $('#m-storage').textContent = s.storage.persistent ? '持久' : '临时';
  $('#m-browser').textContent = s.browser.available ? (s.browser.headless ? 'headless' : 'headful') : '关闭';

  const pill = $('#top-pill');
  // 存活数优先看我们自己探到的状态（引擎观测只是补充），没探过的按"可用"算
  const okCount = s.accounts.filter((a) => a.enabled && (!a.status || a.status.state === 'ok')).length;
  const lamp = s.accounts.length === 0 ? 'bad' : okCount > 0 ? 'ok' : 'warn';
  pill.querySelector('.lamp').className = `lamp ${lamp}`;
  pill.querySelector('span').textContent =
    s.accounts.length === 0 ? '号池为空' : `${okCount}/${s.accounts.length} 号可用`;

  renderNotice(s);
  renderOverview(s);
  renderAccounts(s);
  renderKeys(s);
  renderModels(s);
  renderSettings(s);
}

function renderNotice(s) {
  const box = $('#notice');
  if (!s.storage.persistent) {
    box.classList.remove('hidden');
    box.innerHTML =
      '<b>数据没有落到持久盘上。</b> Railway 服务里加一个 Volume 挂到 <code>/data</code>，否则每次重新部署账号池和 Key 都会清空。想先凑合用就去「设置 → 导出备份」留一份。';
    return;
  }
  box.classList.add('hidden');
}

function renderOverview(s) {
  const defaultKey = s.keys.find((k) => k.enabled) || s.keys[0];
  $('#v-base').textContent = s.apiBase;
  $('#v-key').textContent = defaultKey ? defaultKey.key : '还没有 Key';
  $('#v-anthropic').textContent = s.baseUrl;
  $('#v-keyinfo').innerHTML = defaultKey
    ? `默认用第一个可用 Key「${esc(defaultKey.name)}」 · 付费模型 ${
        defaultKey.allowPaid ? '<span class="tag paid">允许</span>' : '<span class="tag free">不允许</span>'
      }`
    : '去「API Key」新建一个。';

  // 通道条
  const wrap = $('#channels');
  const strips = s.accounts.map((a) => {
    const ratio = quotaRatio(a.status?.quota);
    const tier = a.pool === 'paid' ? '' : 'free';
    const label = a.email || a.name || a.id;
    const at = label.indexOf('@');
    const local = at > 0 ? label.slice(0, at) : label;
    const host = at > 0 ? label.slice(at) : '';
    const state = a.status?.verdict || (a.enabled ? '未检测' : '已停用');
    return `<div class="ch ${a.active ? 'is-active' : ''}" data-off="${a.enabled ? 0 : 1}" title="${esc(a.status?.detail || '还没检测过')}">
      <div class="ch-top"><i class="lamp ${lampFor(a)}"></i>${a.active ? '<span class="ch-now">当前</span>' : ''}<span class="ch-role">${POOL_LABEL[a.pool] || ''}</span></div>
      <div class="ch-name" title="${esc(label)}">${esc(local)}</div>
      <div class="ch-host">${esc(host || '—')}</div>
      <div class="ch-state" title="${esc(state)}">${esc(state)}</div>
      <div class="ch-meter ${tier}"><i style="width:${ratio === null ? 0 : Math.round(ratio * 100)}%"></i></div>
      <div class="ch-quota">${ratio === null ? '额度未知' : `额度已用 ${Math.round(ratio * 100)}%`}</div>
    </div>`;
  });
  wrap.innerHTML =
    strips.join('') +
    `<button class="ch ghost" data-act="add-account"><b>+</b><span>${
      s.accounts.length ? '再加一个号' : '添加账号'
    }</span></button>`;

  const freeCount = s.accounts.filter((a) => a.pool !== 'paid' && a.enabled).length;
  const calls = s.keys.reduce((n, k) => n + (k.requests || 0), 0);
  const activeAcct = s.accounts.find((a) => a.active);
  const mode = s.settings.autoSwitch === false ? '手动指定' : '用完才换';
  $('#pool-summary').textContent = s.accounts.length
    ? `${s.accounts.length} 号 · ${freeCount} 个能跑免费模型 · 累计 ${calls} 次调用 · 切换策略：${mode}${
        activeAcct ? ` · 当前 ${activeAcct.email || activeAcct.id}` : ''
      }`
    : '空池 —— 先加一个号';

  // 上手三步（真实顺序，做完了就打勾）
  const steps = [
    { done: s.accounts.length > 0, label: '把账号加进号池', hint: '授权链接 / 内置浏览器 / 粘贴 token 三种方式' },
    { done: s.keys.length > 0, label: '复制 Base URL 和 Key 到客户端', hint: '上面「复制完整配置」一键带走' },
    { done: Boolean(window.__selftestPassed), label: '跑一次自检确认链路通', hint: '右上「运行自检」' },
  ];
  $('#steps').innerHTML = steps
    .map(
      (st) => `<li class="${st.done ? 'done' : ''}">
      <i class="st"></i><span class="sl">${esc(st.label)}</span><span class="muted small">${esc(st.hint)}</span></li>`
    )
    .join('');
  const allDone = steps.every((st) => st.done);
  $('#steps').classList.toggle('hidden', allDone);
  $('#steps-eyebrow').classList.toggle('hidden', allDone);
}

function renderAccounts(s) {
  const tbody = $('#acct-table tbody');
  $('#acct-blank').classList.toggle('hidden', s.accounts.length > 0);
  $('#acct-table').classList.toggle('hidden', s.accounts.length === 0);
  tbody.innerHTML = s.accounts
    .map((a) => {
      const st = a.status;
      const tagClass = st ? (LAMP_BY_STATE[st.state] === 'ok' ? 'ok' : LAMP_BY_STATE[st.state] === 'bad' ? 'bad' : 'warn') : '';
      const label = st ? st.verdict : a.workerState ? `引擎观测 ${a.workerState.state}` : '未检测';
      return `<tr data-id="${a.id}" class="${a.enabled ? '' : 'is-off'}">
      <td><div class="cell-main"><b>${esc(a.email || a.name || '未知邮箱')}</b>${a.active ? ' <span class="tag now">当前</span>' : ''}
        <span class="cell-sub">${esc(a.source)} · ${ago(a.createdAt)}加入</span></div></td>
      <td><select class="inline js-pool" title="${esc(POOL_FULL[a.pool] || '')}">
        ${Object.entries(POOL_FULL)
          .map(([v, t]) => `<option value="${v}"${a.pool === v ? ' selected' : ''}>${t}</option>`)
          .join('')}
      </select></td>
      <td><span class="tag ${tagClass}" title="${esc(st?.detail || '点检测做一次 0 消耗探活')}">${esc(label)}</span></td>
      <td class="cell-mono">${esc(st?.quota || '—')}</td>
      <td class="cell-mono">${esc(a.tokenMasked)}</td>
      <td class="acts">
        <button class="btn tiny js-check">检测</button>
        <button class="btn tiny js-use"${a.active || !a.enabled ? ' disabled' : ''}>设为当前</button>
        <button class="btn tiny js-toggle">${a.enabled ? '停用' : '启用'}</button>
        <button class="btn tiny js-token">复制 token</button>
        <button class="btn tiny danger js-del">删除</button>
      </td></tr>`;
    })
    .join('');

  $$('#acct-table tbody tr').forEach((tr) => {
    const id = tr.dataset.id;
    const acct = s.accounts.find((a) => a.id === id);
    $('.js-pool', tr).addEventListener('change', async (ev) => {
      await api(`/accounts/${id}`, { method: 'PATCH', body: { pool: ev.target.value } });
      toast(`${acct.email || id} 的用途改成「${POOL_FULL[ev.target.value]}」`);
      sync(true);
    });
    $('.js-check', tr).addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      btn.innerHTML = '<span class="spin"></span>';
      try {
        const r = await api(`/accounts/${id}/check`, { method: 'POST' });
        toast(`${acct.email || id}：${r.status.verdict} —— ${r.status.detail}`, r.status.state === 'ok' ? 'ok' : 'warn', 7000);
      } catch (err) {
        toast(err.message, 'err');
      }
      sync(true);
    });
    $('.js-toggle', tr).addEventListener('click', async () => {
      await api(`/accounts/${id}`, { method: 'PATCH', body: { enabled: !acct.enabled } });
      sync(true);
    });
    $('.js-use', tr).addEventListener('click', async () => {
      try {
        await api(`/accounts/${id}/activate`, { method: 'POST' });
        toast(`之后的请求都走 ${acct.email || id}`);
        sync(true);
      } catch (err) {
        toast(err.message, 'err');
      }
    });
    $('.js-token', tr).addEventListener('click', async () => {
      const r = await api(`/accounts/${id}`);
      copy(r.token, 'token 已复制');
    });
    $('.js-del', tr).addEventListener('click', async () => {
      if (!confirm(`把 ${acct.email || id} 从号池里删掉？用它的请求会立刻转到别的号。`)) return;
      await api(`/accounts/${id}`, { method: 'DELETE' });
      toast('已删除');
      sync();
    });
  });
}

function renderKeys(s) {
  $('#key-table tbody').innerHTML = s.keys
    .map(
      (k) => `<tr data-id="${k.id}" class="${k.enabled ? '' : 'is-off'}">
      <td><div class="cell-main"><b>${esc(k.name)}</b><span class="cell-sub">${ago(k.createdAt)}创建</span></div></td>
      <td class="cell-mono">${esc(k.key.slice(0, 14))}…</td>
      <td><input type="checkbox" class="switch paid js-paid"${k.allowPaid ? ' checked' : ''} title="允许付费模型"></td>
      <td><input type="checkbox" class="switch js-enabled"${k.enabled ? ' checked' : ''} title="启用"></td>
      <td class="cell-mono">${k.requests || 0}</td>
      <td class="cell-mono">${ago(k.lastUsedAt)}</td>
      <td class="acts">
        <button class="btn tiny js-copy">复制</button>
        <button class="btn tiny js-rename">改名</button>
        <button class="btn tiny danger js-del">删除</button>
      </td></tr>`
    )
    .join('');

  $$('#key-table tbody tr').forEach((tr) => {
    const id = tr.dataset.id;
    const k = s.keys.find((x) => x.id === id);
    $('.js-copy', tr).addEventListener('click', () => copy(k.key, `已复制「${k.name}」`));
    $('.js-paid', tr).addEventListener('change', async (ev) => {
      await api(`/keys/${id}`, { method: 'PATCH', body: { allowPaid: ev.target.checked } });
      toast(ev.target.checked ? `「${k.name}」现在可以用付费模型（会烧 Premium 额度）` : `「${k.name}」只能用免费模型`);
      sync(true);
    });
    $('.js-enabled', tr).addEventListener('change', async (ev) => {
      await api(`/keys/${id}`, { method: 'PATCH', body: { enabled: ev.target.checked } });
      sync(true);
    });
    $('.js-rename', tr).addEventListener('click', async () => {
      const name = prompt('新名称', k.name);
      if (name === null) return;
      await api(`/keys/${id}`, { method: 'PATCH', body: { name } });
      sync(true);
    });
    $('.js-del', tr).addEventListener('click', async () => {
      if (!confirm(`删除 Key「${k.name}」？正在用它的客户端会立刻收到 401。`)) return;
      try {
        await api(`/keys/${id}`, { method: 'DELETE' });
        toast('已删除');
        sync();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  });
}

let modelFilter = 'all';

function renderModels(s) {
  const q = ($('#model-search').value || '').trim().toLowerCase();
  const list = s.models.filter(
    (m) => (modelFilter === 'all' || m.tier === modelFilter) && (!q || m.id.toLowerCase().includes(q))
  );
  $('#model-meta').textContent = `免费 ${s.modelStats.free} · 付费 ${s.modelStats.paid} · 来源 ${s.modelStats.source}`;
  $('#model-table tbody').innerHTML = list.length
    ? list
        .map(
          (m) => `<tr data-id="${esc(m.id)}">
      <td class="cell-mono" style="color:var(--text)">${esc(m.id)}</td>
      <td><select class="inline js-tier">
        <option value="free"${m.tier === 'free' ? ' selected' : ''}>免费</option>
        <option value="paid"${m.tier === 'paid' ? ' selected' : ''}>付费</option>
      </select>${m.overridden ? ' <span class="tag">手动</span>' : ''}</td>
      <td><span class="tag ${m.tier}">${esc(m.pool)}</span></td>
      <td class="muted small">${esc(m.note)}</td>
      <td class="right"><input type="checkbox" class="switch js-on"${m.enabled ? ' checked' : ''}></td>
      </tr>`
        )
        .join('')
    : '<tr><td colspan="5" class="muted" style="padding:26px;text-align:center">没有匹配的模型</td></tr>';

  $$('#model-table tbody tr[data-id]').forEach((tr) => {
    const id = tr.dataset.id;
    $('.js-tier', tr).addEventListener('change', async (ev) => {
      await api('/models/tier', { method: 'POST', body: { id, tier: ev.target.value } });
      toast(`${id} 归类为${ev.target.value === 'paid' ? '付费' : '免费'}`);
      sync(true);
    });
    $('.js-on', tr).addEventListener('change', async (ev) => {
      const off = new Set(STATE.settings.disabledModels || []);
      ev.target.checked ? off.delete(id) : off.add(id);
      await api('/settings', { method: 'PATCH', body: { disabledModels: [...off] } });
      toast(ev.target.checked ? `${id} 已对外提供` : `${id} 已下架`);
      sync(true);
    });
  });
}

function renderSettings(s) {
  const auto = s.settings.autoSwitch !== false;
  $('#set-autoswitch').checked = auto;
  const sel = $('#set-active');
  const cur = s.settings.activeAccountId || '';
  sel.innerHTML =
    '<option value="">（自动挑一个可用的）</option>' +
    s.accounts
      .map(
        (a) =>
          `<option value="${a.id}"${a.id === cur ? ' selected' : ''}${a.enabled ? '' : ' disabled'}>${esc(
            a.email || a.name || a.id
          )}${a.enabled ? '' : '（已停用）'}</option>`
      )
      .join('');
  const activeAcct = s.accounts.find((a) => a.id === cur);
  $('#rotation-note').textContent = auto
    ? activeAcct
      ? `现在钉在 ${activeAcct.email || activeAcct.id} 上；它撞额度或者掉线了才会顺延到下一个号。`
      : '还没钉住任何号：下一次请求会挑第一个可用的，之后就一直用它，直到它失败。'
    : activeAcct
      ? `只用 ${activeAcct.email || activeAcct.id}。它不可用时请求直接报错，不会偷偷换号。`
      : '手动模式下必须指定一个账号，否则所有请求都会返回 503。';

  $('#set-allowpaid').checked = Boolean(s.settings.allowPaidDefault);
  $('#s-datadir').textContent = s.storage.dir;
  $('#s-persist').textContent = s.storage.persistent ? '持久' : '临时（重新部署会清空）';
  $('#s-persist-note').textContent = s.storage.volume
    ? `Railway Volume 已挂载在 ${s.storage.volume}。`
    : s.storage.onRailway
      ? '没检测到 Railway Volume。加一个挂到 /data，账号池才能跨部署留下来。'
      : '本地运行，数据就在上面这个目录里。';
  $('#s-browser').textContent = s.browser.available
    ? `可用 · ${s.browser.headless ? 'headless' : 'headful (Xvfb)'}`
    : `关闭 · ${s.browser.reason || s.browser.loadError || '未安装 Chromium'}`;
  $('#s-proxy').textContent = s.browser.proxy || '直连';
  const cred = s.credentials || {};
  const parts = [];
  if (cred.env) parts.push('环境变量 ADMIN_PASSWORD');
  if (cred.console) parts.push(cred.consoleGenerated ? '首次启动自动生成的临时密码（建议尽快改掉）' : '控制台里设置的密码');
  $('#s-creds').textContent = parts.length ? `${parts.length} 种：${parts.join(' + ')}` : '（没有设置密码）';
}

// ─────────────────────────────────────────────── 概览上的动作
$('#channels').addEventListener('click', (ev) => {
  if (ev.target.closest('[data-act="add-account"]')) openAddAccount();
});
$('#acct-blank').addEventListener('click', (ev) => {
  if (ev.target.closest('[data-act="add-account"]')) openAddAccount();
});
$$('[data-copy]').forEach((btn) =>
  btn.addEventListener('click', () => {
    const text = $(btn.dataset.copy).textContent.trim();
    copy(text);
  })
);

$('#btn-copy-all').addEventListener('click', () => {
  const k = STATE.keys.find((x) => x.enabled) || STATE.keys[0];
  const usable = STATE.models.filter((m) => m.enabled && (k?.allowPaid || m.tier === 'free')).map((m) => m.id);
  copy(
    [
      `Base URL (OpenAI): ${STATE.apiBase}`,
      `Base URL (Anthropic): ${STATE.baseUrl}`,
      `API Key: ${k ? k.key : '(还没有 Key)'}`,
      `可用模型: ${usable.join(', ') || '(无)'}`,
    ].join('\n'),
    '配置已复制'
  );
});

$('#btn-selftest').addEventListener('click', async () => {
  const btn = $('#btn-selftest');
  const out = $('#selftest-out');
  btn.disabled = true;
  out.innerHTML = '<span class="spin"></span> 正在用免费模型跑一次真实请求…';
  try {
    const r = await api('/selftest', { method: 'POST', body: {} });
    if (r.ok) {
      window.__selftestPassed = true;
      out.innerHTML = `<span class="tag ok">通过</span> ${r.ms}ms · ${esc(r.model)} 回复：<b>${esc(r.reply.slice(0, 80))}</b>`;
      renderOverview(STATE);
    } else {
      out.innerHTML = `<span class="tag bad">失败 HTTP ${r.status}</span> ${esc((r.raw || '').slice(0, 200))}`;
    }
  } catch (err) {
    out.innerHTML = `<span class="tag bad">失败</span> ${esc(err.message)}`;
  } finally {
    btn.disabled = false;
  }
});

$('#btn-check-all').addEventListener('click', async () => {
  const btn = $('#btn-check-all');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> 检测中';
  try {
    const r = await api('/accounts/check-all', { method: 'POST' });
    const ok = r.results.filter((x) => x.state === 'ok').length;
    toast(`检测完成：${ok}/${r.results.length} 个号存活`, ok === r.results.length ? 'ok' : 'warn');
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '全部检测';
    sync();
  }
});

$('#model-filter').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button');
  if (!btn) return;
  modelFilter = btn.dataset.filter;
  $$('#model-filter button').forEach((b) => b.classList.toggle('is-on', b === btn));
  renderModels(STATE);
});
$('#model-search').addEventListener('input', () => renderModels(STATE));
$('#btn-model-refresh').addEventListener('click', async () => {
  const btn = $('#btn-model-refresh');
  btn.disabled = true;
  try {
    await api('/models/refresh', { method: 'POST' });
    toast('模型表已刷新');
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    sync();
  }
});
$('#set-allowpaid').addEventListener('change', async (ev) => {
  await api('/settings', { method: 'PATCH', body: { allowPaidDefault: ev.target.checked } });
  toast('已保存');
});
$('#set-autoswitch').addEventListener('change', async (ev) => {
  await api('/settings', { method: 'PATCH', body: { autoSwitch: ev.target.checked } });
  toast(ev.target.checked ? '当前账号失败时会自动顺延到下一个号' : '已关闭自动切换：只用指定的那个号');
  sync(true);
});
$('#set-active').addEventListener('change', async (ev) => {
  await api('/settings', { method: 'PATCH', body: { activeAccountId: ev.target.value || null } });
  toast(ev.target.value ? '已指定当前账号' : '已放开指定，下一次请求自己挑');
  sync(true);
});
$('#btn-export').addEventListener('click', async () => {
  const btn = $('#btn-export');
  btn.disabled = true;
  try {
    // 走 POST：GET 的备份接口可以被恶意页面用顶层跳转触发，而这份备份里是明文 token
    const data = await api('/export', { method: 'POST' });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `myapi-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('备份已下载 —— 里面是明文 token，别乱放');
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

// ─────────────────────────────────────────────── 对话框
function openDialog(title, html, { width = 560, onClose } = {}) {
  const dlg = document.createElement('dialog');
  dlg.style.setProperty('--dlg-w', `${width}px`);
  dlg.innerHTML = `<div class="dlg-head"><b>${esc(title)}</b><span class="grow"></span>
    <button class="btn quiet tiny js-x" type="button">关闭</button></div>
    <div class="dlg-body">${html}</div>`;
  $('#dialogs').appendChild(dlg);
  dlg.addEventListener('close', () => {
    onClose?.();
    dlg.remove();
  });
  $('.js-x', dlg).addEventListener('click', () => dlg.close());
  dlg.showModal();
  return { root: dlg, close: () => dlg.close() };
}

$('#btn-add-key').addEventListener('click', () => {
  const d = openDialog(
    '新建 API Key',
    `<label class="field"><span class="lbl">名称</span>
      <input type="text" id="nk-name" placeholder="给谁用的，比如 Cherry Studio"></label>
    <label class="row-toggle"><span>允许使用付费(Premium)模型<br><small class="muted">号池每天一共 6 次 Premium session，不开就只给免费模型。</small></span>
      <input type="checkbox" class="switch paid" id="nk-paid"${STATE.settings.allowPaidDefault ? ' checked' : ''}></label>
    <div class="dlg-foot"><button class="btn js-cancel" type="button">取消</button>
      <button class="btn primary" id="nk-go" type="button">生成并复制</button></div>`,
    { width: 520 }
  );
  $('.js-cancel', d.root).addEventListener('click', d.close);
  $('#nk-go', d.root).addEventListener('click', async () => {
    try {
      const r = await api('/keys', {
        method: 'POST',
        body: { name: $('#nk-name', d.root).value, allowPaid: $('#nk-paid', d.root).checked },
      });
      d.close();
      await sync();
      copy(r.key.key, '新 Key 已生成并复制');
    } catch (err) {
      toast(err.message, 'err');
    }
  });
});

$('#btn-passwd').addEventListener('click', () => {
  const d = openDialog(
    '修改管理密码',
    `<label class="field"><span class="lbl">当前密码</span>
      <input type="password" id="pw-cur" autocomplete="current-password"></label>
    <label class="field"><span class="lbl">新密码（至少 10 位，别用纯数字）</span>
      <input type="password" id="pw-next" autocomplete="new-password"></label>
    <p class="muted small">保存后所有设备上的登录状态都会失效（这台会自动续上）。环境变量 ADMIN_PASSWORD 里那个密码依然有效 —— 想只留新密码，把那个变量删掉再部署。</p>
    <div class="dlg-foot"><button class="btn js-cancel" type="button">取消</button>
      <button class="btn primary" id="pw-go" type="button">保存</button></div>`,
    { width: 460 }
  );
  $('.js-cancel', d.root).addEventListener('click', d.close);
  $('#pw-go', d.root).addEventListener('click', async () => {
    const btn = $('#pw-go', d.root);
    btn.disabled = true;
    try {
      const r = await api('/password', {
        method: 'POST',
        body: { current: $('#pw-cur', d.root).value, next: $('#pw-next', d.root).value },
      });
      toast(r.note || '密码已更新');
      d.close();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });
});

$('#btn-logout-all').addEventListener('click', async () => {
  if (!confirm('把所有设备上的登录状态都作废？（这台浏览器会自动续上）')) return;
  try {
    const r = await api('/logout-all', { method: 'POST' });
    toast(r.note || '已登出所有设备');
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#btn-import').addEventListener('click', () => {
  const d = openDialog(
    '导入备份',
    `<label class="field"><span class="lbl">粘贴导出的 JSON</span>
      <textarea id="imp-text" placeholder='{"accounts":[…],"keys":[…]}' style="min-height:160px"></textarea></label>
    <label class="row-toggle"><span>先清空现有账号和 Key</span><input type="checkbox" class="switch" id="imp-replace"></label>
    <div class="dlg-foot"><button class="btn js-cancel" type="button">取消</button>
      <button class="btn primary" id="imp-go" type="button">导入</button></div>`,
    { width: 600 }
  );
  $('.js-cancel', d.root).addEventListener('click', d.close);
  $('#imp-go', d.root).addEventListener('click', async () => {
    try {
      const payload = JSON.parse($('#imp-text', d.root).value);
      const r = await api('/import', { method: 'POST', body: { payload, replace: $('#imp-replace', d.root).checked } });
      toast(`导入完成：账号 +${r.accounts}，Key +${r.keys}`);
      d.close();
      sync();
    } catch (err) {
      toast(`导入失败：${err.message}`, 'err');
    }
  });
});

// ─────────────────────────────────────────────── 添加账号
const poolSelect = (id) => `<label class="field" style="max-width:190px;margin:0">
  <span class="lbl">用途</span>
  <select id="${id}">${Object.entries(POOL_FULL).map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>
</label>`;

function openAddAccount() {
  const br = STATE.browser;
  const d = openDialog(
    '添加账号',
    `<div class="methods" id="methods">
      <button class="method is-on" data-m="link" type="button"><b>授权链接</b>
        <small>在你自己的浏览器里完成登录，服务器只负责收 token。最稳，推荐。</small></button>
      <button class="method" data-m="browser" type="button"${br.available ? '' : ' disabled'}><b>内置浏览器</b>
        <small>${br.available ? '服务器开一个 Chromium，画面推到这里，你在这儿点和打字。' : `当前不可用：${esc(br.reason || br.loadError || '未安装 Chromium')}`}</small></button>
      <button class="method" data-m="paste" type="button"><b>粘贴 token</b>
        <small>已经有 authToken（比如从别处迁移）就直接贴进来。</small></button>
    </div>

    <div data-p="link">
      <p class="muted small">和官方 CLI 走同一条链路：这里申请一个一次性登录链接，你在自己浏览器里登录 Google 或 GitHub，服务器轮询到 token 后自动入池。</p>
      <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
        ${poolSelect('link-pool')}
        <button class="btn primary" id="link-start" type="button">生成授权链接</button>
      </div>
      <div id="link-area" class="hidden" style="margin-top:14px">
        <label class="field"><span class="lbl">一次性链接 · 5 分钟内有效</span>
          <input type="text" id="link-url" readonly></label>
        <div class="btnrow" style="margin-top:0">
          <button class="btn primary" id="link-open" type="button">打开登录页</button>
          <button class="btn" id="link-copy" type="button">复制链接</button>
        </div>
        <div class="flowstate" id="link-state"></div>
        <div class="flowlog hidden" id="link-log"></div>
      </div>
    </div>

    <div data-p="browser" class="hidden">
      ${
        br.available
          ? `<p class="muted small">画面来自服务器上的 patchright Chromium（${br.headless ? 'headless' : 'headful + Xvfb，指纹更接近真机'}）。鼠标键盘会转发过去；密码这类长文本用下面的输入框发更省事。</p>
      <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
        ${poolSelect('br-pool')}
        <label class="field" style="max-width:200px;margin:0"><span class="lbl">浏览器身份</span>
          <select id="br-profile">
            <option value="fresh">全新指纹（每个号一套，推荐）</option>
            <option value="shared">复用上次会话（留 cookie）</option>
          </select></label>
        <button class="btn primary" id="br-start" type="button">启动并打开登录页</button>
      </div>
      <div class="viewer hidden" id="br-viewer">
        <div class="viewer-bar">
          <button class="btn tiny" data-nav="back" type="button" title="后退">←</button>
          <button class="btn tiny" data-nav="forward" type="button" title="前进">→</button>
          <button class="btn tiny" data-nav="reload" type="button" title="刷新">↻</button>
          <input type="text" id="br-url" placeholder="https://" class="grow">
          <button class="btn tiny" id="br-go" type="button">前往</button>
          <span class="pill"><i class="lamp" id="br-lamp"></i><span id="br-conn">未连接</span></span>
        </div>
        <div class="screen" id="br-screen" tabindex="0">
          <img id="br-img" alt="服务器浏览器画面">
          <div class="glass" id="br-glass"></div>
          <div class="veil" id="br-veil"><span><span class="spin"></span> 正在启动 Chromium，首次大约 5~15 秒…</span></div>
        </div>
        <div class="viewer-bar">
          <input type="text" id="br-text" placeholder="要输入的文字 —— 先在画面里点一下输入框，再发送" class="grow">
          <button class="btn tiny" id="br-send" type="button">发送文字</button>
          <button class="btn tiny" id="br-enter" type="button">回车</button>
        </div>
      </div>
      <div class="flowstate" id="br-state"></div>
      <div class="flowlog hidden" id="br-log"></div>`
          : `<p class="muted small">内置浏览器没启用，用「授权链接」加号效果完全一样 —— token 走的是同一条链路。</p>`
      }
    </div>

    <div data-p="paste" class="hidden">
      <p class="muted small">一行一个 authToken，可以一次贴多个。</p>
      <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">${poolSelect('mn-pool')}</div>
      <label class="field" style="margin-top:12px"><span class="lbl">authToken</span>
        <textarea id="mn-token" placeholder="每行一个"></textarea></label>
      <button class="btn primary" id="mn-go" type="button">加入号池</button>
    </div>`,
    { width: 1040, onClose: () => teardown() }
  );

  const R = d.root;
  let flow = null;
  let flowTimer = null;
  let ws = null;

  function teardown() {
    clearInterval(flowTimer);
    try {
      ws?.close();
    } catch {}
    ws = null;
    if (flow && flow.state === 'pending') api(`/login-flow/${flow.id}/cancel`, { method: 'POST' }).catch(() => {});
  }

  $('#methods', R).addEventListener('click', (ev) => {
    const btn = ev.target.closest('.method');
    if (!btn || btn.disabled) return;
    $$('.method', R).forEach((b) => b.classList.toggle('is-on', b === btn));
    $$('[data-p]', R).forEach((p) => p.classList.toggle('hidden', p.dataset.p !== btn.dataset.m));
  });

  const STATE_TEXT = {
    pending: '等你在登录页完成授权…',
    done: '登录成功，账号已入池',
    error: '没成功',
    timeout: '等太久了，重新生成链接吧',
    cancelled: '已取消',
  };

  function renderFlow() {
    if (!flow) return;
    const lampCls = flow.state === 'pending' ? 'busy' : flow.state === 'done' ? 'ok' : 'bad';
    const text = `${STATE_TEXT[flow.state] || flow.state}${flow.error ? ` —— ${flow.error}` : ''}`;
    for (const [sid, lid] of [['#link-state', '#link-log'], ['#br-state', '#br-log']]) {
      const sEl = $(sid, R);
      const lEl = $(lid, R);
      if (sEl) sEl.innerHTML = `<i class="lamp ${lampCls}"></i><span>${esc(text)}</span>`;
      if (lEl && flow.log?.length) {
        lEl.classList.remove('hidden');
        lEl.innerHTML = flow.log.map((l) => `<div>${esc(l.message)}</div>`).join('');
        lEl.scrollTop = lEl.scrollHeight;
      }
    }
    if (flow.state === 'done') {
      clearInterval(flowTimer);
      toast(`${flow.account?.email || '账号'} 已入池`, 'ok', 5000);
      sync();
      setTimeout(() => d.close(), 1600);
    } else if (['error', 'timeout', 'cancelled'].includes(flow.state)) {
      clearInterval(flowTimer);
    }
  }

  function startPolling() {
    clearInterval(flowTimer);
    flowTimer = setInterval(async () => {
      try {
        flow = (await api(`/login-flow/${flow.id}`)).flow;
        renderFlow();
      } catch {
        clearInterval(flowTimer);
      }
    }, 2500);
  }

  // ── 方式一：授权链接 ──
  $('#link-start', R).addEventListener('click', async () => {
    const btn = $('#link-start', R);
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> 申请中';
    try {
      flow = (await api('/login-flow', { method: 'POST', body: { mode: 'link', pool: $('#link-pool', R).value } })).flow;
      $('#link-area', R).classList.remove('hidden');
      $('#link-url', R).value = flow.loginUrl;
      renderFlow();
      startPolling();
      window.open(flow.loginUrl, '_blank', 'noopener');
    } catch (err) {
      toast(err.message, 'err', 7000);
    } finally {
      btn.disabled = false;
      btn.textContent = '重新生成链接';
    }
  });
  $('#link-open', R).addEventListener('click', () => flow && window.open(flow.loginUrl, '_blank', 'noopener'));
  $('#link-copy', R).addEventListener('click', () => flow && copy(flow.loginUrl, '链接已复制'));

  // ── 方式三：粘贴 token ──
  $('#mn-go', R).addEventListener('click', async () => {
    try {
      const r = await api('/accounts', {
        method: 'POST',
        body: { token: $('#mn-token', R).value, pool: $('#mn-pool', R).value },
      });
      toast(`已加入 ${r.added} 个号`);
      d.close();
      sync();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  // ── 方式二：内置浏览器 ──
  const img = $('#br-img', R);
  const glass = $('#br-glass', R);
  const screen = $('#br-screen', R);
  const sendWs = (msg) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  };

  // 鼠标位置 → 画面内 0~1 归一化坐标（img 是 contain，要减掉黑边）
  function norm(ev) {
    const r = img.getBoundingClientRect();
    const nw = img.naturalWidth || 1440;
    const nh = img.naturalHeight || 900;
    const scale = Math.min(r.width / nw, r.height / nh);
    const dw = nw * scale;
    const dh = nh * scale;
    const clamp = (v) => Math.max(0, Math.min(1, v));
    return { x: clamp((ev.clientX - (r.left + (r.width - dw) / 2)) / dw), y: clamp((ev.clientY - (r.top + (r.height - dh) / 2)) / dh) };
  }

  function conn(state, text) {
    const lamp = $('#br-lamp', R);
    if (lamp) lamp.className = `lamp ${state}`;
    const label = $('#br-conn', R);
    if (label) label.textContent = text;
  }

  function connect(flowId) {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/admin/ws/browser?flow=${encodeURIComponent(flowId)}`);
    ws.onopen = () => conn('busy', '等首帧');
    ws.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.t === 'frame') {
        img.src = `data:image/jpeg;base64,${m.data}`;
        $('#br-veil', R).classList.add('hidden');
        conn('ok', '已连接');
      } else if (m.t === 'status') {
        const box = $('#br-url', R);
        if (document.activeElement !== box) box.value = m.url || '';
      } else if (m.t === 'closed') {
        conn('bad', '已断开');
        const veil = $('#br-veil', R);
        veil.classList.remove('hidden');
        veil.innerHTML = '<span>浏览器已关闭。重新点「启动并打开登录页」可以再开一个。</span>';
      } else if (m.t === 'error') {
        toast(m.message, 'warn', 6000);
      }
    };
    ws.onclose = () => {
      ws = null;
      conn('', '未连接');
    };
  }

  if (screen) {
    $('#br-start', R).addEventListener('click', async () => {
      const btn = $('#br-start', R);
      btn.disabled = true;
      btn.innerHTML = '<span class="spin"></span> 启动中';
      $('#br-viewer', R).classList.remove('hidden');
      try {
        flow = (
          await api('/login-flow', {
            method: 'POST',
            body: { mode: 'browser', pool: $('#br-pool', R).value, profile: $('#br-profile', R).value },
          })
        ).flow;
        renderFlow();
        startPolling();
        connect(flow.id);
        $('#br-viewer', R).scrollIntoView({ block: 'nearest' });
        screen.focus();
      } catch (err) {
        toast(err.message, 'err', 9000);
        $('#br-veil', R).innerHTML = `<span>${esc(err.message)}</span>`;
      } finally {
        btn.disabled = false;
        btn.textContent = '重新启动';
      }
    });

    let lastMove = 0;
    glass.addEventListener('mousemove', (ev) => {
      if (Date.now() - lastMove < 45) return;
      lastMove = Date.now();
      sendWs({ t: 'move', ...norm(ev) });
    });
    glass.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      screen.focus();
      sendWs({ t: 'down', ...norm(ev), button: ev.button, clickCount: ev.detail || 1 });
    });
    glass.addEventListener('mouseup', (ev) => {
      ev.preventDefault();
      sendWs({ t: 'up', ...norm(ev), button: ev.button, clickCount: ev.detail || 1 });
    });
    glass.addEventListener('contextmenu', (ev) => ev.preventDefault());
    glass.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      sendWs({ t: 'wheel', ...norm(ev), dx: ev.deltaX, dy: ev.deltaY });
    }, { passive: false });
    screen.addEventListener('keydown', (ev) => {
      if (ev.key === 'F5' || (ev.ctrlKey && ev.key === 'r') || ev.key === 'Escape') return;
      ev.preventDefault();
      sendWs({ t: 'key', key: ev.key, ctrl: ev.ctrlKey, alt: ev.altKey, meta: ev.metaKey, shift: ev.shiftKey });
    });
    screen.addEventListener('paste', (ev) => {
      const text = ev.clipboardData?.getData('text');
      if (!text) return;
      ev.preventDefault();
      sendWs({ t: 'text', text });
    });
    $$('[data-nav]', R).forEach((b) => b.addEventListener('click', () => sendWs({ t: b.dataset.nav })));
    $('#br-go', R).addEventListener('click', () => sendWs({ t: 'navigate', url: $('#br-url', R).value }));
    $('#br-url', R).addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') sendWs({ t: 'navigate', url: ev.target.value });
    });
    $('#br-send', R).addEventListener('click', () => {
      const box = $('#br-text', R);
      if (!box.value) return;
      sendWs({ t: 'text', text: box.value });
      box.value = '';
    });
    $('#br-text', R).addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') $('#br-send', R).click();
    });
    $('#br-enter', R).addEventListener('click', () => sendWs({ t: 'key', key: 'Enter' }));
  }
}

// ─────────────────────────────────────────────── 启动
$('#btn-add-account').addEventListener('click', () => openAddAccount());

(async () => {
  // 首屏骨架，避免白板
  $('#channels').innerHTML = '<div class="ch skel"></div><div class="ch skel"></div><div class="ch skel"></div>';
  const hash = location.hash.slice(1);
  if (VIEW_TITLE[hash]) show(hash);
  try {
    const s = await api('/session');
    $('#gate-ver').textContent = `myapi v${s.version}`;
    if (s.authed) return unlock();
    lock(
      s.hasPassword
        ? '输入管理员密码进入控制台。'
        : '服务端还没设 ADMIN_PASSWORD —— 在 Railway 变量里加上，重新部署后再来。'
    );
  } catch {
    lock('连不上服务端，稍后重试。');
  }
})();
