#!/usr/bin/env sh
set -e

DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR" 2>/dev/null || true

# 有 xvfb 且没禁用内置浏览器时，整个进程跑在虚拟显示里。
# patchright 在 headful（headless=false）下指纹最干净，这是它相对 playwright 的主要价值。
if [ "${ENABLE_BROWSER_LOGIN:-true}" != "false" ] && command -v xvfb-run >/dev/null 2>&1; then
  echo "[entrypoint] Xvfb 模式启动（Chromium headful，指纹更真实）"
  exec xvfb-run -a -s "-screen 0 ${XVFB_SCREEN:-1440x900x24} -ac -nolisten tcp" node /app/src/server.js
fi

echo "[entrypoint] 直接启动（无 Xvfb，内置浏览器将走 headless）"
exec node /app/src/server.js
