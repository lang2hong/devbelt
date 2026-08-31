# @db-client/server

**DB Client 后端**（Fastify 5 + MySQL 8 + Ed25519 + Argon2id）。

V3 Greenfield 重构的 Phase 1 全部切片（1–5）已落地：个人空间、邮箱验证、登录/刷新、设备与会话、组织与成员、邀请与容量、组织目录与资源。个人 E2E 同步、动态权限映射、受限协作、商业与运营、账号生命周期、组织暂停、组织内容加密均为暂缓专项模块，尚未实施（须先过 §8 专项设计）。

> 契约权威见 [docs/v3/实施规格](../../docs/v3/实施规格.md)。历史 V1/V2 文档仅背景，不能作为实现依据。

## 数据模型（Phase 1）

| 表 | 说明 |
|---|---|
| `users` | `email` 唯一、`email_verified_time`、Argon2id `password_hash`、`status(active/disabled)` |
| `personal_plans` | 只 seed `free`（引擎 mysql/sqlite、`max_devices=0` 无限） |
| `personal_subscriptions` | `user_id` 唯一、`entitlement_snapshot` 冻结权益、永久 Free |
| `email_verification_tokens` | 只存 SHA-256 hash、24 小时、单次消费 |
| `devices` | `UNIQUE(user_id, device_key)`、`status(active/revoked)` |
| `refresh_tokens` | `token_hash` 唯一、`family_id` + `replaced_by_token_id` 轮换链 |
| `rate_limit_entries` | 跨实例共享限流计数（固定窗口） |
| `organizations` | 组织：`name`、`status(active/closed)`、`closed_time` |
| `organization_plans` | 只 seed `organization_free`（3 席位、50 资源、MySQL 模板引擎） |
| `organization_subscriptions` | `organization_id` 唯一、`seat_limit`、entitlement 快照、永久 active |
| `organization_memberships` | `UNIQUE(organization_id, user_id)`、`role(admin/member)`、`status(active/invited/removed)` |
| `organization_invitations` | token 只存 SHA-256、7 天、单次消费、挂接 invited membership |
| `organization_resource_folders` | 组织目录：`parent_id` 树、软删除 |
| `organization_resources` | 组织资源：`resource_type(connection_template/query)`、`content(JSON schema)`、`version` 乐观锁、软删除 |

主键 `BIGINT UNSIGNED`，DTO 中一律十进制 `string`。时间 `DATETIME(3)` 以 UTC 读写。

## API（Phase 1）

| Method | Path | 说明 |
|---|---|---|
| `POST` | `/api/auth/register` | 注册（建 user + Free 订阅 + 验证 token，发验证邮件）。重复邮箱返回与成功一致 |
| `POST` | `/api/auth/email-verifications/:token/confirm` | 消费验证 token，标记邮箱已验证 |
| `POST` | `/api/auth/email-verifications` | 重发验证邮件（认证；每小时 3 次） |
| `POST` | `/api/auth/login` | 登录（仅已验证邮箱 + active）。签发 access + refresh |
| `POST` | `/api/auth/refresh` | 刷新（轮换 refresh，复用检测撤销整族） |
| `POST` | `/api/auth/logout` | 登出（撤销当前 refresh token） |
| `POST` | `/api/auth/change-password` | 改密（认证；撤销全部 session） |
| `GET` | `/api/me` | 当前用户 + 个人订阅 |
| `GET` | `/api/personal/subscription` | 个人订阅 |
| `GET/DELETE` | `/api/personal/devices[/:deviceId]` | 列设备 / 撤销本人设备 |
| `GET/POST` | `/api/organizations` | 列 active organizations（本人成员）/ 创建（按用户每小时 ≤10） |
| `GET/PATCH` | `/api/organizations/:organizationId` | 读取摘要 / 更新名称 |
| `POST` | `/api/organizations/:organizationId/close` | 关闭组织（撤销邀请与 invited 成员） |
| `GET` | `/api/organizations/:organizationId/members` | 最小成员目录（不含 email） |
| `PATCH/DELETE` | `/api/organizations/:organizationId/members/:membershipId` | 分配角色 / 移除成员 |
| `POST` | `/api/organizations/:organizationId/leave` | 退出（受最后 active admin 约束） |
| `POST/GET` | `/api/organizations/:organizationId/invitations` | 创建邀请（email、role?）/ 列有效邀请 |
| `DELETE` | `/api/organizations/:organizationId/invitations/:invitationId` | 撤销邀请 |
| `POST` | `/api/organization-invitations/:token/accept` | 按邮箱匹配接受邀请 |
| `GET/POST` | `/api/organizations/:organizationId/folders` | 列 / 创建目录 |
| `PATCH/DELETE` | `/api/organizations/:organizationId/folders/:folderId` | 改名/移动 / 删除空目录 |
| `GET/POST` | `/api/organizations/:organizationId/resources` | 列 / 创建资源 |
| `GET` | `/api/organizations/:organizationId/resources/:resourceId` | 读取资源 |
| `PATCH/DELETE` | `/api/organizations/:organizationId/resources/:resourceId` | 更新（baseVersion 乐观锁）/ 软删除 |

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `MYSQL_PASSWORD` | 是 | MySQL 密码 |
| `TOKEN_SIGNING_KEY_B64` | 是 | 当前签名私钥（PKCS8 PEM 的 base64） |
| `TOKEN_VERIFY_KEYS_JSON` | 是 | 公钥集 `{"<kid>":"<SPKI PEM base64>"}` |
| `TOKEN_SIGNING_KID` | 否 | 当前签名 key id（默认 `k1`） |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | 否 | SMTP 投递；未配 `SMTP_HOST` 时用 LogEmailSender 只记日志 |
| `ACCESS_TOKEN_EXPIRES_IN` / `REFRESH_TOKEN_EXPIRES_IN` | 否 | 默认 `15m` / `30d` |
| `TRUST_PROXY` | 否 | 默认 `1`（nginx 反代之后）。直连须设 `false` |
| `RATE_LIMIT_ENABLED` | 否 | 限流总闸，默认开 |

密钥生成（见 `.env.example`）：

```bash
openssl genpkey -algorithm ed25519 -out /tmp/k1.pem
openssl pkey -in /tmp/k1.pem -pubout -out /tmp/k1.pub.pem
TOKEN_SIGNING_KEY_B64=$(base64 -w0 /tmp/k1.pem)
TOKEN_VERIFY_KEYS_JSON="{\"k1\":\"$(base64 -w0 /tmp/k1.pub.pem)\"}"
```

## 认证与安全

- **密码**：Argon2id（memory 65536 KiB / iterations 3 / parallelism 1 / salt 16 B / output 32 B），自描述参数。
- **access token**：Ed25519 JWT，15 分钟，`Authorization: Bearer`，含 `sub`/`iat`/`exp`/`jti`，header `kid` 选公钥验签，支持轮换。
- **refresh token**：256-bit 熵，DB 只存 SHA-256 hash，30 天；轮换 + family 复用检测。
- **限流**：MySQL `rate_limit_entries`（跨实例）。登录按 email/IP 各 15 分钟 5 次失败；注册按 IP 每小时 10 次；验证重发按用户每小时 3 次。

## 开发与测试

```bash
pnpm install
pnpm --filter @db-client/server typecheck   # tsc --noEmit
pnpm --filter @db-client/server test        # vitest（单元）
pnpm --filter @db-client/server build       # tsc
```

集成测试需要真实 MySQL 8，本地无库时自动跳过（`describe.skipIf(!URL)`），CI 用 service container 跑。跑前设 `MYSQL_TEST_URL`（库名必须含 `verify`/`test`，且不得等于 `MYSQL_DATABASE`）；`globalSetup`（`test/integration/globalSetup.ts`）会在每次运行时先清空该测试库的全部表，无需手动清库。