# @db-client/server

云同步后端服务（Fastify 5 + MySQL 8 + JWT）。

服务端只搬运密文：客户端用主密码派生密钥做 AES-256-GCM 加密后再上传，服务端不掌握主密码，也无法解密任何一节数据。

## 接口

共 34 个 API 端点（不含 `/admin` 静态托管与 Fastify 给 GET 自动补的 HEAD）。「认证」列含义：

- **公开** — 无需任何凭据
- **JWT** — 需 `Authorization: Bearer <accessToken>`
- **JWT + admin** — 还需 token 里 `role === 'admin'`

### 认证与会话

| Method | Path | 认证 | 说明 |
|---|---|---|---|
| POST | `/api/auth/register` | 公开 | 注册。`email` 需含 `@`，`password` ≥ 8 位。成功 201，附带 14 天 `trialing` 订阅。邮箱重复返回 401（防用户枚举） |
| POST | `/api/auth/login` | 公开 | 登录。超出套餐 `maxDevices` 时 403 |
| POST | `/api/auth/refresh` | 公开 | 用 `refreshToken` 换新 token 对（轮换式）。检测到已撤销 token 被重用时，撤销该用户**全部**会话并返回 401 |
| POST | `/api/auth/logout` | JWT | 撤销请求体里的 `refreshToken` |
| POST | `/api/auth/change-password` | JWT | 改密后撤销全部会话 |
| GET | `/api/auth/sessions` | JWT | 列出本人活跃会话 |
| DELETE | `/api/auth/sessions/:id` | JWT | 撤销指定会话（非本人的会话返回 401） |

`register` / `login` / `refresh` 的响应除 `accessToken` / `refreshToken` 外，额外附带 `token` / `userId` / `role` 顶层字段，仅为兼容旧版客户端，新代码请读 `accessToken`。

三者都会读取 `x-device-name` 请求头与 `user-agent` / 来源 IP，记入会话列表。

### 账号信息

| Method | Path | 认证 | 说明 |
|---|---|---|---|
| GET | `/api/me` | JWT | 返回 `{user, plan, subscription, usage}`。顺带做一次到期降级检查 |

`usage` 中 `devices` / `syncBytes` / `pats` 为实时统计；`connections` 与 `history` 当前恒为 `0`（未接入统计）。

### 同步（按用户隔离，仅存密文）

| Method | Path | 认证 | 说明 |
|---|---|---|---|
| GET | `/api/sync` | JWT | 拉取。`?section=` 可选，省略则返回全部节 |
| PUT | `/api/sync` | JWT | 推送单节 `{section, encryptedData, baseVersion}`。乐观锁，版本冲突返回 409；超配额返回 403（**写库前**校验） |
| GET | `/api/sync/versions` | JWT | 列历史版本 `?section=`，条数上限取套餐的 `syncVersionRetention` |
| POST | `/api/sync/rollback` | JWT | 回滚 `{section, toVersion}`。同样前置配额校验，避免降级后借回滚绕过限额 |

`section` 取值：`groups` / `connections` / `queries` / `folders` / `history`。

### 个人访问令牌（PAT）

| Method | Path | 认证 | 说明 |
|---|---|---|---|
| GET | `/api/auth/tokens` | JWT | 列出本人未撤销的 PAT |
| POST | `/api/auth/tokens` | JWT | 创建 `{name, scopes}`，201 返回明文 token（**仅此一次**，库里只存 sha256） |
| DELETE | `/api/auth/tokens/:id` | JWT | 撤销（非本人的返回 404） |

> PAT 目前**只能签发、不能用于认证**：`middleware/requireAuth.ts` 只做 `jwtVerify()`，没有 PAT 分支，`scopes` 也未被强制。接入前不要把它当作可用的凭据。

### 管理员

| Method | Path | 认证 | 说明 |
|---|---|---|---|
| GET | `/admin/users` | JWT + admin | 列用户，`?limit=`（默认 50，上限 500）`&offset=` |
| PATCH | `/admin/users/:id` | JWT + admin | 改 `role` / `planCode` / `status`（三次独立 UPDATE，无事务、无审计；枚举有白名单校验） |
| POST | `/admin/users/:id/renew` | JWT + admin | 手动续费 `{planCode, period, provider?}`，`period` 为 `month` / `year` |
| GET | `/admin/traffic` | JWT + admin | 流量报表，`?hours=`（默认 24，上限 720）。返回按路由汇总 + 小时序列 + 最近 60 分钟实时序列 + 429 明细 |
| GET | `/admin/rate-limits` | JWT + admin | 列出限流桶（含默认值说明与是否被改过）与 IP 白名单 |
| PATCH | `/admin/rate-limits/:bucket` | JWT + admin | 改阈值 `{maxRequests?, windowSeconds?, enabled?}`，**立即生效，无需重启** |
| POST | `/admin/rate-limits/allowlist` | JWT + admin | 加免限流 IP `{ip, note?}` |
| DELETE | `/admin/rate-limits/allowlist/:ip` | JWT + admin | 移除免限流 IP |

注意 admin 路径没有 `/api` 前缀，与其他路由不一致。

### Webhook 与健康检查

| Method | Path | 认证 | 说明 |
|---|---|---|---|
| POST | `/webhook/payment/:provider` | 公开 | 支付回调，签名走 `x-signature` 头 |
| GET | `/health` | 公开 | 返回 `{"status":"ok"}`，不探测数据库 |

Webhook 传给适配器的是**原始请求体字节**（`req.rawBody`），不是 `req.body` 重新
序列化的结果 —— HMAC 逐字节计算，重建的 JSON 在键顺序、空白、Unicode 转义、
数字表示上都可能与原文不同，用它验签结构上就不可能通过。

实现方式是在 webhook 插件作用域内注册 `application/json` 的 content-type parser
（`parseAs: 'buffer'`），因此只影响 `/webhook/*`，`/api/*` 仍走默认 JSON 解析。
没有引入 `@fastify/raw-body`：那个插件默认全局生效，会给所有路由多留一份 body 副本。

> 目前仅 `manual` provider 可用，它的 `handleWebhook` 直接抛错（手动续费走
> `POST /admin/users/:id/renew`，不经 webhook）。接 Stripe / LemonSqueezy 时在
> 适配器里实现验签即可，路由层已经把原始字节备好。验签路径本身由
> `test/route/webhook.route.test.ts` 用一个真做 HMAC 校验的假 provider 覆盖。

### 管理后台页面

后台是独立的 Vue 3 单页应用，源码在 [`packages/admin-ui`](../admin-ui)，`vite build`
的产物直接输出到 `packages/server/public/`（该目录已 gitignore，不入版本控制）。

`route/adminUi.ts` 用 `@fastify/static` 托管它：

| Path | 说明 |
|---|---|
| `GET /admin` | 返回 `index.html`，带 `Cache-Control: no-store` |
| `GET /admin/*` | 静态资源（JS / CSS chunk），限流豁免 |

**页面本身是公开的**，任何人都能打开这个 HTML；数据全部由 `/admin/*` 的
API 端点保护（JWT + `role === 'admin'`），所以未登录时页面只能看到登录框。

启动前要先构建：`pnpm -C packages/admin-ui build`（或在仓库根跑 `pnpm build`）。
`public/` 不存在时 `/admin` 会 404，API 不受影响。

### 错误响应

领域错误统一为 `{message, code}`，状态码映射见 `middleware/errorHandler.ts`：

| code | HTTP |
|---|---|
| `INVALID_CREDENTIALS`、`TOKEN_REUSE` | 401 |
| `USER_DISABLED`、`DEVICE_LIMIT_EXCEEDED`、`SUBSCRIPTION_EXPIRED`、`QUOTA_EXCEEDED` | 403 |
| `NOT_FOUND`、`VERSION_NOT_FOUND` | 404 |
| `CONFLICT` | 409 |
| `VALIDATION_ERROR`、其他领域错误 | 400 |
| `RATE_LIMITED` | 429 |

非领域错误统一 500 `{"message":"Internal server error"}`，不回显内部细节。

`registerErrorHandler` 是全局兜底：漏写 try/catch 的 handler、schema 校验失败、
非法 JSON、404 全部走它，响应结构一致且不泄漏内部信息。429 单独一个分支 ——
限流插件是 `throw` 一个带 `statusCode: 429` 的 Error，若被通用 4xx 分支接住，
正文里的「多久后可重试」会被改写成 `Bad request`。

## 启动期行为

`createApp()`（`src/app.ts`）的顺序是**先建库、再注册连接池、最后建表**：

1. `ensureDatabase()` 用一条临时连接执行 `CREATE DATABASE IF NOT EXISTS`，随后立即关闭该连接。
2. `@fastify/mysql` 注册连接池，连接串**带 `database`**。
3. `app.ready()` 之后 `initSchema()` 建表、播种 `plans`、给旧表补列（全部幂等）。
4. 跑一次 `downgradeExpired()` 批量降级到期订阅（失败仅 warn）。

为什么建库必须早于池注册：`@fastify/mysql` 默认走 `mysql.createPool`，池中每条连接各自握手。若靠 `USE \`db\`` 选库，只有当时借出的那一条连接生效，其余连接没有默认库，并发起来会 `ER_NO_DB_ERROR`——顺序请求时因连接复用往往「看起来正常」，负载一上来才暴露。

两种失败情形：

- **账号无建库权限**：只记一条 warn 并假定库已存在（库通常由 DBA 预建）。
- **库确实不存在**：第 2 步池注册立即失败，进程启动即退出。这是有意为之——早于旧版「启动静默通过、首次查询才炸」。

`JWT_SECRET` 在 `NODE_ENV=production` 下缺失会在 `config.ts` 模块求值期直接抛错，同样是启动即失败。

订阅到期只有两个降级触发点：启动时的批量任务，以及 `GET /api/me` 里的懒检查。**没有定时任务**，且 `trialing` 到期没有任何降级路径。

## 安全

已实现：

- 服务端只存**加密后的数据体**（客户端主密码 PBKDF2 派生 + AES-256-GCM），服务端无解密能力
- 密码用 **scrypt + 每用户 16 字节随机盐**（`scrypt$salt$hash`），比较走 `timingSafeEqual`，兼容校验旧版 sha256 哈希
- Refresh token 256 位随机，仅存 sha256，轮换式发放并检测重用（重用即撤销全部会话）
- JWT 携带 `sub` / `role` / `plan`，`requireRole` 做 RBAC
- 业务 SQL 全部参数化（`?` 占位），仅建表 DDL 拼接常量标识符
- 响应统一剥离 `passwordHash` / `tokenHash`
- 全部端点挂 JSON Schema 校验；`registerErrorHandler` 兜住漏写 try/catch 的 handler
- 认证中间件每请求查一次 `users.status`/`role`，**封禁与降级即时生效**（不等 access token 过期）
- access token 可被**即时吊销**：token 里的 `sid` 是签发它的 refresh token 行 id，中间件每请求校验该会话未被撤销。于是登出 / 改密 / 踢设备 / token 重用检测都对已发出的 access token 立即生效，不需要 jti 黑名单
- 同步写入走乐观锁，**冲突判定精确**：`UPDATE ... WHERE version = base` 判 `affectedRows`，行不存在时仅接受 `base = 0`，并发首次写入靠唯一键裁决
- 按 IP 分桶限流，阈值可在后台实时调整（见下文「限流」）
- webhook 验签拿**原始请求体字节**，不是 `req.body` 的重新序列化结果

已知缺口（部署前请评估）：

- **`devices.ip` 的历史数据不可信**。该列取自 `req.ip`，而 `trustProxy` 是后来才加的 —— 在那之前落库的全是反向代理的地址，不是真实客户端 IP。
- **请求体上限 1MB**（Fastify `bodyLimit` 默认值，未调整）。`sync_sections.encrypted_data` 是 MEDIUMTEXT，理论上能存 16MB，所以连接数极多的用户 push 时可能被 413。`nginx.conf.example` 里 `client_max_body_size` 给的 2m 只是让 nginx 不成为更早的瓶颈，真正的上限仍在 server 侧。
- **`traffic_stats` / `traffic_blocked` 没有清理任务**。前者每天最多约 3200 行（27 路由 × 5 状态类 × 24 桶），这个量级下不值得再引入一个会出错的定时任务；后者只在被限流时写入，正常情况下应该接近空。真需要清理时手工 `DELETE ... WHERE create_time < ?` 即可。
- **PAT 无法用于认证**（见上文 PAT 小节）。
- **Webhook 验签不成立**（见上文 Webhook 小节）。
- **套餐功能门禁全在客户端**：`plans.features` 位掩码经 `/api/me` 下发，服务端不做校验，且客户端在网络失败时会放行。
- 旧 sha256 密码的盐取自 `JWT_SECRET`。这批用户**下次登录时会自动升级**到 scrypt（`authService.login` 调 `upgradePasswordIfNeeded`），但在升级发生前轮换 `JWT_SECRET` 会让他们无法登录。
- 容器以 root 运行，`docker-compose.yml` 把 3306 暴露到宿主。

## 反向代理

部署形态假定为 **nginx 反代 + server 只监听回环地址**。可直接用的配置见
`nginx.conf.example`。

`req.ip` 是限流的分桶键，也是 `devices.ip` 的来源，所以 `TRUST_PROXY` 取值
直接影响安全性。四种取值的实测行为（`test/trustProxy.test.ts` 把这张表钉成了断言）：

| `TRUST_PROXY` | nginx 覆写 XFF | nginx 追加 XFF + 客户端伪造 `1.2.3.4` |
|---|---|---|
| `false` | `127.0.0.1`（拿不到真实 IP） | `127.0.0.1` |
| `true` | `203.0.113.9` | **`1.2.3.4` — 可伪造** |
| `1`（默认） | `203.0.113.9` | `203.0.113.9` |
| `127.0.0.1` | `203.0.113.9` | `203.0.113.9` |

`true` 取 XFF **最左**段，而最左段完全由客户端控制 —— 攻击者每个请求换一个
伪造 IP 就能绕开所有按 IP 的限流。因此 `config.ts` **直接拒绝 `TRUST_PROXY=true`
启动**，并在报错里给出替代写法。

跳数 `1` 从右往左数，恒等于 nginx 自己写的那一段，所以 `$remote_addr`（覆写）
和 `$proxy_add_x_forwarded_for`（追加）两种 nginx 写法都安全。

两条部署要求：

- **server 不要把端口暴露到公网**。一旦可直连，客户端就能自带伪造的 XFF 头进来，`trustProxy: 1` 会信任它。
- **没有反向代理时必须设 `TRUST_PROXY=false`**，否则同上。

## 限流

按 IP 分桶，分桶键是 `${bucket}:${ip}`。

为什么只能按 IP：限流跑在根作用域的 `onRequest`，早于 `authScope` 里的
`jwtVerify`，那时 `req.user` 还是空的。而且真正需要挡的恰恰是未认证请求
（暴力登录、注册轰炸），它们本来就没有用户。

分桶表的键是 `METHOD 路由模板`，method 必须参与判定 —— `/api/sync` 上 GET 是读、
PUT 是写，共用同一个模板。

| 桶 | 覆盖端点 | 默认阈值 |
|---|---|---|
| `auth-strict` | `POST /api/auth/login`、`/register`、`/change-password` | 20 / 5min |
| `auth-refresh` | `POST /api/auth/refresh` | 120 / 5min |
| `sync-write` | `PUT /api/sync`、`POST /api/sync/rollback` | 1200 / 1min |
| `admin` | `/admin/*` API | 600 / 1min |
| `default` | 其余端点（含 `GET /api/sync`） | 1200 / 1min |
| 豁免 | `/health`、`/admin/*` 静态资源 | 不限流 |

这张表是手写字符串，没有编译期约束 —— 拼错一个键不报错，只会让那个桶恒不命中
并静默退化到 `default`。`test/ratelimit/routeCoverage.test.ts` 用 `onRoute` 钩子
从真实 app 实例抓路由表来比对，守住这件事。

**阈值的来源不是拍脑袋**。一次客户端自动同步 = 7 个请求（1 个 `GET /api/sync`
+ 5 个 `PUT /api/sync`，因为 `SECTION_TYPES` 有 5 个 section 且逐个推
+ 1 个 `POST /api/usage`）。`dbclient.sync.auto=silent` 时防抖 3 秒触发一次，
所以单设备峰值约 **140 req/min**。`sync-write` 的 1200 留了约 8 倍余量给共用出口 IP。

于是阈值分两类：`auth-*` 定得紧（合法流量一天几次，而 scrypt 每次十几毫秒 CPU，
既是暴力破解面也是 DoS 放大面）；`sync-write` / `default` 只是 DoS 天花板，
真正的收紧要等 `traffic_stats` 攒出真实数据。

### 调整阈值

代码内置基线（`ratelimit/rules.ts` 的 `DEFAULT_RULES`）+ DB 覆盖（`rate_limit_rules`
表只存**与默认值不同**的行）+ 内存权威值。

- 在 `/admin` 后台的 **Limits** 标签页改，写 DB 同时更新内存，**立即生效，无需重启**
- 表为空时限流照常按代码默认值工作 —— 全新部署不需要播种数据
- **DB 读失败时回落到默认值并记 warn**，限流不会因为 MySQL 抖动而失效
- 单实例下内存即权威值：没有 TTL 缓存、没有每请求查库、没有陈旧窗口。多实例部署会打破这个假设，那时应该换 Redis store 而不是给这里加轮询

### 共用出口 IP

多个用户在同一间办公室时按 IP 分桶会把整个办公室算成一个人。这是按 IP 限流的
固有缺陷。处理方式是把那个出口 IP 加进 `rate_limit_allowlist`（后台可加），
而不是把全局阈值调到形同虚设。

判断依据在后台 **Traffic** 标签页的「Rate limited requests」表 —— 429 会带
IP / 路由 / 桶名逐条落库（`traffic_blocked`），合法用户出现在里面就说明该放宽了。

### 逃生通道

阈值配错把所有人（含管理员）锁在门外时，后台本身也进不去，改不了 DB。这时设
`RATE_LIMIT_ENABLED=false` 并重启，完全绕过限流。这个开关不依赖 DB 也不依赖后台。

## 流量观测

两层数据，用途不同：

- **最近 60 分钟，分钟粒度** —— 纯内存环形缓冲（60 槽，`minuteTs % 60` 作索引，槽被复用时自动重置，无需清理逻辑）。进程重启即丢，这是有意的取舍：实时曲线的价值在即时性。
- **历史，小时粒度** —— `traffic_stats` 表，采集器在内存攒 60 秒后批量 upsert（`count = count + VALUES(count)`，累加而非覆盖）。

`route` 列存的是 Fastify 的**路由模板**（`/admin/users/:id`）而不是实际路径 ——
后者基数无界，一万个用户就是一万个 route 值。404 归 `__unmatched__` 桶（路由
探测扫描不会撑爆表），静态资源归 `__static__`。

flush 失败时数据会**合并回**采集器下个周期重试（不是覆盖 —— drain 之后新请求
仍在写入，覆盖会静默丢掉这段数据）。flush 定时器已 `unref` 且在 `onClose` 里
`clearInterval` + 做最后一次落库，否则进程收到 SIGTERM 不会退出。

## 启动

```bash
cp .env.example .env   # 至少填 MYSQL_PASSWORD 与 JWT_SECRET
docker compose up -d
curl localhost:3000/health   # 期望 {"status":"ok"}
```

compose 会创建 MySQL 容器并由官方镜像初始化 `dbclient` 用户（`MYSQL_USER` / `MYSQL_PASSWORD`），该用户自动获得 `db_client` 库的全部权限。

> **数据卷已存在时新增用户不生效**。MySQL 官方镜像只在**首次初始化空数据目录**时创建 `MYSQL_USER`。若你的 `mysql-data` 卷是早于该配置创建的，server 会因认证失败起不来。两种处理方式：
>
> ```bash
> # 方式一：手工建用户（保留数据）
> docker compose exec mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" \
>   -e "CREATE USER IF NOT EXISTS 'dbclient'@'%' IDENTIFIED BY '<你的密码>';
>       GRANT ALL PRIVILEGES ON db_client.* TO 'dbclient'@'%'; FLUSH PRIVILEGES;"
>
> # 方式二：重建卷（会丢失库内全部数据，仅适合本地开发）
> docker compose down -v && docker compose up -d
> ```

不带 compose 单独跑：

```bash
docker build -t dbclient-server -f packages/server/Dockerfile ../..
docker run -e JWT_SECRET=xxx -e MYSQL_HOST=xxx -e MYSQL_PASSWORD=xxx -p 3000:3000 dbclient-server
```

本地开发（需自备 MySQL）：

```bash
pnpm dev        # tsx watch
pnpm test       # vitest，116 用例，用内存假仓储，不依赖真实 MySQL
pnpm typecheck
```

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `3000` | 服务端口 |
| `JWT_SECRET` | `dev-secret-change-me`（仅非生产） | JWT 签名密钥。`NODE_ENV=production` 下缺失会导致启动失败。同时用作旧 sha256 密码的盐，**轮换会使旧密码用户无法登录** |
| `ACCESS_TOKEN_EXPIRES_IN` | `15m` | Access token 有效期。格式 `\d+[smhd]`，解析失败会静默回落 30 天 |
| `REFRESH_TOKEN_EXPIRES_IN` | `30d` | Refresh token 有效期，同上格式要求 |
| `MYSQL_HOST` | `127.0.0.1` | MySQL 地址 |
| `MYSQL_PORT` | `3306` | MySQL 端口 |
| `MYSQL_USER` | `dbclient` | MySQL 用户 |
| `MYSQL_PASSWORD` | 空串 | MySQL 密码（空串也会放行，无必填校验） |
| `MYSQL_DATABASE` | `db_client` | 数据库名，不存在则尝试创建 |
| `CORS_ORIGIN` | — | 仅生产生效：未设置则拒绝所有跨域（`origin: false`）。非生产恒为 `origin: true` |
| `NODE_ENV` | — | 设为 `production` 时启用 `JWT_SECRET` 必填与 CORS 白名单 |
| `TRUST_PROXY` | `1` | 信任几跳代理，决定 `req.ip`。`false`/`0` = 不信任（直连部署必须设这个）；纯数字 = 跳数；也可填代理地址或 CIDR。**`true` 会被拒绝启动**，因为它取客户端可控的 XFF 最左段，见「反向代理」小节 |
| `RATE_LIMIT_ENABLED` | `true` | 设为 `false` 完全关闭限流。逃生通道：阈值配错锁住所有人（含管理员）时用它 |

compose 另外用到 `MYSQL_ROOT_PASSWORD`（默认 `rootpass`），仅用于 MySQL 容器初始化。
