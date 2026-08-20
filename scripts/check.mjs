#!/usr/bin/env node
// 轻量自检：所有源码能否被解析 + 关键模块能否 import（不启动服务）。
import { readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;

for (const dir of ['src', 'src/protocols', 'vendor']) {
  const files = (await readdir(resolve(root, dir))).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    const p = resolve(root, dir, f);
    try {
      await import(pathToFileURL(p).href);
      console.log(`✔ ${dir}/${f}`);
    } catch (err) {
      // server.js 会自己起监听，这里跳过它的运行期错误，只关心语法/导入错误
      console.error(`✘ ${dir}/${f}: ${err.message}`);
      failed++;
    }
  }
}
process.exit(failed ? 1 : 0);
