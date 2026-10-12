# DB Client

集成在 VS Code 中的数据库客户端，支持 MySQL、SQLite、PostgreSQL 本地连接，带账号体系和端到端加密个人连接同步（开发中）。

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
- AI 能力（P9 开发中：S1 核心 + S2 服务端代理/月额度已交付）：NL2SQL（五路信号+ENUM/字典映射+意图复述+Assumptions+大库预筛+一键 Chat 回路+0 行诊断）、SQL 解释/优化、AI Chat 面板（独立 WebviewPanel）、错误诊断、数据问答、Schema 设计建议、智能补全；**加油包（多档位购买+管理后台建单）移 P9.1**；P9 v1 单段月额度（Free/Pro，服务端代理已上线 parse-and-forward + `GET /api/ai/usage`），双通道（自带 Key + 服务端代理）。（详见 [P9 阶段文档](docs/阶段/P9-AI.md)）
- 中英双语

**个人连接同步**：底层密码学、协议与端到端运行时/UI 均已实现（`devbelt.syncNow` 已注册）；待**双设备安装版验证**（B6 矩阵）。v2 目标为**连接 + 分组 + 保存查询 + 查询文件夹全量同步**，树内容跨设备一致；本机路径字段随 E2EE 密文同步。详见[P2 v2 阶段文档](docs/阶段/P2-个人同步-v2.md)。

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
