#!/usr/bin/env node
// 一条命令跑完全部测试：先跑纯函数单测，再起一个临时服务跑 HTTP 层集成测试。
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.TEST_PORT || '8899';
const PASSWORD = 'test-suite-password';
const DATA = './data-test-http';

const run = (args, env = {}) =>
  new Promise((done) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
    child.on('exit', (code) => done(code ?? 1));
  });

console.log('── 单元测试 ──');
await rm(resolve(root, 'data-test-unit'), { recursive: true, force: true });
const unitCode = await run(['tests/unit.mjs']);
await rm(resolve(root, 'data-test-unit'), { recursive: true, force: true });
if (unitCode !== 0) process.exit(unitCode);

console.log('\n── 集成测试（起一个临时服务）──');
await rm(resolve(root, DATA), { recursive: true, force: true });
const server = spawn(process.execPath, ['src/server.js'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ADMIN_PASSWORD: PASSWORD, DATA_DIR: DATA, PORT, ENABLE_BROWSER_LOGIN: 'false' },
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const ready = await (async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/healthz`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
})();

let code = 1;
if (!ready) {
  console.error('服务没起来，日志：\n' + serverLog);
} else {
  code = await run(['tests/http.mjs'], { TEST_BASE: `http://localhost:${PORT}`, TEST_PASSWORD: PASSWORD });
}
server.kill();
await new Promise((r) => setTimeout(r, 500));
await rm(resolve(root, DATA), { recursive: true, force: true });
process.exit(code);
