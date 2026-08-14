# @db-client/server

云同步后端服务（Fastify 5 + MySQL 8 + JWT）。

服务端只搬运密文：客户端用主密码派生密钥做 AES-256-GCM 加密后再上传，服务端不掌握主密码，也无法解密任何一节数据。

## 接口

共 20 个端点。「认证」列含义：

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
| GET | `/admin/users` | JWT + admin | 列用户，`?limit=`（默认 50，**无上限**）`&offset=` |
| PATCH | `/admin/users/:id` | JWT + admin | 改 `role` / `planCode` / `status`（三次独立 UPDATE，无事务、无枚举校验、无审计） |
| POST | `/admin/users/:id/renew` | JWT + admin | 手动续费 `{planCode, period, provider?}`，`period` 为 `month` / `year` |

注意 admin 路径没有 `/api` 前缀，与其他路由不一致。

### Webhook 与健康检查

| Method | Path | 认证 | 说明 |
|---|---|---|---|
| POST | `/webhook/payment/:provider` | 公开 | 支付回调，签名走 `x-signature` 头 |
| GET | `/health` | 公开 | 返回 `{"status":"ok"}`，不探测数据库 |

> Webhook 当前**不做有效验签**：拿到的是 Fastify 解析后的 body，再 `JSON.stringify` 重建载荷，键序或空白一变签名必然不匹配。接真实支付商前需引入 `@fastify/raw-body` 取原始字节。目前仅 `manual` provider 可用，它的 `handleWebhook` 直接抛错。

### 错误响应

领域错误统一为 `{message, code}`，状态码映射见 `middleware/errorHandler.ts`：

| code | HTTP |
|---|---|
| `INVALID_CREDENTIALS`、`TOKEN_REUSE` | 401 |
| `USER_DISABLED`、`DEVICE_LIMIT_EXCEEDED`、`SUBSCRIPTION_EXPIRED`、`QUOTA_EXCEEDED` | 403 |
| `NOT_FOUND`、`VERSION_NOT_FOUND` | 404 |
| `CONFLICT` | 409 |
| 其他领域错误 | 400 |

非领域错误统一 500 `{"message":"Internal server error"}`，不回显内部细节。

例外：`GET /admin/users`、`GET /api/auth/sessions`、`GET /api/auth/tokens` 三个路由没有 try/catch，异常会落到 Fastify 默认处理器，可能回显底层报错信息。

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

已知缺口（部署前请评估）：

- **没有任何限流**。`/api/auth/login`、`/register`、`/refresh` 可无限尝试；scrypt 每次校验消耗十几毫秒 CPU，同时也是 DoS 放大面。生产环境请在反向代理层或引入 `@fastify/rate-limit` 补上。
- **PAT 无法用于认证**（见上文 PAT 小节）。
- **Webhook 验签不成立**（见上文 Webhook 小节）。
- **套餐功能门禁全在客户端**：`plans.features` 位掩码经 `/api/me` 下发，服务端不做校验，且客户端在网络失败时会放行。
- 旧 sha256 密码**永不升级**（`upgradePasswordIfNeeded` 无调用点），且其盐值取自 `JWT_SECRET`——轮换 JWT 密钥会让这批用户无法登录。
- Access token 无法提前吊销（无 jti/黑名单），改密后旧 token 最长仍可用 15 分钟。
- 容器以 root 运行，`docker-compose.yml` 把 3306 暴露到宿主。

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

compose 另外用到 `MYSQL_ROOT_PASSWORD`（默认 `rootpass`），仅用于 MySQL 容器初始化。
