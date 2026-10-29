# DevBelt

集成在 VS Code 中的数据库客户端，支持 MySQL / PostgreSQL / SQLite 本地连接、Redis、Elasticsearch、AI 辅助，以及端到端加密的个人连接同步、2FA/TOTP 验证器。

## 功能

- 多数据库：MySQL、SQLite、PostgreSQL 本地连接完整可用；Redis、Elasticsearch 面板可用；跨设备端到端加密同步覆盖连接、保存的查询、表注记、验证器、AI 模型接入，具体可用范围按当前套餐为准
- SQL 编辑、补全、格式化、执行、取消、EXPLAIN
- 结果表格、受控行内编辑、多结果集
- CSV/JSON/XML/XLSX/SQL 导入导出、库间数据传输
- 表设计器、DDL、ER 图、Schema 对比
- SSH 隧道、只读模式、生产环境保护
- 查询历史、审计日志、定时备份、连接池状态、服务器仪表盘
- Redis：单机/Cluster/Sentinel、键浏览与五类型 CRUD、Stream、字节级 hex、CLI 控制台、命令日志
- Elasticsearch：集群总览、索引/mapping/文档 CRUD、DSL 查询、REST 控制台、只读切面 fail-closed
- 账号注册/登录、邮箱验证、令牌自动轮换、设备会话管理
- AI 能力（P9 已发布并持续硬化）：NL2SQL（Alt+A 生成+意图复述/假设状态条+一键 Chat 细化回路+ENUM/字典映射+大库预筛）、SQL 解释/优化（含 EXPLAIN）、AI Chat 面板（独立 WebviewPanel，流式/会话历史/schema 上下文/Context 明细）、错误诊断（敏感阻断）、数据问答（样本默认不发）、表设计 AI 生成/审阅（结果回 Chat）、代码块插入/执行；Inline 补全（`Alt+/` 手动触发 Ghost-Text，默认关）；服务端代理 parse-and-forward + `GET /api/ai/usage` 双通道（自带 Key + 服务端代理）。（详见 [P9 工作包](docs/工作包/P9-AI.md)）
- **Agent 模式**（AI Chat 内置，默认关闭）：逐步查结构、跑只读 SQL 与普通 EXPLAIN；写操作只能提出，逐条原生弹窗审批后才执行，决策写入本地执行账本
- **MCP Server**（默认关闭）：仅监听本机、只服务一个连接，暴露 5 个只读工具，带逐客户端令牌、限流与审计
- **脱敏导出**：按列确定性脱敏（PII 必须显式配置），支持 CSV/SQL 与有界外键子集导出，父子键脱敏后仍可关联
- **数据监控**（0.4.0）：定时只读检查表的行数、数值指标或新增行，命中条件时通知；Agent 只能提出监控，由你确认创建
- 中英双语

**个人连接同步**：端到端加密同步已发布，覆盖连接+分组、保存的查询+文件夹、表/列注记、验证器条目、AI 模型接入；具体范围与双设备矩阵持续硬化中。本机路径字段随 E2EE 密文同步。详见[P2 v2 工作包](docs/工作包/P2-个人同步-v2.md)。

**安装版**：通过 VS Code Marketplace 与 Open VSX 发布；最新发布说明见 [`apps/vscode-ext/CHANGELOG.md`](apps/vscode-ext/CHANGELOG.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [产品介绍](docs/产品介绍.md) | 产品能力和当前开发状态 |
| [架构](docs/架构.md) | 代码结构、包职责、关键运行流程 |
| [开发指南](docs/开发指南.md) | 环境、构建、测试、调试 |
| [版本路线图](docs/版本路线图.md) | 已发布版本之后的版本线、功能批次与发布门禁 |
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
