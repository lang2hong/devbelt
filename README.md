# DevBelt

集成在 VS Code 中的数据库客户端，支持 MySQL / PostgreSQL / SQLite 本地连接、Redis、Elasticsearch、AI 辅助，以及端到端加密的个人连接同步、2FA/TOTP 验证器。

## 功能

- 多数据库：MySQL、SQLite、PostgreSQL 本地连接完整可用；Redis、Elasticsearch 面板可用；跨设备同步为登录后 Pro 权益
- SQL 编辑、补全、格式化、执行、取消、EXPLAIN
- 结果表格、受控行内编辑、多结果集
- CSV/JSON/XML/XLSX/SQL 导入导出、库间数据传输
- 表设计器、DDL、ER 图、Schema 对比
- SSH 隧道、只读模式、生产环境保护
- 查询历史、审计日志、定时备份、连接池状态、服务器仪表盘
- Redis：单机/Cluster/Sentinel、键浏览与五类型 CRUD、Stream、字节级 hex、CLI 控制台、命令日志
- Elasticsearch：集群总览、索引/mapping/文档 CRUD、DSL 查询、REST 控制台、只读切面 fail-closed
- 账号注册/登录、邮箱验证、令牌自动轮换、设备会话管理
- AI 能力（P9 代码全部交付（S1–S6），待发布硬门禁验收）：NL2SQL（Alt+A 生成+意图复述/假设状态条+一键 Chat 细化回路+ENUM/字典映射+大库预筛）、SQL 解释/优化（含 EXPLAIN）、AI Chat 面板（独立 WebviewPanel，流式/会话历史/schema 上下文/Context 明细）、错误诊断（敏感阻断）、数据问答（样本默认不发）、表设计 AI 生成/审阅（结果回 Chat）、代码块插入/执行；Inline 补全（S5 已交付：`Alt+/` 手动触发 Ghost-Text，默认关）；**加油包（多档位购买+管理后台建单）移 P9.1**；P9 v1 单段月额度（Free/Pro，服务端代理 parse-and-forward + `GET /api/ai/usage`），双通道（自带 Key + 服务端代理）。（详见 [P9 工作包](docs/工作包/P9-AI.md)）
- 中英双语

**个人连接同步**：底层密码学、协议与端到端运行时/UI 均已实现（`devbelt.syncNow` 已注册）；待**双设备安装版验证**（B6 矩阵）。v2 目标为**连接 + 分组 + 保存查询 + 查询文件夹全量同步**，树内容跨设备一致；本机路径字段随 E2EE 密文同步。详见[P2 v2 工作包](docs/工作包/P2-个人同步-v2.md)。

**安装版可用性**：命令/视图注册测试通过，但尚未完成干净 Profile VSIX smoke test，见[发布与运维](docs/发布与运维.md) 的安装版 smoke 章节。

## 文档

| 文档 | 内容 |
|---|---|
| [产品介绍](docs/产品介绍.md) | 产品能力和当前开发状态 |
| [架构](docs/架构.md) | 代码结构、包职责、关键运行流程 |
| [开发指南](docs/开发指南.md) | 环境、构建、测试、调试 |
| [版本路线图](docs/版本路线图.md) | 0.1.0 之后的版本线、功能批次与发布门禁 |
| [发布与运维](docs/发布与运维.md) | 发布、验收门禁、部署、回滚、运行 |
| [工作包](docs/工作包/README.md) | 单一功能规格与状态 |
| [文档中心](docs/README.md) | 线性阅读顺序与全部文档索引 |

## 开发

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

包结构：

```
apps/            # 可部署单元
├── server/      # Fastify 服务：认证、同步 API、MySQL 持久化、静态托管
├── vscode-ext/  # VS Code 宿主：命令、树视图、webview
├── db-hostd/    # db-host 的 stdio JSON-RPC sidecar（非 VS Code 宿主复用）
├── db-ui/       # /db 控制台（Vue 3 + Vite）
├── auth-ui/     # 身份页（Vue 3 + Vite）
├── admin-ui/    # /admin 平台后台（Vue 3 + Vite）
└── e2e/         # Playwright 端到端
packages/        # 仅被多方 import 的库
├── db-core/     # 数据库驱动、方言、连接、查询与同步密码学（宿主无关）
├── db-host/     # 宿主无关的编辑器侧逻辑：连接/查询数据层、同步客户端与会话装配
└── auth-client/ # 浏览器侧身份/会话（auth-ui/db-ui/admin-ui 共用）
```

## 许可

MIT
