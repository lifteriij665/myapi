# myapi

把 [freebuff2api-wokers](https://github.com/pingmike2/freebuff2api-wokers) 的引擎搬到 **Railway**，外面套一层**带密码的网页控制台**：

- 🔐 **输入管理员密码解锁**，进主页就能管号池，不用改环境变量、不用重新部署
- 🌐 **在网页里直接登录加号**：走官方 CLI 那条授权码链路，点一下按钮就跳登录页，服务器轮询到 token 自动入池。**不需要 Telegram 机器人，不需要本地跑脚本**
- 🖥️ **还带一个服务器内置浏览器**：容器里跑 patchright Chromium（headful + Xvfb，指纹接近真机），画面用 CDP 截屏推到网页上，你可以在网页里点、打字，直接在服务器上完成登录
- 🧩 **两个上游合成一个号池**：除了 freebuff，还接了 **[opencode Zen](https://opencode.ai/zen)**（`https://opencode.ai/zen/v1`）。Zen 的号就是一个 API key，粘进来就能用，**默认只跑它的免费模型**；一个 Zen 号都没有时还能用官方 CLI 的 `public` 匿名凭证直接调免费模型
- 👥 **多账号号池**：每个号可以设"全部模型 / 仅免费 / 付费优先"，付费模型只会落到允许的号上
- 💳 **模型分免费和付费**：每个 API key 一个「允许付费模型」勾选框，不勾就只给免费模型，Premium 那几次/天的额度不会被误烧
- 🔑 **多 API key**：分客户端发 key、单独停用、看调用次数
- 📊 **用量统计**：请求数、token 数、耗时分位、首字延迟、按模型/按 Key/按账号/按上游拆分，48 小时柱状 + 30 天曲线，页面靠 SSE 自己刷新，不用手动点
- 💾 **聊天记录留存**（默认关）：打开后每次请求的消息和回复按 JSONL 落盘，可下载，自用复盘或者拿去训练
- 🧹 **分级清理**：日常（只删记录和缓存）/ 清除不必要数据（再加用量统计）/ 全部清理（连账号和 Key），清之前先给你看每一类占了多少
- 📋 **一键复制**：Base URL、API key、完整配置，复制完直接粘到 Cherry Studio / ChatGPT-Next-Web / one-api 里

对外接口和原项目一致：`/v1/chat/completions`、`/v1/models`、`/v1/responses`、`/v1/messages`（Anthropic 协议）、`/healthz`。
两个上游的模型合并成一张表对外给出去，opencode 那边的 id 统一带 `opencode/` 前缀（例如 `opencode/mimo-v2.5-free`），不会和 freebuff 的 `厂商/模型` 撞车。

> 引擎文件 `vendor/worker.js` 原样引用上游（当前 **1.8.10**）、**一行没改**，方便随时 `npm run update-worker` 升级。所有新增能力都在 `src/` 这一层，控制台「模型」卡里会显示当前引擎版本。
> opencode Zen 那条路**不经过** `vendor/worker.js`，是 `src/opencode.js` 直接发 HTTPS。

## 控制台长什么样

概览：号池状态一条一条排开（灯 = 存活状态，条 = 额度用了多少），下面是可以直接复制的接入信息。

![概览](docs/console-overview.png)

账号池：每个号单独设「用途」，一键 0 消耗探活，额度快照直接显示。

![账号池](docs/console-accounts.png)

内置浏览器登录：服务器上的 Chromium 画面推到网页里，鼠标键盘都转发过去，在这儿点「Continue with Google」就能把号加进池子。

![内置浏览器](docs/console-browser-login.png)

模型：按上游额度池自动分成免费 / 付费，可以手动改分类、也可以直接下架某个模型。

![模型](docs/console-models.png)

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

### 4. 选区域（别忘了这一步）

服务 → **Settings** → **Scale** → **Regions & Replicas**，选一个**美国**区域（US West / US East）。

freebuff 的免费模型对出口 IP 有美国限制，部在欧洲或亚洲区大概率拿到 `country_blocked`（控制台的账号状态会显示「地区受限」）。

**副本数保持 1。** 挂了 Volume 的服务本来就不允许多副本；而且多副本各自维护自己的 session 缓存和登录流程状态，会重复创建 session 白烧额度、也会让「网页内登录」在轮询时打到另一个副本上失败。

> `railway.json` 里**故意没有写** region 和 numReplicas —— 一旦写进去，面板上这两个控件就会被锁成「The value is set in /railway.json」，只能改文件重新部署。留在面板里改更方便。

### 5. 开公网域名

服务 → **Settings** → **Networking** → **Generate Domain**，拿到 `xxx.up.railway.app`。

浏览器打开这个域名 → 输入管理员密码 → 进主页。

---

## 二、第一次用：三步跑通

### 第 1 步：加账号

主页点 **「+ 添加账号」**，四种方式挑一种（前三种是 freebuff，第四种是 opencode Zen）：

| 方式 | 怎么用 | 什么时候用 |
|---|---|---|
| **① 授权链接**（推荐） | 点「生成授权链接」→ 自动开新标签 → 用 Google / GitHub 登录 → 回到控制台，状态自动变成"登录成功" | 默认就用这个，最稳。登录动作发生在**你自己的浏览器**里，不会被判定成自动化 |
| **② 服务器内置浏览器** | 点「启动浏览器并打开登录页」→ 网页里出现服务器浏览器的画面 → 在画面里点按钮、用下面的输入框打字完成登录 | 你本地网络打不开上游、或者想让登录动作从服务器出口发生 |
| **③ 手动粘贴 token** | 把已有的 `authToken` 贴进去，支持一次贴多行 | 从别的部署 / `extract_freebuff.py` 迁移过来 |
| **④ opencode Zen** | 两条路：自己去 <https://opencode.ai/zen> 登录后复制 API key 粘进来；或者点「用内置浏览器登录」，在服务器浏览器的画面里登录，再把 key 复制到旁边的框 | 想用 Zen 那批免费模型（`mimo-v2.5-free`、`big-pickle`、`nemotron-*-free` 等） |

加完可以点「检测」：freebuff 的号做 **0 消耗探活**（只读 `GET /api/v1/freebuff/session`，不创建 session、不扣额度）；opencode 的号用一个免费模型发 1 token 的最小请求探活（上游没有查余额的接口，这是唯一能确认 key 有效的办法）。两边都能看出存活 / key 失效 / 被封 / 地区受限 / 额度用完。

**opencode 的号为什么没有"登录"按钮**：Zen 没有 CLI 授权码那一套。`/auth/*` 是浏览器回调端点（GET 会回 `500 No authorization code found.`），也没有 `oauth-authorization-server` 发现文档，官方文档写的流程就是"网页登录 → 复制 API key → 粘进客户端"。所以这里只能把登录页开给你，key 还是得你复制一下。

### 第 2 步：拿 Base URL 和 key

主页最上面那张卡：

```
Base URL   https://你的域名/v1
API Key    sk-fb-xxxxxxxx
```

点「一键复制完整配置」直接粘到客户端里。想验证通不通，点「自检」——它会用当前号池真跑一次免费模型，把回复贴出来。

### 第 3 步：决定要不要给付费模型

「API Key」卡里每个 key 都有一个 **付费模型** 勾选框：

- **不勾（默认）**：`/v1/models` 只返回免费模型，请求付费模型直接 403，不会消耗号池的 Premium 额度（注意：`deepseek-v4-flash` 从 2026-08-18 起算付费，之后又被上游整个暂停）
- **勾上**：付费(Premium)模型也能用，会走号池里"全部模型 / 付费优先"的号

「模型」卡里能看到分类结果，也能手动把某个模型改成免费/付费、或者直接下架不对外提供。

---

## 三、免费和付费是怎么分的

先说清楚：这里的「付费」**不是要你花钱**。上游把免费账号能用的模型分成几个额度池，
「付费」指的是"这一次调用会烧掉那个稀缺的共享额度"。官方源码里那句原话是
*"the SHARED daily premium pool, which every full-access account is granted for free"*
—— 池子是免费送的，只是量少。

分类数据**直接解析上游官方常量源码**（`CodebuffAI/freebuff` 的 `freebuff-models.ts` /
`free-agents.ts`），拉不到才回落到第三方生成的 JSON、最后是仓库里随包的副本。
控制台「模型 → 列表怎么来的」会写明当前用的是哪一档，以及上游当前的真实额度数字。

> 为什么不只用第三方那份 JSON：它的 `releases/latest/download` 地址在部分网络下会超时，
> 一超时就回落到 jsDelivr 上的**仓库文件**，而那份可能落后好几天 ——
> 2026-08-18 上游把 `deepseek-v4-flash` 挪进 premium 池，旧表里它还是免费的，差别很致命。

| 池 | 本项目分类 | 实际限制（跟着上游常量动态显示） |
|---|---|---|
| `premium` | **付费** | 全账号共享 **4 次 session/天**（2026 年从 5 砍到 4），太平洋日切换 |
| `deepseek/*` | **付费**（更紧） | Flash 和 Pro **共用每天 1 次 session**，而且这一次还照样扣 premium 额度 |
| `standard` | 免费 | 非 premium 那一档，CLI 协议下不限量 —— 目前只有 `mimo/mimo-v2.5` |
| 限量试用 | 免费但会消失 | `claude-fable-5` 这类，上游全局池放多少算多少，池子空了模型就整个消失 |
| `glm` | 免费（需资格） | 独立额度池，要官方 referral / streak |
| 表里没有的新模型 | 默认按**付费** | 保守策略，确认是免费的话在「模型」卡里改一下 |

**2026-08-18 的变动很重要**：Flash 一直是"不占额度的那个"，那天被挪进 premium 池，
官方注释写明是 **TEMPORARY**，原因是它成了免费模式最大的成本项。同一段注释还写着
*"Unlimited is MiMo 2.5 while this holds"* —— 所以现在真正不限量的是 MiMo 2.5。
本项目「客户端不写 model 时用哪个」默认就自动挑当前不限量的那一档（而不是死写 Flash），
免得每个不带 model 的请求都去啃那每天 1 次的 DeepSeek 额度。

**列表实不实用**：光有上游模型表不代表你的号现在真能用它。控制台的「实测状态」列合并了四个信号：

- 引擎按上游"已暂停"名单屏蔽 → `上游已暂停`（可信度最高，见下）
- 真实请求成功 → `实测可用`
- 上游按模型本身拒绝（`unsupported_model`、`session_model_mismatch` 之类）连续两次 → `实测不可用`
- 0 消耗探活拿到的额度快照里出现过 → `上游有额度记录`

默认会把「实测不可用」的模型从 `/v1/models` 里藏掉（设置里可关），
免得客户端拿到一份"一半调不通"的列表。「上游已暂停」的一律藏掉，不受这个开关影响。

> `vendor/worker.js` 自己维护了一份"上游已暂停"名单（1.8.10 起会把这些模型从它的
> `/v1/models` 里滤掉、请求时直接回 `unsupported_model`）。本项目**不复制那份名单** ——
> 启动时问一次引擎的模型列表，跟自己的目录做差集就得到暂停集合，
> 以后 `npm run update-worker` 换了名单也自动跟上。请求这类模型会拿到 404 并说明原因，
> 而不是让你对着一句 `unsupported_model` 猜。

**号池用途**（每个账号一个下拉框）：

- `全部模型`（默认）：免费和付费都能用它
- `仅免费`：只承接免费模型，Premium 额度留着
- `付费优先`：付费模型优先落到它头上

### opencode Zen 那半张表

Zen 的免费/付费是**明码标价**的（就是"要不要花你自己的钱"），跟 freebuff 那套额度池完全是两回事：

| 分类 | 模型 | 说明 |
|---|---|---|
| **免费**（8 个） | `big-pickle`、`mimo-v2.5-free`、`hy3-free`、`nemotron-3-ultra-free`、`nemotron-3.5-lightning-free`、`deepseek-v4-flash-free`、`laguna-s-2.1-free`、`muse-spark-1.2-contributor-free` | 不花钱。**没有 key 也能调**（走官方 CLI 的 `public` 匿名凭证，上游按出口 IP 限流） |
| **按量计费** | `claude-*`、`qwen*`、`glm-*`、`minimax-*`、`kimi-*`、`deepseek-v4-pro/flash` 等 | 真的扣你 Zen 账户余额，必须在 key 上勾「允许付费模型」 |

几个实测出来的坑，都已经在代码里处理掉了：

- **`big-pickle` 是免费的，但名字里没有 `free`。** 参考实现只按名字判断，会把它当付费。这里用显式名单 + 名字兜底两层判断。
- **`muse-spark-1.2-contributor-free` 会回 `403 RegionError`**（上游按地区限制）。控制台里标成"当前地区不可用"，默认不列给客户端。
- **必须带 `x-opencode-*` 那组请求头**。只带 `Authorization` 的话免费模型会被当成普通匿名流量，直接 `429 FreeUsageLimitError`；补上 `User-Agent: opencode/…`、`x-opencode-client: cli` 和 `ses_`/`req_`/`prj_` 三个 id 之后同一个请求就是 200。会话 id 按第一条 user 消息哈希，多轮对话里保持稳定。
- **Zen 是按模型钉协议的，不是按端点。** chat 原生的模型（免费的全是）POST 到 `/v1/messages` 或 `/v1/responses` 一律回 `400 Input required`。所以本项目按模型的原生协议选端点，客户端协议对不上时在网关这层翻一次 body、回来再翻一次响应（`src/anthropic-bridge.js`，两个方向都覆盖文本 / system / 多轮 / tools / stop 原因 / usage / 流式）。**结果就是 Anthropic 客户端（Claude Code 这类）也能直接用 Zen 的免费模型。**
- **`gpt-*` / `grok-*` / `muse-*` / `gemini-*` 暂时不承接**：它们的原生协议是 OpenAI Responses 和 Google `generateContent`，这两套 body 格式还没实现。控制台里标成"协议未实现"并写清原因，也不会列进 `/v1/models`（列出去只会让客户端拿到一个必然 400 的 id）。63 个模型里目前对外提供 32 个。
- **401 不一定是 key 错了**：Zen 把余额耗尽、月度上限、模型被工作区管理员停用也都回 401。控制台按上游的 `error.type`（`AuthError` / `CreditsError` / `RegionError` / `FreeUsageLimitError` …）分类，不靠在正文里捞字符串。
- **`GET /zen/v1/models` 免鉴权**，所以一个 Zen 号都没有也能拉到完整模型表；拉不到就退回随包的免费名单，不会让控制台里一个 opencode 模型都不剩。

## 三点五、账号怎么切（不轮询）

默认策略是**钉住一个号用到失败为止**，不是轮询：

- 每个请求只把**一个** token 交给引擎，所以引擎内部那套轮询逻辑等于被关掉了
- 只有当前这个号真的失败了（额度用完 / token 失效 / 上游拒绝 / 超时），才顺延到下一个号，并把新号钉住
- 顺延时会把失败原因写回控制台的状态列，`x-myapi-accounts-tried` 响应头里能看到这次试过哪些号
- 这样比轮询省额度：freebuff 是**按创建 session 计费**的，一个 session 能用约 1 小时，钉住同一个号就能把这一小时用满

控制台「设置 → 账号切换」里有两个开关：

| 设置 | 行为 |
|---|---|
| **自动切换账号**（默认开） | 当前号失败才换下一个；换完的号会成为新的"当前号" |
| 关掉自动切换 | **只用**你指定的那个号，它不可用时请求直接返回 503，绝不偷偷换号 |
| **当前使用的账号** | 手动指定从哪个号开始用；留空＝下一次请求自己挑第一个可用的 |

「账号池」里每行都有「设为当前」按钮，概览的通道条上当前那个号会标 `当前`。

**两个上游各排各的队**：选号第一步先按"这个模型属于哪个上游"筛，`opencode/` 的模型只会落到 opencode 的号上，反之也一样。而且这一步在"全被标记失效时仍然放行"那条兜底逻辑**之前** —— 不然一边的号全挂了，兜底会把另一边的号捞过来，拿着错的凭据去撞上游。opencode 的免费模型还多一条：号池里一个 opencode 号都没有时，会退到 `public` 匿名凭证（`OPENCODE_ANONYMOUS=false` 可关），响应头 `x-myapi-rotation: anonymous` 会标出来。每个响应都带 `x-myapi-provider`，能看出这一次走的是哪个上游。

---

## 三点六、用量统计 / 聊天记录 / 存储清理

### 用量统计（控制台「用量」）

每个走 `/v1` 的请求都会记一条，包括被门禁拒掉的（能看出客户端在撞什么墙）：

- 时间、模型、走的哪个 Key、落到哪个账号、协议（OpenAI / Anthropic / Responses）、是不是流式
- HTTP 状态、失败原因、总耗时、**首字延迟**（流式才有）、请求/响应字节数
- token：输入 / 输出 / cache 读写 / reasoning。上游没报 usage 时按正文长度粗估，
  这类会标 `*`，统计里也单独算「估算条数」，不会跟实测数字混在一起

展示分三层：**读数块**（5 分钟 / 本小时 / 24 小时 / 今天 / 累计 / 流式占比 / 最慢一次）、
**48 小时柱状图**（绿=成功、红=失败）、**按模型 / 按 Key / 按账号** 的分布表，
最下面是**实时明细流**。页面通过 SSE 每 2 秒自己更新，不用手动刷新。

两个实现上的取舍，看数字时需要知道：

- 分钟级窗口和分位数（p50/p95）来自内存里的最近 3000 条明细，**重启会清空**
- 小时/天/累计/按模型这些来自落盘的分桶聚合，**重启后还在**，所以"本小时"和"今天"永远对得上

### 聊天记录（默认关）

打开后每次请求的消息和模型回复都会追加到 `<数据目录>/chatlog/chat-YYYY-MM-DD.jsonl`，
一行一条 JSON，直接就能喂训练脚本。控制台能看最近记录、按天下载、一键清空。

- **默认关闭**，要显式打开 —— 它会把你和模型说过的每句话都明文落盘
- 总容量默认 200MB，**写满就停止记录**（不自动删旧的：那可能正是你要的数据）
- 单条默认上限 256KB，超了截断并打 `truncated` 标记

### 存储清理（控制台「设置 → 存储清理」）

先给你看每一类占了多少、磁盘还剩多少，再选力度：

| 档位 | 删什么 | 留什么 |
|---|---|---|
| **日常清理** | 聊天记录、内置浏览器 profile、临时/损坏文件 | 用量统计、账号、Key、设置 |
| **清除不必要数据** | 上面那些 + 用量统计 + 账号状态快照 | 账号、Key、密码、设置 |
| **全部清理** | 再加上账号池、API Key、设置（会自动补一个新 Key） | **只留管理密码和签名密钥** |

全部清理要在弹窗里手输 `DELETE` 才会执行。管理密码永远不动 —— 清完还得能登进来。
清之前建议先「导出备份」。

## 四、环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ADMIN_PASSWORD` | 随机生成并打印到日志 | 控制台解锁密码。**在控制台改过密码后，这个变量里的密码依然有效**（防止把自己锁在外面），不想要就删掉这个变量 |
| `DATA_DIR` | `/data`（挂了 Volume 就用 Volume 路径） | 数据文件目录 |
| `PORT` | Railway 自动注入 | 监听端口 |
| `FREEBUFF_API_KEY` | 首次启动自动生成 | 预置第一个 API key |
| `FREEBUFF_TOKEN` | 空 | 预置账号 token，逗号或换行分隔（一般不用，控制台加号更方便） |
| `OPENCODE_API_KEY` | 空 | 预置 opencode Zen 的 API key，逗号或换行分隔。加进来的号默认只服务免费模型 |
| `OPENCODE_ANONYMOUS` | `true` | 号池里没有 opencode 号时，是否用官方 CLI 的 `public` 匿名凭证调 Zen 的免费模型。上游按出口 IP 限流，共享 IP 上容易 429 |
| `OPENCODE_API` | `https://opencode.ai/zen/v1` | Zen 的接口地址，一般不用改 |
| `ALLOW_PAID_DEFAULT` | `false` | 新建 API key 时「允许付费模型」的默认值 |
| `ENABLE_BROWSER_LOGIN` | `true` | `false` = 关掉内置浏览器（也不再用 Xvfb 启动） |
| `BROWSER_HEADLESS` | `auto` | `auto` = 有 Xvfb 就 headful（指纹更好），没有就 headless |
| `BROWSER_PROXY` | 空 | 内置浏览器走代理，如 `http://user:pass@host:port`、`socks5://host:1080` |
| `BROWSER_LOCALE` / `BROWSER_TIMEZONE` | `en-US` / `America/Los_Angeles` | 内置浏览器的语言和时区 |
| `BROWSER_IDLE_TIMEOUT_MS` | `600000` | 没人看画面多久后自动关浏览器省内存 |
| `SCREENCAST_QUALITY` | `55` | 推流 JPEG 质量，网络差可以调低 |
| `SESSION_TTL_HOURS` | `168` | 控制台登录状态保留多久（非法值会回落到默认） |
| `TRUST_PROXY_HOPS` | `1` | 前面有几层可信代理。限流按 `X-Forwarded-For` **最右边这几跳**取 IP，左边是客户端能伪造的 |
| `PUBLIC_BASE_URL` | 空 | 强制指定对外地址（绑了自定义域名时填它）。不填时用 Railway 域名，Host 头对不上就不认 |
| `MAX_BODY_MB` | `8` | 单个 API 请求体上限 |
| `MAX_INFLIGHT_API` | `32` | 同时处理多少个 `/v1` 请求，超了返回 503 |
| `MAX_BROWSER_SESSIONS` | `2` | 同时最多开几个内置浏览器（一个 Chromium 几百 MB） |
| `BROWSER_ALLOW_PRIVATE` | `false` | 允许内置浏览器访问内网/元数据地址（默认拦掉，防 SSRF） |
| `LOGIN_THROTTLE_MS` | `2000` | 全局登录失败偏多时，每次尝试的延迟 |
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
| — | `/`、`/admin/api/*` | 控制台（密码鉴权），含 `GET /admin/api/events`（SSE 实时推送） |

```bash
curl https://你的域名/v1/chat/completions \
  -H "Authorization: Bearer sk-fb-你的key" \
  -H 'content-type: application/json' \
  -d '{"model":"mimo/mimo-v2.5","messages":[{"role":"user","content":"你好"}]}'
```

用 opencode Zen 的免费模型（一个 Zen 号都没有也能跑，会走匿名凭证）：

```bash
curl https://你的域名/v1/chat/completions \
  -H "Authorization: Bearer sk-fb-你的key" \
  -H 'content-type: application/json' \
  -d '{"model":"opencode/mimo-v2.5-free","messages":[{"role":"user","content":"你好"}]}'
```

Anthropic 协议同样能用 Zen 的免费模型（网关会自动翻协议）：

```bash
curl https://你的域名/v1/messages \
  -H "x-api-key: sk-fb-你的key" \
  -H 'anthropic-version: 2023-06-01' \
  -H 'content-type: application/json' \
  -d '{"model":"opencode/mimo-v2.5-free","max_tokens":64,"messages":[{"role":"user","content":"你好"}]}'
```

响应头里有三个自定义字段方便排查：`x-myapi-provider`（这次走了哪个上游）、`x-myapi-rotation`（`sticky` / `manual` / `anonymous`）、`x-myapi-model-tier`（免费还是付费）。

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
npm run update-worker   # 拉上游最新 worker.js + 模型表（多镜像 + 重试 + 内容校验）
npm run check           # 语法/导入自检
npm test                # 102 项单测 + 72 项集成测试（会自己起一个临时服务）
```

---

## 六点五、安全上做了什么

这一层是自己写的，所以专门做过一轮审计并修掉了下面这些。列出来是为了让你知道**哪些已经堵了、哪些堵不了**。

**管理后台**

- 密码用 scrypt（异步，走线程池 —— 同步版会让并发爆破把事件循环卡死，连 `/healthz` 都超时）
- 登录限流：按 IP 硬拦（10 次/10 分钟）+ 全局软限速（超阈值后每次尝试延迟 2 秒）。**先记账再验证**，避免并发一次爆发全部通过检查；取 IP 用 `X-Forwarded-For` 最右边那跳，伪造左边绕不过去。全局那道故意只延迟不拒绝，否则攻击者一直打就能把你自己锁在外面
- 会话是 HMAC 签名 cookie + **世代号**：改密码、点「登出所有设备」都会让已发出的 cookie 立刻失效（即使你配了固定的 `SESSION_SECRET`）
- 改密码必须带当前密码（只偷到一份 cookie 的人不能把你锁死），新密码至少 10 位且不能纯数字
- cookie 是 `SameSite=Strict` + `HttpOnly`；写请求校验 `Origin` 和 `Sec-Fetch-Site`
- 首次启动自动生成的那个密码会明文打进部署日志 —— 一旦你配上 `ADMIN_PASSWORD`，它会在下次启动时**自动作废**（否则日志里那个密码永久有效）。控制台「设置 → 访问」里能看到当前有几种可用凭证
- 「导出备份」是 POST（GET 会被恶意页面用顶层跳转触发，而备份里是明文 token）

**对外 API**

- 模型门禁对**不带 `model` 的请求也生效**（否则省掉这个字段就绕过了 key 白名单和已下架模型）；判定用的模型 id 会写回转发给引擎的请求体，避免"按免费判定、按付费执行"
- 停用的 key 和不存在的 key 返回完全一样的 401（不给"这个 key 存在"的探测口），认证失败按 IP 限流
- 错误响应只给归类结论（额度用完 / token 失效 / 上游拒绝），不回上游原文、不回账号邮箱；完整信息只进服务端日志和控制台
- 上游响应头**白名单**透传，`set-cookie`、`access-control-*` 一律丢掉
- 请求体 8MB 上限（先看 `Content-Length`），同时在飞请求 32 个上限
- 客户端一断开就取消上游流 —— 不取消的话上游会把整段输出生成完，那条 session 也一直占着，等于让人用"发出即断"白烧你的额度
- 免费/付费分类的远端表**只允许收紧**：随包表里标成 Premium 的，远端说是免费也不放宽

**内置浏览器**

- 只允许打开公网 http(s)：`127.0.0.1`、`10.x`、`169.254.169.254`、`*.internal`、`file://`、`data:` 全部拦掉（不拦的话这个浏览器就是个以容器身份发请求的 SSRF 工具）
- 上游返回的登录链接也要过同一套校验，且必须是 https
- 同时最多 2 个会话；一次性 profile 用完就删；空闲 10 分钟自动关
- WebSocket 握手校验管理会话 + Origin；升级路径整体包了 try/catch（畸形 Cookie 之前能触发未捕获异常）

**还剩下的、你需要知道的**

- 容器以 root 跑、Chromium 带 `--no-sandbox`（容器里 root 起 Chromium 的常规做法）。它只用来开登录页，但这是真实的纵深防御缺口
- **管理密码等于一切**：拿到它就拿到号池里所有 token。用强密码，别复用
- 备份文件里是明文 token，导出后自己保管
- 单个 key 没有调用频率限制（引擎对上游本来就是串行 + 300ms 间隔，上游侧不会被打爆），key 泄露了就去控制台停用
- 这套东西本身违反上游 ToS，账号被封是固有风险，与这里的安全加固无关

---

## 七、常见问题

**Railway 部署后 Healthcheck 一直失败（`service unavailable`）？**
说明容器根本没起来，去 Deploy Logs 从上往下看第一条 `[entrypoint]` 之前有没有报错。启动脚本刻意不用 `set -e`，Xvfb 起不来也只会退化成 headless，不会拖垮服务；正常应该能看到这三行：

```
[entrypoint] Xvfb 就绪（DISPLAY=:99, pid=…）
[entrypoint] node v22.x · PORT=… · DATA_DIR=/data
[myapi] v1.0.0 已监听 :::8787
```

服务默认绑 `::`（IPv6 双栈，IPv4 也能进），绑不上会自动退回 `0.0.0.0`，两种情况日志里都会写清楚。

**内置浏览器里 Google 登录被拒？**
Google 对自动化浏览器有额外风控。patchright + headful(Xvfb) 已经把常见的自动化特征去掉了，但不保证 100%。遇到拒登直接换 **方式①**：在你自己的浏览器里授权，效果完全一样（token 是同一条链路拿到的）。GitHub 登录一般比 Google 顺利。

**重新部署后账号没了？**
没挂 Volume。挂一个到 `/data`，或者用「导出备份」先存一份 JSON，重新部署后「导入备份」。

**返回 `country_blocked` / 地区受限？**
freebuff 免费模型限美国出口 IP。Railway 的美国区一般没问题；不是美国区就换区域，或者给容器配代理。

**返回 429 / 额度用完？**
Premium 池目前是全账号共享 4 次 session/天，DeepSeek 家族另有每天 1 次的天花板（都按太平洋日切换，UTC+8 的 15:00 前后重置）。多加几个号，或者把 key 的「付费模型」取消勾选、只用免费模型。

**模型列表里有些模型根本调不通？**
上游模型表只说"官方有这个模型"，不代表你的号现在能用。两类情况：引擎已按上游"已暂停"名单屏蔽的（列表里标 `上游已暂停`，请求会拿到 404 说明原因），以及真实调用失败两次、且是模型本身被拒（不是额度或 token 问题）而被标成「实测不可用」的。这两类默认都不出现在 `/v1/models` 里。想把实测状态手动重来一遍就点「模型 → 清空实测状态」。

**为什么 Flash 也变成"付费"了？**
上游 2026-08-18 把 `deepseek-v4-flash` 挪进了 premium 池（官方注释写明是临时措施，因为它成了免费模式最大的成本项），而且 DeepSeek 家族另有"每天 1 次"的天花板；再往后它被上游整个暂停，引擎 1.8.10 已经把它从模型列表里滤掉。现在真正不限量的是 `mimo/mimo-v2.5`，也是「客户端不写 model」时的默认值。这不是分类错了，是上游改了 —— 控制台「模型 → 列表怎么来的」里能看到当前表的生成时间、引擎版本和真实额度数字。

**账号突然全部失效？**
看控制台状态列：`token 失效` 重新登录就行；`已封禁` 是终态，官方不可恢复 —— 这是用这类代理的固有风险。

**内存占用？**
不开内置浏览器时常驻大约 60~90MB。开一次内置浏览器会临时多 300~500MB，闲置 10 分钟自动关闭。Railway 免费额度够用，但别一直挂着浏览器。

---

## 八、关于第三方"中转检测"报告

拿 claude-detector 这类工具扫这个网关，会报一堆红色。分清楚哪些是真问题：

**上游行为，本项目改不了**

- **每个请求多出 ~418 个 input_token**：freebuff 服务端会自己注入一段产品级 system prompt（`You are Buffy, the strategic coding assistant.` 那一整段，含 thinking budget 和 identity 段落）。检测工具按"用户消息应该只有 5 个 token"算，于是报「input 虚高 6860%」「成本倍率 11.9」。这不是中转层加的东西，也不可能去掉 —— 上游用它做 free-mode 校验，删了直接 403。
- **模型自称 Buffy / 说自己由 Anthropic 训练**：同样来自上游那段 prompt，不是我们改写身份。
- **prompt caching、PDF 文档输入不支持**：上游没有这些能力。
- **`stop_sequences` / `max_tokens` 不生效**：参数原样转发了，但上游不认。中间层不做"猜着截断"——那会把 JSON 和工具调用切坏。要严格截断请在客户端做。

**本项目的问题，已经修了**

- Anthropic 响应的 `id` 现在保证是 `msg_` 前缀（之前是裸 UUID，严格的 SDK / 检测器会判 schema 不合规），流式的 `message_start` 也一起修正
- `usage` 补上 `cache_creation_input_tokens` / `cache_read_input_tokens`（恒为 0）
- Anthropic 响应加 `request-id` 头
- 请求体写错的情况现在返回 400（缺 `messages`、`model` 不是字符串、`max_tokens` 不是数字），不再拿去消耗一次 session
- Anthropic 端点上传一个根本不存在的模型返回 404 `not_found_error`；但 `claude-*` / `sonnet` / `opus` / `haiku` 这类名字仍然会被映射到免费模型（Claude 客户端要靠这个别名才能用）
- `/v1/messages/count_tokens` 和 `/v1/models` 不再要求号池非空（它们不碰上游）

**Railway 的问题：没有**

报告里 DNS / WHOIS / SSL 那几项取不到或者看着奇怪，是审计脚本在本机做域名解析拿到的结果，跟这个部署没关系。`x-railway-*` 响应头正常。

**检测工具自己的误判**

- 「Stream model 不含 claude → 疑似替换模型」：你请求的本来就是 `deepseek/deepseek-v4-flash`，这是个 Claude 专用检测器。
- 「真伪验证：存疑 · 逆向代理 · 96%」：这个判定是用来识别"假装官方 Anthropic API 的中转"的。本项目从来不假装是 Anthropic —— 它是 freebuff 的协议代理，被判成"逆向代理"是**描述正确**，不是缺陷。
- 多个探针写着 `探针异常: not enough values to unpack (expected 5, got 4)`：那是审计脚本自己解包报错，跟我们返回什么无关。

**这个分数自己会抖 ±10 分，别拿它做前后对比**

19 个探针里有 5 个（#12 模型身份指纹、#14 图像描述、#17 隐藏 prompt 检测这类）是**问模型一句话、再用关键词匹配它的回答**。回答是采样出来的，同一份代码连着跑两次结果就不一样。实测同一个部署、隔 9 分钟跑两次：

| 探针 | 权重 | 第一次 | 第二次 | 分数影响 |
|---|---|---|---|---|
| #17 隐藏 prompt 检测 | 3 | 0%（判"疑似注入"） | 100%（判"干净"） | +7.5 |
| #14 图像输入 | 2 | 100%（"A solid green image."） | 0%（"Bright full green."） | −5 |
| #12 模型身份指纹 | 2 | 40% | 0% | −2 |

模型只是把"绿色"换了个说法、把拒绝的措辞换了一版，分数就差了十几分。真正反映改动效果的是 #3 响应 Schema 合规：补上 `msg_` 前缀后从 88% → **100%**，`#1` 返回的 id 也从裸 UUID 变成了 `msg_…`。

另外报告里那 5 个写着 `探针异常: not enough values to unpack (expected 5, got 4)` 的探针（#4/#10/#16/#18/#19，合计占 40 份权重里的 10 份 = 25%），是**跑审计的脚本自己解包报错**，恒定 0 分且与网关返回什么无关 —— 想让总分有意义，先修那个脚本。

**结论**：这个分数衡量的是"像不像 Anthropic 官方直连"，不是"这个网关好不好用"。对本项目有意义的健康指标是：控制台的「运行自检」能不能过、账号存活率、额度快照、有没有 `country_blocked`。

## 九、风险与许可

- 本项目基于 [pingmike2/freebuff2api-wokers](https://github.com/pingmike2/freebuff2api-wokers)（AGPL-3.0）二次开发，同样以 **AGPL-3.0** 开源，保留原作者版权声明
- 通过逆向协议代理 freebuff/codebuff，**违反其服务条款**，账号存在被永久封禁的风险，**后果自负**
- 仅供技术研究和个人自用，别拿去商用或者大规模滥用
- 管理控制台一定要设强密码：拿到密码等于拿到你所有账号的 token
