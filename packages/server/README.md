# @db-client/server

Fastify + MySQL 8 服务，负责身份、个人权益、设备、组织、资源和个人同步协议。

## 能力

- 注册、邮箱验证、登录、refresh token 轮换、登出和改密。
- 个人套餐快照、设备注册和设备撤销。
- 组织、成员、邀请、目录和资源。
- 个人同步状态、加密 record、nonce、幂等回执、配额和重置。

服务端不保存或返回个人连接明文、DEK、同步口令、恢复码或签名私钥。

## API

| 范围 | 路由 |
|---|---|
| 认证 | `/api/auth/*` |
| 个人 | `/api/me`、`/api/personal/subscription`、`/api/personal/devices` |
| 组织 | `/api/organizations/*`、`/api/organization-invitations/*` |
| 同步 | `/api/sync/state`、`/init`、`/records`、`/change-key`、`/recover`、`/destroy`、重置路由 |

字段、授权和错误语义见[P2 阶段文档](../../docs/阶段/P2-个人同步-v1.md)和[架构](../../docs/架构.md)。

## 环境变量

| 变量 | 必填 | 用途 |
|---|---|---|
| `MYSQL_PASSWORD` | 是 | MySQL 密码 |
| `TOKEN_SIGNING_KEY_B64` | 是 | 当前 token 签名私钥 |
| `TOKEN_VERIFY_KEYS_JSON` | 是 | 按 key ID 提供的验签公钥 |
| `TOKEN_SIGNING_KID` | 否 | 当前签名 key ID |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | 否 | 邮件投递 |
| `ACCESS_TOKEN_EXPIRES_IN`, `REFRESH_TOKEN_EXPIRES_IN` | 否 | token 有效期 |
| `TRUST_PROXY` | 否 | 受信任代理 |
| `RATE_LIMIT_ENABLED` | 否 | 限流开关 |

## 验证

```bash
pnpm -C packages/server typecheck
pnpm -C packages/server test
pnpm -C packages/server build
```

集成测试需要真实 MySQL 8，并通过 `MYSQL_TEST_URL` 指向名称包含 `test` 或 `verify` 的专用数据库。
