# myapi

把 [freebuff2api-wokers](https://github.com/pingmike2/freebuff2api-wokers) 的引擎搬到 **Railway**，外面套一层**带密码的网页控制台**：

- 🔐 **输入管理员密码解锁**，进主页就能管号池，不用改环境变量、不用重新部署
- 🌐 **在网页里直接登录加号**：走官方 CLI 那条授权码链路，点一下按钮就跳登录页，服务器轮询到 token 自动入池。**不需要 Telegram 机器人，不需要本地跑脚本**
- 🖥️ **还带一个服务器内置浏览器**：容器里跑 patchright Chromium（headful + Xvfb，指纹接近真机），画面用 CDP 截屏推到网页上，你可以在网页里点、打字，直接在服务器上完成登录
- 👥 **多账号号池**：每个号可以设"全部模型 / 仅免费 / 付费优先"，付费模型只会落到允许的号上
- 💳 **模型分免费和付费**：每个 API key 一个「允许付费模型」勾选框，不勾就只给免费模型，Premium 那 6 次/天的额度不会被误烧
- 🔑 **多 API key**：分客户端发 key、单独停用、看调用次数
- 📋 **一键复制**：Base URL、API key、完整配置，复制完直接粘到 Cherry Studio / ChatGPT-Next-Web / one-api 里

对外接口和原项目一致：`/v1/chat/completions`、`/v1/models`、`/v1/responses`、`/v1/messages`（Anthropic 协议）、`/healthz`。

> 引擎文件 `vendor/worker.js` 原样引用上游、**一行没改**，方便随时 `npm run update-worker` 升级。所有新增能力都在 `src/` 这一层。

---

## 一、部署到 Railway

### 1. 把这个仓库导进 Railway

1. 打开 [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → 选中这个仓库
2. Railway 会自动认出 `Dockerfile` 开始构建（第一次构建要下 Chromium，大约 3~6 分钟）

### 2. 配置变量

服务 → **Variables** → 至少加这一个：

| 变量 | 值 | 说明 |
|---|---|---|
| `ADMIN_PASSWORD` | 你自己的密码 | 进控制台用。不设的话首次启动会随机生成一个并打印在 Deploy Logs 里 |

其余变量都有默认值，按需再加（见下面的变量表）。

### 3. 挂一个 Volume（强烈建议）

服务 → 右键 / **Settings** → **Add Volume**，挂载路径填 **`/data`**。

不挂也能跑，但**每次重新部署账号池和 API key 都会清空**（Railway 容器文件系统是临时的）。控制台顶部会一直提示这件事。

### 4. 开公网域名

服务 → **Settings** → **Networking** → **Generate Domain**，拿到 `xxx.up.railway.app`。

浏览器打开这个域名 → 输入管理员密码 → 进主页。

---

## 二、第一次用：三步跑通

### 第 1 步：加账号

主页点 **「+ 添加账号」**，三种方式挑一种：

| 方式 | 怎么用 | 什么时候用 |
|---|---|---|
| **① 授权链接**（推荐） | 点「生成授权链接」→ 自动开新标签 → 用 Google / GitHub 登录 → 回到控制台，状态自动变成"登录成功" | 默认就用这个，最稳。登录动作发生在**你自己的浏览器**里，不会被判定成自动化 |
| **② 服务器内置浏览器** | 点「启动浏览器并打开登录页」→ 网页里出现服务器浏览器的画面 → 在画面里点按钮、用下面的输入框打字完成登录 | 你本地网络打不开 codebuff、或者想让登录动作从服务器出口发生 |
| **③ 手动粘贴 token** | 把已有的 `authToken` 贴进去，支持一次贴多行 | 从别的部署 / `extract_freebuff.py` 迁移过来 |

加完可以点「检测」做一次 **0 消耗探活**（只读 `GET /api/v1/freebuff/session`，不创建 session、不扣额度），能看出存活 / token 失效 / 被封 / 地区受限 / 额度用完。

### 第 2 步：拿 Base URL 和 key

主页最上面那张卡：

```
Base URL   https://你的域名/v1
API Key    sk-fb-xxxxxxxx
```

点「一键复制完整配置」直接粘到客户端里。想验证通不通，点「自检」——它会用当前号池真跑一次免费模型，把回复贴出来。

### 第 3 步：决定要不要给付费模型

「API Key」卡里每个 key 都有一个 **付费模型** 勾选框：

- **不勾（默认）**：`/v1/models` 只返回免费模型，请求付费模型直接 403，不会消耗号池的 Premium 额度
- **勾上**：付费(Premium)模型也能用，会走号池里"全部模型 / 付费优先"的号

「模型」卡里能看到分类结果，也能手动把某个模型改成免费/付费、或者直接下架不对外提供。

---

## 三、免费和付费是怎么分的

分类跟着上游的额度池走（逆向自官方 `freebuff-models.ts`，和 `vendor/worker.js` 同源）：

| 池 | 本项目分类 | 含义 |
|---|---|---|
| `premium` | **付费** | 全账号共享 **6 次 session / 天**（`minimax-m3`、`deepseek-v4-pro`、`gpt-5.6-luna`、`laguna`、`muse-spark`、`kimi-k3-eco` 等） |
| `standard` | 免费 | 非 Premium 模型（`deepseek-v4-flash`、`mimo-v2.5` 一类） |
| `glm` | 免费（标注需资格） | 独立额度池，要官方 referral / streak 资格 |
| 表里没有的新模型 | 默认按**付费**处理 | 保守策略，免得没勾选的 key 把 Premium 额度烧掉；确认是免费的话在「模型」卡里改一下 |

模型表启动时和之后每 6 小时会从上游 Release 拉一次最新的，拉不到就用仓库里随包的副本。

**号池用途**（每个账号一个下拉框）：

- `全部模型`（默认）：免费和付费都能用它
- `仅免费`：只承接免费模型，Premium 额度留着
- `付费优先`：付费模型优先落到它头上

---

## 四、环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ADMIN_PASSWORD` | 随机生成并打印到日志 | 控制台解锁密码。**在控制台改过密码后，这个变量里的密码依然有效**（防止把自己锁在外面），不想要就删掉这个变量 |
| `DATA_DIR` | `/data`（挂了 Volume 就用 Volume 路径） | 数据文件目录 |
| `PORT` | Railway 自动注入 | 监听端口 |
| `FREEBUFF_API_KEY` | 首次启动自动生成 | 预置第一个 API key |
| `FREEBUFF_TOKEN` | 空 | 预置账号 token，逗号或换行分隔（一般不用，控制台加号更方便） |
| `ALLOW_PAID_DEFAULT` | `false` | 新建 API key 时「允许付费模型」的默认值 |
| `ENABLE_BROWSER_LOGIN` | `true` | `false` = 关掉内置浏览器（也不再用 Xvfb 启动） |
| `BROWSER_HEADLESS` | `auto` | `auto` = 有 Xvfb 就 headful（指纹更好），没有就 headless |
| `BROWSER_PROXY` | 空 | 内置浏览器走代理，如 `http://user:pass@host:port`、`socks5://host:1080` |
| `BROWSER_LOCALE` / `BROWSER_TIMEZONE` | `en-US` / `America/Los_Angeles` | 内置浏览器的语言和时区 |
| `BROWSER_IDLE_TIMEOUT_MS` | `600000` | 没人看画面多久后自动关浏览器省内存 |
| `SCREENCAST_QUALITY` | `55` | 推流 JPEG 质量，网络差可以调低 |
| `SESSION_TTL_HOURS` | `168` | 控制台登录状态保留多久 |
| `FREEBUFF_DEBUG` | `false` | 引擎调试日志 |

镜像构建参数：不想要内置浏览器（省 ~400MB 镜像 + 内存）时用

```bash
docker build --build-arg INSTALL_CHROMIUM=false -t myapi .
```

Railway 上对应 **Settings → Build → Build Args** 加 `INSTALL_CHROMIUM=false`。

---

## 五、接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 健康检查，免鉴权（Railway healthcheck 用它） |
| GET | `/v1/models` | 模型列表，**按 key 权限过滤** |
| POST | `/v1/chat/completions` | OpenAI 兼容，支持流式 |
| POST | `/v1/responses` | OpenAI Responses API |
| POST | `/v1/messages` | Anthropic Messages API（含 `/v1/messages/count_tokens`） |
| — | `/`、`/admin/api/*` | 控制台（密码鉴权） |

```bash
curl https://你的域名/v1/chat/completions \
  -H "Authorization: Bearer sk-fb-你的key" \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"你好"}]}'
```

---

## 六、本地跑 / 自建 Docker

```bash
npm install
ADMIN_PASSWORD=test1234 DATA_DIR=./data PORT=8787 npm start
# 想试内置浏览器：npx patchright install chromium
```

```bash
docker build -t myapi .
docker run -d --name myapi -p 8787:8787 \
  -e ADMIN_PASSWORD=换成你的密码 \
  -v myapi-data:/data \
  myapi
```

升级引擎：

```bash
npm run update-worker   # 拉上游最新 worker.js + 模型表
npm run check           # 语法/导入自检
```

---

## 七、常见问题

**内置浏览器里 Google 登录被拒？**
Google 对自动化浏览器有额外风控。patchright + headful(Xvfb) 已经把常见的自动化特征去掉了，但不保证 100%。遇到拒登直接换 **方式①**：在你自己的浏览器里授权，效果完全一样（token 是同一条链路拿到的）。GitHub 登录一般比 Google 顺利。

**重新部署后账号没了？**
没挂 Volume。挂一个到 `/data`，或者用「导出备份」先存一份 JSON，重新部署后「导入备份」。

**返回 `country_blocked` / 地区受限？**
freebuff 免费模型限美国出口 IP。Railway 的美国区一般没问题；不是美国区就换区域，或者给容器配代理。

**返回 429 / 额度用完？**
Premium 池是全账号 6 次 session/天（太平洋日，北京时间 15:00 前后重置）。多加几个号，或者把 key 的「付费模型」取消勾选、只用免费模型。

**账号突然全部失效？**
看控制台状态列：`token 失效` 重新登录就行；`已封禁` 是终态，官方不可恢复 —— 这是用这类代理的固有风险。

**内存占用？**
不开内置浏览器时常驻大约 60~90MB。开一次内置浏览器会临时多 300~500MB，闲置 10 分钟自动关闭。Railway 免费额度够用，但别一直挂着浏览器。

---

## 八、风险与许可

- 本项目基于 [pingmike2/freebuff2api-wokers](https://github.com/pingmike2/freebuff2api-wokers)（AGPL-3.0）二次开发，同样以 **AGPL-3.0** 开源，保留原作者版权声明
- 通过逆向协议代理 freebuff/codebuff，**违反其服务条款**，账号存在被永久封禁的风险，**后果自负**
- 仅供技术研究和个人自用，别拿去商用或者大规模滥用
- 管理控制台一定要设强密码：拿到密码等于拿到你所有账号的 token
