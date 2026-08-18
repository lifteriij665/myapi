# myapi —— freebuff2api Railway 部署镜像
# 基础镜像用 Debian slim（不用 alpine）：patchright/playwright 的 Chromium 需要 glibc。
FROM node:22-bookworm-slim

# 构建参数：不需要「服务器内置浏览器登录」时用 --build-arg INSTALL_CHROMIUM=false
# 可把镜像缩小 ~400MB（仍可用「授权链接」和「手动粘贴 token」两种加号方式）。
ARG INSTALL_CHROMIUM=true

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# xvfb：给 patchright 提供真实 X11 显示，Chromium 以 headful 模式跑，指纹比 headless 干净得多
# xauth：xvfb-run 硬依赖它（xvfb 只是 Recommends），留着方便进容器手动调试
# tini：1 号进程，负责回收 chromium 子进程，避免僵尸进程堆积
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates tini xvfb xauth fonts-liberation fonts-noto-core fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; \
    else npm install --omit=dev --no-audit --no-fund; fi

# patchright 的补丁版 Chromium（--with-deps 顺带装齐 apt 运行库）
RUN if [ "$INSTALL_CHROMIUM" = "true" ]; then \
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0 npx patchright install --with-deps chromium \
      && chmod -R a+rX /ms-playwright ; \
    else echo "[build] INSTALL_CHROMIUM=false，跳过 Chromium 下载"; fi

COPY . .

# COPY 过来的脚本可能没有执行位（Windows 上 clone 的仓库常见），这里补上
RUN chmod +x /app/docker-entrypoint.sh && mkdir -p /data && chmod 700 /data

EXPOSE 8787

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker-entrypoint.sh"]
