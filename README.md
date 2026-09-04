# DB Client

集成在 VS Code 中的数据库客户端，支持 MySQL、SQLite、PostgreSQL 本地连接，带账号体系、组织协作和端到端加密个人连接同步（开发中）。

## 功能

- 多数据库：MySQL、SQLite、PostgreSQL 本地连接完整可用；跨设备同步为登录后 Pro 权益
- SQL 编辑、补全、格式化、执行、取消、EXPLAIN
- 结果表格、受控行内编辑、多结果集
- CSV/JSON/XML/XLSX/SQL 导入导出、库间数据传输
- 表设计器、DDL、ER 图、Schema 对比
- SSH 隧道、只读模式、生产环境保护
- 查询历史、审计日志、定时备份、连接池状态、服务器仪表盘
- 账号注册/登录、邮箱验证、令牌自动轮换、设备会话管理
- 组织协作：共享目录、共享查询、连接模板（本机凭据映射，当前仅 MySQL 模板）
- 中英双语

**个人连接同步**正在开发中：底层密码学组件已实现，端到端运行时和 UI 未完成，当前安装版无同步入口。首个版本只同步个人连接配置，不含分组和保存查询；本机路径类字段不同步。详见[P2 阶段文档](docs/阶段/P2-个人同步-v1.md)。

**安装版可用性**：命令/视图注册测试通过，但尚未完成干净 Profile VSIX smoke test，见[P0 阶段文档](docs/阶段/P0-安装版可用性.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [产品介绍](docs/产品介绍.md) | 产品能力和当前开发状态 |
| [架构](docs/架构.md) | 代码结构、包职责、关键运行流程 |
| [开发指南](docs/开发指南.md) | 环境、构建、测试、调试 |
| [路线图](docs/路线图.md) | 阶段顺序、目标、完成定义 |
| [阶段文档](docs/README.md#阶段文档) | 每个阶段的完整规格与验收 |

## 开发

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

包结构：

```
packages/
├── db-core/     # 数据库驱动、方言、连接、查询和元数据
├── vscode-ext/  # VS Code 扩展：命令、树视图、webview、组织 Workspace
└── server/      # Fastify 服务：认证、组织、同步 API、MySQL 持久化
```

## 许可

MIT
