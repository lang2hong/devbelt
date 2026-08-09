# DB Client

All-in-one Database Client for VS Code，对标 Navicat / [database-client](https://database-client.com)。

## 特性

- **多数据库**：MySQL、PostgreSQL、SQLite（Redis、ElasticSearch 规划中）
- **连接管理**：层级分组、连接表单、测试连接
- **SQL 查询**：复用当前结果或在新面板运行、查询历史、SQL 格式化、结果表格、单元格编辑
- **云同步**：账号登录、AES-256 加密、跨设备同步不含凭据的连接配置
- **国际化**：中英双语，默认跟随 VSCode 界面语言，可手动覆盖

## Monorepo 结构

```
packages/
├── db-core/     # 纯连接/查询/元数据层（无 vscode 依赖，可独立测试）
├── vscode-ext/  # VS Code 扩展（树、表单、查询、i18n、同步客户端）
└── server/      # 云同步后端（Fastify + MySQL + JWT）
```

## 开发

需要 Node.js ≥ 18 与 pnpm。

```bash
npm i -g pnpm
pnpm install

# 构建全部
pnpm build

# 测试
pnpm test

# 类型检查
pnpm typecheck
```

### 扩展调试（F5）

用 VS Code 打开仓库根目录，按 F5 启动 Extension Development Host。

### 后端启动

```bash
cd packages/server
cp .env.example .env   # 填入 MYSQL_PASSWORD 与 JWT_SECRET
docker compose up -d   # 启动 MySQL + server
```

## 发布

```bash
cd packages/vscode-ext
pnpm build
pnpm package   # 生成 .vsix
```

## 许可

MIT
