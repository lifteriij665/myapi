#!/usr/bin/env sh
# 故意不用 set -e：任何浏览器相关的前置步骤失败，都不该阻止 HTTP 服务起来
# —— Railway 的 healthcheck 打 /healthz，服务起不来整个部署就废了。

DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR" 2>/dev/null || true

# 自己拉 Xvfb，不走 xvfb-run：xvfb-run 依赖 xauth（xvfb 包只是 Recommends，
# --no-install-recommends 装不上），缺了会直接 exit 3 把容器带走。
# Xvfb 带 -ac（关闭访问控制）本来就不需要 auth cookie。
start_xvfb() {
  if ! command -v Xvfb >/dev/null 2>&1; then
    echo "[entrypoint] 镜像里没有 Xvfb，内置浏览器将以 headless 运行"
    return 1
  fi
  rm -f /tmp/.X99-lock 2>/dev/null || true
  Xvfb :99 -screen 0 "${XVFB_SCREEN:-1440x900x24}" -ac -nolisten tcp >/tmp/xvfb.log 2>&1 &
  xvfb_pid=$!
  i=0
  while [ "$i" -lt 40 ]; do
    if [ -e /tmp/.X11-unix/X99 ]; then
      DISPLAY=:99
      export DISPLAY
      echo "[entrypoint] Xvfb 就绪（DISPLAY=:99, pid=$xvfb_pid）"
      return 0
    fi
    if ! kill -0 "$xvfb_pid" 2>/dev/null; then
      echo "[entrypoint] Xvfb 启动失败，最后几行日志："
      tail -n 5 /tmp/xvfb.log 2>/dev/null
      return 1
    fi
    i=$((i + 1))
    sleep 0.25
  done
  echo "[entrypoint] 等 Xvfb socket 超时，改用 headless"
  return 1
}

if [ "${ENABLE_BROWSER_LOGIN:-true}" = "false" ]; then
  echo "[entrypoint] ENABLE_BROWSER_LOGIN=false，跳过 Xvfb"
else
  start_xvfb || echo "[entrypoint] 继续启动（内置浏览器退化为 headless）"
fi

echo "[entrypoint] node $(node -v 2>/dev/null) · PORT=${PORT:-8787} · DATA_DIR=$DATA_DIR"
exec node /app/src/server.js
