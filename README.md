# DB Client

面向 VS Code 的数据库客户端，支持 MySQL、PostgreSQL 和 SQLite。

## 功能

- 数据库连接、连接分组、连接测试和 SSH 隧道。
- SQL 编辑、补全、格式化、执行和 EXPLAIN。
- 结果表格、受控数据编辑、导入导出、表设计、DDL、ER 图和 Schema 对比。
- 本地查询历史、审计记录、备份任务和连接池状态。
- 账号、设备会话、个人权益和组织 Workspace。
- 组织目录、共享查询和连接模板；组织成员与邀请目前只有服务端 API，没有管理界面。

个人连接同步正在开发。服务端协议和扩展基础组件已经实现，扩展端编排、生命周期界面和多设备验收尚未完成，因此当前没有同步入口。

## 目录

```text
packages/
├── db-core/     # 数据库驱动、方言、连接、查询和元数据
├── vscode-ext/  # VS Code 扩展、命令、树视图和 webview
└── server/      # Fastify 服务、MySQL 持久化和同步协议
```

## 开发

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

详细说明见[文档中心](docs/README.md)。

## 许可

MIT
