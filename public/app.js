// myapi 控制台前端：无框架、无构建，直接 ES module。
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let STATE = null;
let pollTimer = null;

function toast(message, kind = 'ok', ms = 3600) {
  const box = document.createElement('div');
  box.className = `toast ${kind === 'ok' ? '' : kind}`;
  box.textContent = message;
  $('#toasts').appendChild(box);
  setTimeout(() => {
    box.style.opacity = '0';
    setTimeout(() => box.remove(), 200);
  }, ms);
}

async function api(path, { method = 'GET', body } = {}) {
  const resp = await fetch(`/admin/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  let data = null;
  try {
    data = await resp.json();
  } catch {
    data = {};
  }
  if (resp.status === 401 && !path.startsWith('/login')) {
    showLock('会话已过期，请重新解锁');
    throw new Error('未登录');
  }
  if (!resp.ok || data.ok === false) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

async function copyText(text, label = '已复制') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    // 非 https 或旧浏览器：退回到 textarea + execCommand
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast(label);
    } catch {
      toast('复制失败，请手动选中复制', 'err');
    }
    ta.remove();
  }
}

// ---------------------------------------------------------------- 锁屏
function showLock(message) {
  clearInterval(pollTimer);
  $('#app').classList.add('hidden');
  $('#lock').classList.remove('hidden');
  if (message) $('#lock-hint').textContent = message;
  setTimeout(() => $('#lock-pass')?.focus(), 40);
}

async function enterApp() {
  $('#lock').classList.add('hidden');
  $('#app').classList.remove('hidden');
  await refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => refresh(true), 20000);
}

$('#lock-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = $('#lock-btn');
  btn.disabled = true;
  btn.textContent = '验证中…';
  try {
    await api('/login', { method: 'POST', body: { password: $('#lock-pass').value } });
    $('#lock-pass').value = '';
    await enterApp();
  } catch (err) {
    toast(err.message, 'err');
    $('#lock-pass').select();
  } finally {
    btn.disabled = false;
    btn.textContent = '解锁';
  }
});

$('#btn-logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' }).catch(() => {});
  showLock('已退出');
});

$('#btn-refresh').addEventListener('click', () => refresh());

// ---------------------------------------------------------------- 渲染
async function refresh(quiet = false) {
  try {
    STATE = await api('/state');
    render();
  } catch (err) {
    if (!quiet) toast(`加载失败：${err.message}`, 'err');
  }
}

function render() {
  const s = STATE;
  if (!s) return;
  $('#ver').textContent = `v${s.version}${s.workerVersion ? ` · 引擎 ${s.workerVersion}` : ''}`;
  const st = $('#storage-badge');
  st.textContent = s.storage.persistent ? '数据已持久化' : '数据非持久';
  st.className = `badge ${s.storage.persistent ? 'ok' : 'warn'}`;

  const hb = $('#health-badge');
  const alive = s.health?.alive ?? 0;
  hb.textContent = `账号 ${alive}/${s.accounts.length} 可用`;
  hb.className = `badge ${s.accounts.length === 0 ? 'bad' : alive > 0 ? 'ok' : 'warn'}`;

  const banner = $('#banner');
  if (!s.storage.persistent) {
    banner.classList.remove('hidden');
    banner.innerHTML =
      '⚠️ 当前没有挂载持久卷，<b>重新部署会清空账号池和 API key</b>。请在 Railway 服务里加一个 Volume 挂到 <code>/data</code>，或者用「导出备份」留一份。';
  } else if (!s.accounts.length) {
    banner.classList.remove('hidden');
    banner.innerHTML = '账号池是空的 —— 点「+ 添加账号」，用「授权链接」方式几十秒就能加一个号。';
  } else {
    banner.classList.add('hidden');
  }

  const defaultKey = s.keys.find((k) => k.enabled) || s.keys[0];
  $('#v-base').textContent = s.apiBase;
  $('#v-key').textContent = defaultKey ? defaultKey.key : '（没有可用 key）';
  $('#v-anthropic').textContent = s.baseUrl;
  $('#v-datadir').textContent = `${s.storage.dir}${s.storage.volume ? ' (Volume)' : ''}`;
  $('#v-browser').textContent = s.browser.available
    ? `可用 · ${s.browser.headless ? 'headless' : 'headful(Xvfb)'}${s.browser.proxy ? ' · 代理已配' : ''}`
    : `不可用 · ${s.browser.reason || s.browser.loadError || '未安装'}`;
  $('#set-allowpaid').checked = Boolean(s.settings.allowPaidDefault);

  renderAccounts(s);
  renderKeys(s);
  renderModels(s);
}

const POOL_LABEL = { any: '全部模型', free: '仅免费', paid: '付费优先' };
const STATE_CLASS = {
  ok: 'ok',
  token_invalid: 'bad',
  banned: 'bad',
  country_blocked: 'warn',
  rate_limited: 'warn',
  model_locked: 'warn',
  ip_capped: 'warn',
  blocked: 'warn',
  network_error: 'warn',
  unknown: '',
};

function ago(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

function renderAccounts(s) {
  const tbody = $('#acct-table tbody');
  $('#acct-count').textContent = `${s.accounts.length} 个`;
  $('#acct-empty').classList.toggle('hidden', s.accounts.length > 0);
  $('#acct-table').classList.toggle('hidden', s.accounts.length === 0);
  tbody.innerHTML = s.accounts
    .map((a) => {
      const status = a.status;
      const wk = a.workerState;
      const cls = STATE_CLASS[status?.state] ?? '';
      const label = status ? status.verdict : wk ? `引擎观测：${wk.state}` : '未检测';
      const title = status ? `${status.detail || ''}` : '点「检测」做一次 0 消耗探活';
      return `<tr data-id="${a.id}">
      <td>
        <div>${esc(a.email || a.name || '(未知邮箱)')}</div>
        <div class="note" style="font-size:11px">${esc(a.source)} · ${ago(a.createdAt)}加入</div>
      </td>
      <td>
        <select class="acct-pool mini" style="padding:4px 6px;font-size:11.5px;width:auto">
          ${Object.entries(POOL_LABEL)
            .map(([v, t]) => `<option value="${v}"${a.pool === v ? ' selected' : ''}>${t}</option>`)
            .join('')}
        </select>
      </td>
      <td><span class="badge ${cls}" title="${esc(title)}">${esc(label)}</span></td>
      <td class="mono" style="font-size:11px;color:var(--muted)">${esc(a.tokenMasked)}</td>
      <td class="note" style="font-size:11px">${esc(status?.quota || '—')}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="mini acct-check">检测</button>
        <button class="mini acct-toggle">${a.enabled ? '停用' : '启用'}</button>
        <button class="mini acct-copy">复制token</button>
        <button class="mini danger acct-del">删除</button>
      </td></tr>`;
    })
    .join('');

  $$('#acct-table tbody tr').forEach((tr) => {
    const id = tr.dataset.id;
    const acct = s.accounts.find((a) => a.id === id);
    $('.acct-pool', tr).addEventListener('change', async (ev) => {
      await api(`/accounts/${id}`, { method: 'PATCH', body: { pool: ev.target.value } });
      toast('用途已更新');
      refresh(true);
    });
    $('.acct-check', tr).addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      ev.target.textContent = '检测中';
      try {
        const r = await api(`/accounts/${id}/check`, { method: 'POST' });
        toast(`${acct.email || id}：${r.status.verdict} —— ${r.status.detail}`, r.status.state === 'ok' ? 'ok' : 'warn', 6000);
      } catch (err) {
        toast(err.message, 'err');
      }
      refresh(true);
    });
    $('.acct-toggle', tr).addEventListener('click', async () => {
      await api(`/accounts/${id}`, { method: 'PATCH', body: { enabled: !acct.enabled } });
      refresh(true);
    });
    $('.acct-copy', tr).addEventListener('click', async () => {
      const r = await api(`/accounts/${id}`);
      copyText(r.token, 'token 已复制');
    });
    $('.acct-del', tr).addEventListener('click', async () => {
      if (!confirm(`确定删除账号 ${acct.email || id}？`)) return;
      await api(`/accounts/${id}`, { method: 'DELETE' });
      toast('已删除');
      refresh();
    });
  });
}

function renderKeys(s) {
  const tbody = $('#key-table tbody');
  $('#key-count').textContent = `${s.keys.length} 个`;
  tbody.innerHTML = s.keys
    .map(
      (k) => `<tr data-id="${k.id}">
      <td>${esc(k.name)}${k.enabled ? '' : ' <span class="badge bad">停用</span>'}</td>
      <td class="mono" style="font-size:11px">${esc(k.key.slice(0, 12))}…<button class="mini key-copy" style="margin-left:6px">复制</button></td>
      <td><label class="check"><input type="checkbox" class="key-paid"${k.allowPaid ? ' checked' : ''}><span class="badge ${k.allowPaid ? 'paid' : 'free'}">${k.allowPaid ? '允许' : '仅免费'}</span></label></td>
      <td class="note">${k.requests || 0}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="mini key-toggle">${k.enabled ? '停用' : '启用'}</button>
        <button class="mini danger key-del">删除</button>
      </td></tr>`
    )
    .join('');

  $$('#key-table tbody tr').forEach((tr) => {
    const id = tr.dataset.id;
    const k = s.keys.find((x) => x.id === id);
    $('.key-copy', tr).addEventListener('click', () => copyText(k.key, 'API key 已复制'));
    $('.key-paid', tr).addEventListener('change', async (ev) => {
      await api(`/keys/${id}`, { method: 'PATCH', body: { allowPaid: ev.target.checked } });
      toast(ev.target.checked ? '这个 key 现在可以用付费(Premium)模型' : '这个 key 只能用免费模型');
      refresh(true);
    });
    $('.key-toggle', tr).addEventListener('click', async () => {
      await api(`/keys/${id}`, { method: 'PATCH', body: { enabled: !k.enabled } });
      refresh(true);
    });
    $('.key-del', tr).addEventListener('click', async () => {
      if (!confirm(`删除 API key「${k.name}」？用它的客户端会立刻失效。`)) return;
      try {
        await api(`/keys/${id}`, { method: 'DELETE' });
        toast('已删除');
        refresh();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  });
}

function renderModels(s) {
  const onlyEnabled = $('#model-only-enabled').checked;
  const list = onlyEnabled ? s.models.filter((m) => m.enabled) : s.models;
  $('#model-count').textContent = `免费 ${s.modelStats.free} · 付费 ${s.modelStats.paid}`;
  $('#model-table tbody').innerHTML = list
    .map(
      (m) => `<tr data-id="${esc(m.id)}">
      <td class="mono" style="font-size:12px">${esc(m.id)}</td>
      <td>
        <select class="model-tier" style="padding:3px 6px;font-size:11.5px;width:auto">
          <option value="free"${m.tier === 'free' ? ' selected' : ''}>免费</option>
          <option value="paid"${m.tier === 'paid' ? ' selected' : ''}>付费</option>
        </select>
        ${m.overridden ? '<span class="badge" title="手动指定">手动</span>' : ''}
      </td>
      <td class="note" style="font-size:11.5px">${esc(m.note)}</td>
      <td><label class="check"><input type="checkbox" class="model-enabled"${m.enabled ? ' checked' : ''}><span>${m.enabled ? '提供' : '下架'}</span></label></td>
      </tr>`
    )
    .join('');

  $$('#model-table tbody tr').forEach((tr) => {
    const id = tr.dataset.id;
    $('.model-tier', tr).addEventListener('change', async (ev) => {
      await api('/models/tier', { method: 'POST', body: { id, tier: ev.target.value } });
      toast(`${id} 已归类为${ev.target.value === 'paid' ? '付费' : '免费'}`);
      refresh(true);
    });
    $('.model-enabled', tr).addEventListener('change', async (ev) => {
      const disabled = new Set(STATE.settings.disabledModels || []);
      if (ev.target.checked) disabled.delete(id);
      else disabled.add(id);
      await api('/settings', { method: 'PATCH', body: { disabledModels: [...disabled] } });
      refresh(true);
    });
  });
}

$('#model-only-enabled').addEventListener('change', () => renderModels(STATE));
$('#btn-model-refresh').addEventListener('click', async () => {
  toast('正在从上游拉取最新模型表…');
  await api('/models/refresh', { method: 'POST' }).catch((e) => toast(e.message, 'err'));
  refresh();
});

// ---------------------------------------------------------------- 通用弹层
function openModal(title, innerHtml, { width = 860, onClose } = {}) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="modal" style="max-width:${width}px">
    <header>${esc(title)}<span class="spacer"></span><button class="ghost mini modal-x">关闭</button></header>
    <div class="body">${innerHtml}</div>
  </div>`;
  const close = () => {
    mask.remove();
    document.removeEventListener('keydown', onEsc);
    onClose?.();
  };
  const onEsc = (ev) => {
    if (ev.key === 'Escape') close();
  };
  mask.addEventListener('click', (ev) => {
    if (ev.target === mask) close();
  });
  $('.modal-x', mask).addEventListener('click', close);
  document.addEventListener('keydown', onEsc);
  $('#modal-root').appendChild(mask);
  return { root: mask, close };
}

// ---------------------------------------------------------------- 顶部动作
$$('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', () => copyText($(btn.dataset.copy).textContent.trim()));
});

$('#btn-copy-all').addEventListener('click', () => {
  const k = STATE.keys.find((x) => x.enabled) || STATE.keys[0];
  const text = [
    `OpenAI 兼容 Base URL: ${STATE.apiBase}`,
    `API Key: ${k ? k.key : '(无)'}`,
    `Anthropic Base URL: ${STATE.baseUrl}`,
    `可用模型: ${STATE.models.filter((m) => m.enabled && (k?.allowPaid || m.tier === 'free')).map((m) => m.id).join(', ')}`,
  ].join('\n');
  copyText(text, '完整配置已复制');
});

$('#btn-selftest').addEventListener('click', async () => {
  const btn = $('#btn-selftest');
  btn.disabled = true;
  $('#selftest-result').innerHTML = '<span class="spin"></span> 正在真实调用一次…';
  try {
    const r = await api('/selftest', { method: 'POST', body: {} });
    $('#selftest-result').innerHTML = r.ok
      ? `<span class="badge ok">通过 ${r.ms}ms</span> ${esc(r.reply.slice(0, 60))}`
      : `<span class="badge bad">失败 HTTP ${r.status}</span> ${esc((r.raw || '').slice(0, 160))}`;
  } catch (err) {
    $('#selftest-result').innerHTML = `<span class="badge bad">${esc(err.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
});

$('#set-allowpaid').addEventListener('change', async (ev) => {
  await api('/settings', { method: 'PATCH', body: { allowPaidDefault: ev.target.checked } });
  toast('已保存');
});

$('#btn-export').addEventListener('click', () => {
  window.open('/admin/api/export', '_blank');
});

$('#btn-import').addEventListener('click', () => {
  const m = openModal('导入备份', `
    <label class="field"><span class="lbl">粘贴之前导出的 JSON</span>
      <textarea id="imp-text" style="min-height:150px" placeholder='{"accounts":[...],"keys":[...]}'></textarea></label>
    <label class="check" style="margin-bottom:12px"><input type="checkbox" id="imp-replace"><span>先清空现有账号和 key（危险）</span></label>
    <button class="primary" id="imp-go">导入</button>`);
  $('#imp-go', m.root).addEventListener('click', async () => {
    try {
      const payload = JSON.parse($('#imp-text', m.root).value);
      const r = await api('/import', { method: 'POST', body: { payload, replace: $('#imp-replace', m.root).checked } });
      toast(`导入完成：账号 +${r.accounts}，key +${r.keys}`);
      m.close();
      refresh();
    } catch (err) {
      toast(`导入失败：${err.message}`, 'err');
    }
  });
});

$('#btn-passwd').addEventListener('click', () => {
  const m = openModal('修改管理密码', `
    <label class="field"><span class="lbl">新密码（至少 6 位）</span><input type="password" id="pw-next" autocomplete="new-password"></label>
    <p class="hint">改完后其它设备需要重新登录。注意：环境变量 ADMIN_PASSWORD 里的密码依然有效，想彻底只用新密码就把那个变量删掉。</p>
    <button class="primary" id="pw-go" style="margin-top:10px">保存</button>`, { width: 460 });
  $('#pw-go', m.root).addEventListener('click', async () => {
    try {
      await api('/password', { method: 'POST', body: { next: $('#pw-next', m.root).value } });
      toast('密码已更新');
      m.close();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
});

$('#btn-add-key').addEventListener('click', () => {
  const m = openModal('新建 API Key', `
    <label class="field"><span class="lbl">名称（自己看的备注）</span><input type="text" id="nk-name" placeholder="例如 Cherry Studio"></label>
    <label class="check" style="margin-bottom:14px"><input type="checkbox" id="nk-paid"${STATE.settings.allowPaidDefault ? ' checked' : ''}><span>允许使用付费(Premium)模型 —— 会消耗号池每天共 6 次的 Premium session 额度</span></label>
    <button class="primary" id="nk-go">生成</button>`, { width: 520 });
  $('#nk-go', m.root).addEventListener('click', async () => {
    try {
      const r = await api('/keys', { method: 'POST', body: { name: $('#nk-name', m.root).value, allowPaid: $('#nk-paid', m.root).checked } });
      m.close();
      await refresh();
      copyText(r.key.key, '新 key 已生成并复制到剪贴板');
    } catch (err) {
      toast(err.message, 'err');
    }
  });
});

$('#btn-check-all').addEventListener('click', async () => {
  const btn = $('#btn-check-all');
  btn.disabled = true;
  btn.textContent = '检测中…';
  try {
    const r = await api('/accounts/check-all', { method: 'POST' });
    const ok = r.results.filter((x) => x.state === 'ok').length;
    toast(`检测完成：${ok}/${r.results.length} 存活`, ok === r.results.length ? 'ok' : 'warn');
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '全部检测';
    refresh();
  }
});

// ---------------------------------------------------------------- 添加账号
const POOL_SELECT = (id) => `<label class="field" style="max-width:220px"><span class="lbl">这个号的用途</span>
  <select id="${id}">
    <option value="any">全部模型（默认）</option>
    <option value="free">仅免费模型</option>
    <option value="paid">付费模型优先</option>
  </select></label>`;

$('#btn-add-account').addEventListener('click', () => {
  const browserOk = STATE.browser.available;
  const m = openModal('添加账号', `
  <div class="tabs" style="margin:-16px -16px 16px">
    <button data-tab="link" class="active">① 授权链接（推荐）</button>
    <button data-tab="browser">② 服务器内置浏览器</button>
    <button data-tab="manual">③ 手动粘贴 token</button>
  </div>

  <div class="pane" data-pane="link">
    <p class="note">走的是官方 CLI 那条授权码链路：这里生成一个一次性登录链接，你在自己的浏览器里登录 Google / GitHub，服务器轮询到 token 后自动入池。不需要机器人，也不需要本地脚本。</p>
    ${POOL_SELECT('link-pool')}
    <button class="primary" id="link-start">生成授权链接</button>
    <div id="link-area" class="hidden" style="margin-top:14px">
      <label class="field"><span class="lbl">授权链接（一次性，5 分钟内有效）</span><input type="text" id="link-url" readonly></label>
      <div class="row">
        <button class="primary" id="link-open">在新标签打开并登录</button>
        <button id="link-copy">复制链接</button>
        <span class="note" id="link-state"></span>
      </div>
      <div class="flowlog" id="link-log"></div>
    </div>
  </div>

  <div class="pane hidden" data-pane="browser">
    ${
      browserOk
        ? `<p class="note">在服务器上开一个 patchright Chromium（headful + Xvfb，指纹接近真机），画面直接推到这个页面，你可以在下面的画面里点、打字、登录。适合你本地网络打不开上游、或者想让登录动作从服务器出口发生的情况。</p>
    <div class="row" style="align-items:flex-end">
      ${POOL_SELECT('br-pool')}
      <label class="field" style="max-width:220px"><span class="lbl">浏览器配置</span>
        <select id="br-profile">
          <option value="fresh">全新指纹（每个号一个，推荐）</option>
          <option value="shared">复用上次会话（保留 cookie）</option>
        </select></label>
      <button class="primary" id="br-start" style="margin-bottom:12px">启动浏览器并打开登录页</button>
    </div>
    <div class="viewer hidden" id="br-viewer">
      <div class="bar">
        <button class="mini" data-nav="back">←</button>
        <button class="mini" data-nav="forward">→</button>
        <button class="mini" data-nav="reload">↻</button>
        <input type="text" id="br-url" placeholder="https://…">
        <button class="mini" id="br-go">打开</button>
      </div>
      <div class="screen" id="br-screen" tabindex="0">
        <img id="br-img" alt="">
        <div class="overlay" id="br-overlay"></div>
        <div class="placeholder" id="br-ph"><span class="spin"></span> 正在启动 Chromium（首次约 5~15 秒）…</div>
      </div>
      <div class="bar">
        <input type="text" id="br-text" placeholder="要输入的文字（邮箱/密码）—— 点一下页面输入框再点这里的「输入」">
        <button class="mini" id="br-send">输入</button>
        <button class="mini" id="br-enter">回车</button>
        <span class="note" id="br-state"></span>
      </div>
    </div>
    <div class="flowlog hidden" id="br-log"></div>`
        : `<p class="note warn">内置浏览器不可用：${esc(STATE.browser.reason || STATE.browser.loadError || '未安装 Chromium')}。<br>用「① 授权链接」一样能加号，效果完全相同。</p>`
    }
  </div>

  <div class="pane hidden" data-pane="manual">
    <p class="note">已经有 authToken（比如以前用 extract_freebuff.py 或别的部署导出的）就直接贴进来，支持一次贴多行/多个。</p>
    ${POOL_SELECT('mn-pool')}
    <label class="field"><span class="lbl">authToken（一行一个）</span><textarea id="mn-token" placeholder="eyJ...&#10;eyJ..."></textarea></label>
    <button class="primary" id="mn-go">加入账号池</button>
  </div>`, { width: 960, onClose: () => teardown() });

  // ---- 状态 ----
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

  $$('[data-tab]', m.root).forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('[data-tab]', m.root).forEach((b) => b.classList.toggle('active', b === btn));
      $$('[data-pane]', m.root).forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== btn.dataset.tab));
    });
  });

  function renderFlow() {
    if (!flow) return;
    const stateText = {
      pending: '等待你在登录页完成授权…',
      done: '登录成功，账号已入池 ✅',
      error: `失败：${flow.error || ''}`,
      timeout: '超时，请重新生成链接',
      cancelled: '已取消',
    }[flow.state];
    const logHtml = (flow.log || []).map((l) => `<div>· ${esc(l.message)}</div>`).join('');
    for (const [stateId, logId] of [['#link-state', '#link-log'], ['#br-state', '#br-log']]) {
      const stateEl = $(stateId, m.root);
      const logEl = $(logId, m.root);
      if (stateEl) stateEl.innerHTML = flow.state === 'pending' ? `<span class="spin"></span> ${stateText}` : stateText;
      if (logEl) {
        logEl.classList.remove('hidden');
        logEl.innerHTML = logHtml;
        logEl.scrollTop = logEl.scrollHeight;
      }
    }
    if (flow.state === 'done') {
      clearInterval(flowTimer);
      toast(`账号 ${flow.account?.email || ''} 已加入号池`, 'ok', 5000);
      refresh();
      setTimeout(() => m.close(), 1500);
    } else if (['error', 'timeout', 'cancelled'].includes(flow.state)) {
      clearInterval(flowTimer);
    }
  }

  function startPolling() {
    clearInterval(flowTimer);
    flowTimer = setInterval(async () => {
      try {
        const r = await api(`/login-flow/${flow.id}`);
        flow = r.flow;
        renderFlow();
      } catch {
        clearInterval(flowTimer);
      }
    }, 2500);
  }

  // ---- ① 授权链接 ----
  $('#link-start', m.root)?.addEventListener('click', async () => {
    const btn = $('#link-start', m.root);
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> 申请中…';
    try {
      const r = await api('/login-flow', { method: 'POST', body: { mode: 'link', pool: $('#link-pool', m.root).value } });
      flow = r.flow;
      $('#link-area', m.root).classList.remove('hidden');
      $('#link-url', m.root).value = flow.loginUrl;
      renderFlow();
      startPolling();
      window.open(flow.loginUrl, '_blank', 'noopener');
    } catch (err) {
      toast(err.message, 'err', 6000);
    } finally {
      btn.disabled = false;
      btn.textContent = '重新生成授权链接';
    }
  });
  $('#link-open', m.root)?.addEventListener('click', () => flow && window.open(flow.loginUrl, '_blank', 'noopener'));
  $('#link-copy', m.root)?.addEventListener('click', () => flow && copyText(flow.loginUrl, '链接已复制'));

  // ---- ③ 手动 token ----
  $('#mn-go', m.root)?.addEventListener('click', async () => {
    try {
      const r = await api('/accounts', {
        method: 'POST',
        body: { token: $('#mn-token', m.root).value, pool: $('#mn-pool', m.root).value },
      });
      toast(`已加入 ${r.added} 个账号`);
      m.close();
      refresh();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  // ---- ② 服务器内置浏览器 ----
  const img = $('#br-img', m.root);
  const overlay = $('#br-overlay', m.root);
  const screen = $('#br-screen', m.root);

  const sendWs = (obj) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  };

  // 把鼠标位置换算成画面内的 0~1 归一化坐标（img 是 object-fit:contain，要去掉黑边）
  function norm(ev) {
    const r = img.getBoundingClientRect();
    const nw = img.naturalWidth || 1440;
    const nh = img.naturalHeight || 900;
    const scale = Math.min(r.width / nw, r.height / nh);
    const dw = nw * scale;
    const dh = nh * scale;
    const ox = r.left + (r.width - dw) / 2;
    const oy = r.top + (r.height - dh) / 2;
    const clamp = (v) => Math.max(0, Math.min(1, v));
    return { x: clamp((ev.clientX - ox) / dw), y: clamp((ev.clientY - oy) / dh) };
  }

  function connectViewer(flowId) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/admin/ws/browser?flow=${encodeURIComponent(flowId)}`);
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.t === 'frame') {
        img.src = `data:image/jpeg;base64,${msg.data}`;
        $('#br-ph', m.root)?.classList.add('hidden');
      } else if (msg.t === 'status') {
        const urlBox = $('#br-url', m.root);
        if (document.activeElement !== urlBox) urlBox.value = msg.url || '';
      } else if (msg.t === 'closed') {
        $('#br-ph', m.root)?.classList.remove('hidden');
        $('#br-ph', m.root).innerHTML = '浏览器已关闭';
      } else if (msg.t === 'error') {
        toast(msg.message, 'warn', 5000);
      }
    };
    ws.onclose = () => {
      ws = null;
    };
  }

  $('#br-start', m.root)?.addEventListener('click', async () => {
    const btn = $('#br-start', m.root);
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> 启动中…';
    $('#br-viewer', m.root).classList.remove('hidden');
    try {
      const r = await api('/login-flow', {
        method: 'POST',
        body: { mode: 'browser', pool: $('#br-pool', m.root).value, profile: $('#br-profile', m.root).value },
      });
      flow = r.flow;
      renderFlow();
      startPolling();
      connectViewer(flow.id);
      screen.focus();
    } catch (err) {
      toast(err.message, 'err', 8000);
      $('#br-ph', m.root).innerHTML = esc(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '重新启动浏览器';
    }
  });

  if (overlay) {
    let lastMove = 0;
    overlay.addEventListener('mousemove', (ev) => {
      const now = Date.now();
      if (now - lastMove < 45) return;
      lastMove = now;
      sendWs({ t: 'move', ...norm(ev) });
    });
    overlay.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      screen.focus();
      sendWs({ t: 'down', ...norm(ev), button: ev.button, clickCount: ev.detail || 1 });
    });
    overlay.addEventListener('mouseup', (ev) => {
      ev.preventDefault();
      sendWs({ t: 'up', ...norm(ev), button: ev.button, clickCount: ev.detail || 1 });
    });
    overlay.addEventListener('contextmenu', (ev) => ev.preventDefault());
    overlay.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        sendWs({ t: 'wheel', ...norm(ev), dx: ev.deltaX, dy: ev.deltaY });
      },
      { passive: false }
    );
    screen.addEventListener('keydown', (ev) => {
      if (ev.key === 'F5' || (ev.ctrlKey && ev.key === 'r')) return; // 留给本地刷新
      ev.preventDefault();
      sendWs({ t: 'key', key: ev.key, ctrl: ev.ctrlKey, alt: ev.altKey, meta: ev.metaKey, shift: ev.shiftKey });
    });
    screen.addEventListener('paste', (ev) => {
      const text = ev.clipboardData?.getData('text');
      if (text) {
        ev.preventDefault();
        sendWs({ t: 'text', text });
      }
    });
    $$('[data-nav]', m.root).forEach((b) => b.addEventListener('click', () => sendWs({ t: b.dataset.nav })));
    $('#br-go', m.root)?.addEventListener('click', () => sendWs({ t: 'navigate', url: $('#br-url', m.root).value }));
    $('#br-url', m.root)?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') sendWs({ t: 'navigate', url: ev.target.value });
    });
    $('#br-send', m.root)?.addEventListener('click', () => {
      const box = $('#br-text', m.root);
      if (box.value) {
        sendWs({ t: 'text', text: box.value });
        box.value = '';
      }
    });
    $('#br-text', m.root)?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') $('#br-send', m.root).click();
    });
    $('#br-enter', m.root)?.addEventListener('click', () => sendWs({ t: 'key', key: 'Enter' }));
  }


});

// ---------------------------------------------------------------- 启动
(async () => {
  try {
    const s = await api('/session');
    if (s.authed) await enterApp();
    else {
      showLock(
        s.hasPassword
          ? '输入管理员密码进入控制台。'
          : '服务端没有设置 ADMIN_PASSWORD —— 请在 Railway 变量里加上后重新部署。'
      );
    }
  } catch {
    showLock('无法连接服务端，稍后重试。');
  }
})();
