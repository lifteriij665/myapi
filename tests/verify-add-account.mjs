// 真浏览器里走一遍「添加账号」的三条路，验证录入到底能不能成。
// 用户报的是"opencode 填了 apikey 录不进去"，所以这条重点验。
import { chromium } from 'patchright';

const B = process.env.VBASE || 'http://localhost:8974';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errs.push('CONSOLE: ' + m.text());
});

const step = (name, ok, extra = '') => console.log(`${ok ? '✔' : '✘'} ${name}${ok ? '' : `  ← ${extra}`}`);

await page.goto(B, { waitUntil: 'domcontentloaded' });
await page.fill('#gate-pass', 'v-pw');
await page.click('#gate-btn');
await page.waitForSelector('#channels', { timeout: 20000 });
await page.waitForTimeout(2200);

// ── 1) 先建一个自定义上游，后面顺便验它的加 Key 路径 ──
await page.click('[data-view="upstreams"]');
await page.waitForTimeout(700);
await page.click('#btn-add-upstream');
await page.waitForSelector('#uf-name', { timeout: 8000 });
const UP_NAME = 'Verify Relay ' + Date.now();
await page.fill('#uf-name', UP_NAME);
await page.fill('#uf-url', 'https://relay.example.com/v1');
await page.selectOption('#uf-format', 'chat');
await page.fill('#uf-keys', 'sk-relay-verify-111111111111');
await page.click('#uf-go');
await page.waitForTimeout(2500);
const upNames = await page.$$eval('#upstream-list .up-name', (e) => e.map((x) => x.textContent));
step('建自定义上游', upNames.includes(UP_NAME), upNames.join(','));

// ── 2) 添加账号 → 选上游这一步 ──
await page.click('[data-view="accounts"]');
await page.waitForTimeout(700);
await page.click('#btn-add-account');
await page.waitForSelector('.pick', { timeout: 8000 });
const picks = await page.$$eval('.pick', (els) => els.map((e) => e.querySelector('b')?.textContent));
step('第一步是选上游（不是一堆混在一起的方式）', picks.length >= 3, JSON.stringify(picks));
step('三个上游都在选择列表里', picks.includes('freebuff') && picks.includes('opencode Zen') && picks.includes(UP_NAME), JSON.stringify(picks));

// ── 3) opencode：贴 key 录入（用户报的那个 bug）──
await page.click('.pick[data-id="opencode"]');
await page.waitForTimeout(900);
const ocBoxVisible = await page.isVisible('#oc-token').catch(() => false);
step('opencode 面板里那个 key 输入框可见', ocBoxVisible);
const ocBtnVisible = await page.isVisible('#oc-submit').catch(() => false);
step('opencode 的「加入号池」按钮可见（以前被藏在隐藏容器里）', ocBtnVisible);
await page.fill('#oc-token', 'sk-zen-verify-aaaaaaaaaaaaaaaa');
await page.click('#oc-submit');
await page.waitForTimeout(3500);
const dialogGone = (await page.$$('#oc-token')).length === 0;
step('提交后对话框关掉了', dialogGone);
const rows1 = await page.$$eval('#acct-table tbody tr', (trs) =>
  trs.map((tr) => ({ title: tr.querySelector('.cell-main b')?.textContent, prov: tr.querySelector('.tag.prov')?.textContent }))
);
step('opencode 的 key 真的进了号池', rows1.some((r) => r.prov === 'opencode'), JSON.stringify(rows1));

// ── 4) 自定义上游：贴 key ──
await page.click('#btn-add-account');
await page.waitForSelector('.pick', { timeout: 8000 });
const customPick = await page.$('.pick:not([data-id="freebuff"]):not([data-id="opencode"])');
await customPick.click();
await page.waitForSelector('#ak-keys', { timeout: 8000 });
await page.fill('#ak-keys', 'sk-relay-verify-222222222222\nsk-relay-verify-333333333333');
await page.click('#ak-go');
await page.waitForTimeout(3000);
const rows2 = await page.$$eval('#acct-table tbody tr', (trs) => trs.length);
step('自定义上游批量加 Key 成功', rows2 >= 4, `现在 ${rows2} 行`);

// ── 5) freebuff：三种方式的面板都在 ──
await page.click('#btn-add-account');
await page.waitForSelector('.pick', { timeout: 8000 });
await page.click('.pick[data-id="freebuff"]');
await page.waitForSelector('#methods', { timeout: 8000 });
const methods = await page.$$eval('#methods .method', (els) => els.map((e) => e.querySelector('b')?.textContent));
step('freebuff 保留三种录入方式（老版本那套）', methods.length === 3, JSON.stringify(methods));
// 切到粘贴 token 那一档，验证它能提交
await page.click('.method[data-m="paste"]');
await page.waitForTimeout(500);
const pasteVisible = await page.isVisible('#mn-token').catch(() => false);
step('freebuff 粘贴 token 面板可见', pasteVisible);
await page.fill('#mn-token', 'fake-freebuff-verify-000000000');
await page.click('#mn-go');
await page.waitForTimeout(3000);
const rows3 = await page.$$eval('#acct-table tbody tr', (trs) =>
  trs.map((tr) => tr.querySelector('.tag.prov')?.textContent)
);
step('freebuff 的 token 也进了号池', rows3.includes('freebuff'), JSON.stringify(rows3));

// ── 6) 各上游的号是不是都归到了对的上游 ──
const filters = await page.$$eval('#acct-filter button', (b) => b.map((x) => x.textContent.trim()));
step('账号池按上游分组过滤', filters.length >= 3, JSON.stringify(filters));

console.log('\nJS 报错:', errs.length ? errs : '无');
await browser.close();
