# @db-client/server

云同步后端服务（Fastify + MySQL + JWT）。

## 接口

### 认证
- `POST /api/auth/register` — 注册，返回 JWT
- `POST /api/auth/login` — 登录，返回 JWT

### 同步（需 Bearer Token，按用户隔离）
- `GET /api/sync` — 拉取当前用户加密数据
- `PUT /api/sync` — 推送（乐观锁 version，冲突返回 409）

### 其他
- `GET /health` — 健康检查

## 安全

- 服务端只存**加密后的数据体**（客户端用主密码 AES-256-GCM 加密）
- 密码使用 **scrypt + 每用户随机盐** 存储（`scrypt$salt$hash`），兼容校验旧版 sha256 哈希
- JWT 携带 `sub`(用户id) 与 `role`，RBAC 授权

## 启动

```bash
cp .env.example .env   # 填入 MYSQL_PASSWORD 与 JWT_SECRET
docker compose up -d
```

或用 Docker 单独构建：

```bash
docker build -t dbclient-server .
docker run -e JWT_SECRET=xxx -e MYSQL_PASSWORD=xxx -p 3000:3000 dbclient-server
```

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | 3000 | 服务端口 |
| `JWT_SECRET` | dev-secret | JWT 签名密钥（生产必改） |
| `MYSQL_HOST` | 127.0.0.1 | MySQL 地址 |
| `MYSQL_PORT` | 3306 | MySQL 端口 |
| `MYSQL_USER` | dbclient | MySQL 用户 |
| `MYSQL_PASSWORD` | - | MySQL 密码 |
| `MYSQL_DATABASE` | db_client | 数据库名 |