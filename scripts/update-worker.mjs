#!/usr/bin/env node
// 把 vendor/ 下的上游文件更新到最新（上游是单文件引擎，本项目不改它，只在外面套壳）。
// 用法: npm run update-worker
//
// 每个目标都有多个镜像 + 重试 + 校验：以前只试一个地址、没超时也没重试，
// 网络抖一下就报"更新失败"，然后你以为已经是最新了。
import { writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'pingmike2/freebuff2api-wokers';

const TARGETS = [
  {
    file: 'vendor/worker.js',
    urls: [
      `https://raw.githubusercontent.com/${REPO}/main/worker.js`,
      `https://cdn.jsdelivr.net/gh/${REPO}@main/worker.js`,
    ],
    check(text) {
      if (!text.includes('export default')) return '没有 export default，不像 worker.js';
      if (!/const VERSION = "/.test(text)) return '找不到 VERSION 常量';
      if (text.length < 40000) return `内容太短（${text.length}B）`;
      return null;
    },
    describe: (text) => (text.match(/const VERSION = "([^"]+)"/) || [])[1] || '?',
  },
  {
    file: 'vendor/freebuff-models.json',
    // release 资产最新但有时很慢；仓库文件快但可能落后几天 —— 顺序就是优先级
    urls: [
      `https://github.com/${REPO}/releases/latest/download/freebuff-models.json`,
      `https://raw.githubusercontent.com/${REPO}/main/freebuff-models.json`,
      `https://cdn.jsdelivr.net/gh/${REPO}@main/freebuff-models.json`,
    ],
    check(text) {
      let json;
      try {
        json = JSON.parse(text);
      } catch (err) {
        return `不是合法 JSON：${err.message}`;
      }
      if (!Array.isArray(json.models) || !json.models.length) return '没有 models 数组';
      if (!json.pools?.premium) return '没有 pools.premium';
      return null;
    },
    describe: (text) => JSON.parse(text).generatedAt || '?',
  },
];

async function grab(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

let failed = 0;
for (const target of TARGETS) {
  const path = resolve(root, target.file);
  let before = '';
  try {
    before = await readFile(path, 'utf8');
  } catch {}

  let text = null;
  const notes = [];
  for (const url of target.urls) {
    for (let attempt = 1; attempt <= 2 && !text; attempt++) {
      try {
        const body = await grab(url);
        const bad = target.check(body);
        if (bad) {
          notes.push(`${new URL(url).host} 内容不对（${bad}）`);
          break; // 内容不对就换下一个源，重试同一个没意义
        }
        text = body;
      } catch (err) {
        notes.push(`${new URL(url).host} 第 ${attempt} 次：${err.name === 'AbortError' ? '超时' : err.message}`);
      }
    }
    if (text) break;
  }

  if (!text) {
    console.error(`✘ ${target.file} 更新失败`);
    for (const n of notes) console.error(`    ${n}`);
    failed++;
    continue;
  }
  if (before === text) {
    console.log(`= ${target.file} 已是最新（${target.describe(text)}）`);
    continue;
  }
  await writeFile(path, text);
  const from = before ? (() => { try { return target.describe(before); } catch { return '?'; } })() : '（新文件）';
  console.log(`✔ ${target.file} ${from} → ${target.describe(text)}`);
  if (notes.length) for (const n of notes) console.log(`    （跳过：${n}）`);
}

if (failed) {
  console.error('\n有文件没更新成功，vendor 里还是旧版本 —— 重跑一次或者检查网络。');
  process.exitCode = 1;
} else {
  console.log('\n更新完了。跑一下 npm run check && npm test 确认没被上游改动搞坏。');
}
