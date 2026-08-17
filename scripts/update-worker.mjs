#!/usr/bin/env node
// 把 vendor/worker.js 更新到上游最新版（上游是单文件引擎，本项目不改它，只在外面套壳）。
// 用法: npm run update-worker
import { writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = {
  'vendor/worker.js': 'https://raw.githubusercontent.com/pingmike2/freebuff2api-wokers/main/worker.js',
  'vendor/freebuff-models.json':
    'https://github.com/pingmike2/freebuff2api-wokers/releases/latest/download/freebuff-models.json',
};

for (const [rel, url] of Object.entries(SOURCES)) {
  const target = resolve(root, rel);
  try {
    const resp = await fetch(url, { redirect: 'follow' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    if (text.length < 500) throw new Error(`内容过短(${text.length}B)，疑似拉到错误页`);
    let before = '';
    try { before = await readFile(target, 'utf8'); } catch {}
    if (before === text) {
      console.log(`= ${rel} 已是最新`);
      continue;
    }
    await writeFile(target, text);
    console.log(`✔ ${rel} 已更新 (${before.length}B → ${text.length}B)`);
  } catch (err) {
    console.error(`✘ ${rel} 更新失败: ${err.message}`);
    process.exitCode = 1;
  }
}
