# DB Client

**All-in-one Database Client for VS Code** — MySQL, PostgreSQL and SQLite. Query, edit, import/export, design, compare and sync — all inside your editor. 对标 Navicat / [database-client](https://database-client.com)。

## Features

- **多数据库**：MySQL、PostgreSQL、SQLite（Redis、ElasticSearch 规划中）
- **连接管理**：层级分组、连接表单、测试连接、SSH 隧道
- **SQL 查询**：当前/新面板运行、查询历史、SQL 格式化、结果表格、单元格内联编辑
- **SQL 智能**：查询编辑器与 `.sql` 文件的上下文补全、片段、EXPLAIN
- **表工具**：预览、排序/筛选、增删改、造数、复制、导出
- **设计与对比**：可视化表设计、DDL 查看、ER 图、Schema 对比
- **数据迁移**：CSV/JSON 导入导出，带字段映射
- **云同步**：AES-256-GCM 端到端加密的配置跨设备同步（含连接密码，服务端只见密文）
- **运维面板**：审计日志（系统 admin 操作留痕）、用户/订阅/套餐管理
- **数据对比**：Schema 对比、跨库数据对比
- **国际化**：中文 / English

## 文档

| 文档 | 说明 |
|---|---|
| **[产品介绍](docs/产品介绍.md)** | 产品定位、核心能力、使用场景、Roadmap |
| **[技术文档](docs/技术文档.md)** | 架构、SQL 补全引擎设计、连接生命周期、安全、评审与修复 |
| **[开发文档](docs/开发文档.md)** | 构建、调试、测试、发布、贡献 |

### 模块文档

| 模块 | 说明 |
|---|---|
| [db-core](packages/db-core/README.md) | 纯连接/查询/元数据层（无 vscode 依赖） |
| [vscode-ext](packages/vscode-ext/README.md) | VS Code 扩展（**市场发布版**） |
| [server](packages/server/README.md) | 云同步后端（Fastify + MySQL + JWT） |
| admin-ui | 服务端管理后台（Vue 3 + Vite，构建产物由 server 托管在 `/admin`） |

## Monorepo 结构

```
packages/
├── db-core/     # 纯层：连接/查询/元数据服务（无 vscode 依赖，可独立测试）
├── vscode-ext/  # VS Code 扩展：树、命令、webview 查询/设计/ER、补全、i18n、同步客户端
├── server/      # 云同步后端：Fastify + MySQL + JWT
└── admin-ui/    # 管理后台 SPA：用户/订阅/套餐/审计，产物输出到 server/public
```

`admin-ui` 没有独立的 README —— 它只是 server 的一张脸，运行方式和端点契约都在
[server 文档](packages/server/README.md)里。它也没有测试运行器，所以聚合与格式化
逻辑一律放服务端，组件只做渲染。

## 快速上手

1. 安装扩展后，在 VS Code 活动栏打开 **DB Client**。
2. 点击 **+** 添加连接（MySQL / PostgreSQL / SQLite）。
3. 右键表 → **View Data** 预览，或 **New Query** 运行 SQL。

> 使用快捷键：`Ctrl+Enter` 运行、`Ctrl+Alt+Enter` 新面板运行、`Ctrl+Shift+E` EXPLAIN。

## 开发

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

详细流程见 [开发文档](docs/开发文档.md)。

## 许可

MIT