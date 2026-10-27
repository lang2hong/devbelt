# DevBelt

**Database development, without leaving VS Code.**

[English](#english) · [中文](#中文)

![DevBelt](resources/icon.png)

DevBelt brings SQL, Redis, Elasticsearch and AI-assisted workflows into one VS Code workspace. Browse connections, write and run queries, edit results, inspect schemas, and diagnose problems without switching between database tools.

DevBelt 将 SQL、Redis、Elasticsearch 与 AI 工作流整合到同一个 VS Code 工作区。浏览连接、编写并执行查询、编辑结果、查看结构、诊断问题，无需在多个数据库工具间切换。

## What's new / 新功能

### 0.4.0 — Data monitoring / 数据监控

- **Scheduled read-only checks** on a table's row count, a numeric metric query, or new rows on an existing integer / date-time column, with a VS Code notification when your condition is met.
- **Create a task** by right-clicking a table → More… → *Monitor Row Count…*, or just tell AI Chat what to watch: monitoring requests turn Agent mode on automatically, and the assistant can only **propose** a task as a card in the chat.
- **You decide the alert condition.** The card has a condition picker and an interval picker (presets from 5 seconds to 1 hour, or any custom value up to 24 hours). A condition the assistant suggests is shown as a suggestion and only applies after you adopt it; nothing is created until you click *Create and start*.
- **Background Tasks** (AI Chat's More menu, the status bar or a command), newest first: charts, check history, latest new rows, next check time, failure count, pause / resume / check now / remove, **edit the interval and condition**, and *Ask AI to explain*.
- **Safety:** checks use an isolated session that is read-only at the database level, production connections are refused by default, tasks are paused whenever VS Code starts, and only one VS Code window runs them (other windows are view-only).
- **Longer AI conversations:** the last 8 messages stay verbatim and older ones are kept as a rolling summary instead of being dropped; tables you mention are ranked first in the schema context.
- Redis key tree loads 2000 keys per *Load more* by default (`devbelt.redis.keyPageSize`, 200–5000).

- **定时只读检查**：表的行数、一条数值指标查询，或基于已有整数 / 时间列的新增行；命中你设定的条件时弹 VS Code 通知。
- **创建任务**：表右键 → 更多… →「监控行数变化…」，或者直接在 AI Chat 里说要监控什么——监控类请求会自动开启 Agent 模式，助手只能以卡片形式**提出**任务。
- **提醒条件由你决定**：卡片上有条件选择和间隔选择（预设 5 秒到 1 小时，也可自定义，最长 24 小时）。助手给出的条件只作为建议，你点「采用」才生效；点「创建并开始」之前不会创建任何任务。
- **后台任务**（AI Chat「⋯」菜单、状态栏或命令），按创建时间倒序：图表、检查记录、最近新增的行、下次检查时间、连续失败次数，暂停 / 继续 / 立即检查 / 删除、**修改间隔和条件**，以及「让 AI 解读」。
- **安全**：检查在数据库层只读的独立会话上执行，生产连接默认拒绝，每次启动 VS Code 任务都会先暂停，只有一个 VS Code 窗口执行任务（其他窗口只能查看）。
- **更长的 AI 对话**：最近 8 条保留原文，更早的内容压缩成滚动摘要而不是直接丢弃；你提到的表会优先放进表结构上下文。
- Redis 键树每次「加载更多」默认 2000 个键（`devbelt.redis.keyPageSize`，200–5000）。

### 0.3.0 — Agent, MCP and masked export / Agent、MCP 与脱敏导出

- **Agent mode** (off by default, toggle under the chat input): inspect schema, run read-only SQL and plain `EXPLAIN` step by step, with limits, cancellation and a plain-chat fallback when the model has no tool calling. Writes are proposals only: each DML/DDL needs approval in a native modal, MySQL/PostgreSQL DML is dry-run inside a rolled-back transaction, and every decision goes to a local JSONL execution ledger.
- **MCP server** (off by default): loopback-only Streamable HTTP for one configured connection, with per-client bearer tokens, rate limits, Host/Origin checks and audit. It exposes five read-only tools and never registers writes.
- **Masked export**: deterministic per-column masking with explicit PII rules, preview, CSV/SQL output, plus a bounded foreign-key subset export that keeps masked keys aligned.

- **Agent 模式**（默认关闭，开关在对话输入框下方）：逐步查 Schema、跑只读 SQL 与普通 `EXPLAIN`，带步数上限、取消，模型不支持工具调用时退回普通问答。写操作只能提出：每条 DML/DDL 在原生弹窗中审批，MySQL/PostgreSQL 的 DML 在事务内试执行后回滚，全部决策写入本地 JSONL 执行账本。
- **MCP Server**（默认关闭）：仅监听本机的 Streamable HTTP，只服务一个指定连接；逐客户端令牌、限流、Host/Origin 校验与审计；只暴露 5 个只读工具，不注册写操作。
- **脱敏导出**：按列确定性脱敏，PII 列必须显式配置规则，先预览再导出 CSV/SQL；支持有界外键子集导出，父子键脱敏后仍可关联。

## English

### Why DevBelt

- **One workspace, multiple engines.** MySQL, PostgreSQL, SQLite, Redis and Elasticsearch share the same workspace, tab model and security model.
- **From query to result.** Run the current statement or selection, cancel long queries, inspect plans, edit result rows and export data.
- **Schema work is first-class.** Table designer, DDL, ER diagrams, schema comparison and PostgreSQL multi-schema/multi-database navigation.
- **AI is part of the workflow.** Generate SQL, explain and optimize queries, diagnose errors, ask questions about result samples and visualize results.
- **Security is built in.** Secrets stay in VS Code `SecretStorage`; SSH tunnels use host-key verification; read-only and production guards are fail-closed; writes are audited.
- **Personal connections stay personal.** Optional E2EE sync protects connection metadata and local paths before they leave the device.

### SQL workspace

![SQL editor and result grid](resources/screenshots/01-sql-workbench.png)

- Connection groups, connection testing and SSH tunnels.
- SQL editing, context-aware completion, formatting, execution and cancellation.
- `EXPLAIN` from the editor.
- Multi-result grids with filters, sorting, paging and controlled inline editing.
- Query history, audit log, scheduled backups, server dashboard and object search.
- CSV, JSON, XML, XLSX and SQL import/export; database-to-database transfer.

### Query insight

- **Visual EXPLAIN** for MySQL (`FORMAT=JSON`), PostgreSQL (`FORMAT JSON`) and SQLite (`EXPLAIN QUERY PLAN`): plan tree, node details, warning highlights (large full scans, filesort, temporary tables, risky nested loops, missing indexes) and raw-plan copy. Plain `EXPLAIN` only — statements are planned, never executed. PostgreSQL is integration-tested against PostgreSQL 16 in CI; a manual walkthrough on a real workload is pending.
- **AI: Explain plan** sends a compact, bounded plan summary to AI Chat.
- **Index suggestions** for flagged tables: equality → range → sort column order, existing-index and primary/unique-key checks, confidence plus reasons and risks. Copy the DDL; nothing is executed.
- **Slow Queries** (`DevBelt: Slow Queries`): local query history grouped by SQL template, sorted by total/average/max time or runs, with failure counts and one-click SQL or EXPLAIN. Retention is configurable with `devbelt.insights.historyLimit`.
- **SQL diagnostics** in `.sql` editors: `UPDATE`/`DELETE` without `WHERE`, `DROP`/`TRUNCATE`/`ALTER`, `NOT IN (subquery)`, `SELECT *` and dialect mismatches. Toggle with `devbelt.diagnostics.enabled`, tune per rule with `devbelt.diagnostics.rules`.
- **Data dictionary**: database node → Data → Generate Data Dictionary, as Markdown or HTML, without any connection details.

### Monitoring

![AI proposing a monitoring task](resources/screenshots/06-monitor-proposal.png)

- **Scheduled read-only checks**: row count, one numeric metric, or new rows on an existing column; VS Code notification when your condition is met.
- **Propose, not create**: in Agent mode the assistant can only propose a task as a card; you pick the interval and alert condition and confirm before anything runs.
- **Background Tasks**: charts, check history, next check, failure count, and editable interval / condition.

![Background Tasks drawer](resources/screenshots/07-monitor-tasks.png)

### Schema and data

![ER diagram](resources/screenshots/02-er-diagram.png)

- Table designer and DDL generation.
- ER diagrams and schema comparison with synchronization SQL.
- PostgreSQL multi-schema writes, DDL, export and data editing with schema-qualified names.
- PostgreSQL multi-database navigation with lazy per-database sessions.
- Backup/restore and mock-data generation.

### Redis

![Redis key browser and value editor](resources/screenshots/03-redis.png)

- Standalone, Cluster and Sentinel connections, including SSH tunnels and TLS.
- Key browser with separators, SCAN paging (2000 keys per *Load more* by default, `devbelt.redis.keyPageSize`) and binary-safe keys.
- Native editors for all core data types: strings, hashes, lists, sets, sorted sets and Streams.
- Stream consumer-group details, pending entries, `XACK` and `XCLAIM`.
- CLI console, command log, slow log and server status.
- Read-only mode and dangerous-command confirmation.

### Elasticsearch

![Elasticsearch documents and DSL console](resources/screenshots/04-elasticsearch.png)

- HTTP/HTTPS, Basic/API-key authentication, TLS and SSH tunnels.
- Cluster overview, node list and index browser.
- Mapping, settings and aliases inspection.
- Document browsing with `search_after` pagination; create, edit, delete and bulk delete.
- DSL console with result paging and structured result tables.
- REST console with structured errors, truncation notices and in-flight request cancellation.
- Fail-closed read-only enforcement and audit logging.

### AI assistant

![AI Chat with charts and usage details](resources/screenshots/05-ai-chat.png)

- AI Chat with streaming responses, conversation history (older messages are summarized, not dropped) and schema context.
- Natural-language to SQL, SQL explanation and optimization, and error diagnosis.
- Data Q&A with sample sending explicitly opt-in.
- Table design generation and review.
- Result charts: bar, line, area, pie, stacked bar and horizontal bar.

![SQL EXPLAIN with AI](resources/screenshots/08-explain.png)
- Per-response credits used, duration and trigger time.
- Inline SQL completion (off by default, trigger with `Alt+/`).
- Server proxy or bring-your-own API key.
- AI preferences and custom rules sync across devices with end-to-end encryption.
- **Agent mode** (off by default): open AI Chat, pick a connection and turn on the **Agent** switch under the input box (monitoring requests turn it on for you). The assistant inspects the schema, runs read-only SQL and plain `EXPLAIN` step by step, within a step / tool-call / time budget (12 / 24 / 120 s, configurable with `devbelt.ai.agent.*`).
- **Write proposals only**: DML and DDL are proposed, dry-run where possible, and executed only after you approve them in a native dialog. `devbelt.ai.agent.allowWrites`, `devbelt.ai.agent.allowDdl` and `devbelt.ai.agent.allowProduction` control what may be proposed. Every decision is appended to a local JSONL ledger.
- **Where to open AI Chat**: the DevBelt sidebar title, the status bar, or the `✦ AI` button in a query result panel (that one prefills the current SQL and does not send it).
- **EXPLAIN panel "Execute"**: runs `EXPLAIN ANALYZE` on a separate read-only session for real row counts and timings (MySQL/PostgreSQL; production connections require `devbelt.explain.allowAnalyzeProduction`).

### Sync, security and audit

- Personal connection sync is end-to-end encrypted; the server stores ciphertext only.
- Auto sync is **off by default** (`devbelt.sync.autoSync`); use Sync Now / Pull / Push or enable it explicitly.
- SSH host-key verification:
  - `tofu` (default): confirm the SHA256 fingerprint for a new host, then trust it.
  - `strict`: only trust hosts already present in `known_hosts`.
  - Key changes and `@revoked` always fail closed.
- Credentials live in VS Code `SecretStorage`.
- Read-only mode, production guards and audit records for writes.
- Authenticator (2FA/TOTP) with secrets kept in the OS keychain.

### Get started

1. Install DevBelt from the VS Code Marketplace.
2. Open the DevBelt activity bar and create a connection.
3. Test the connection, open a SQL editor or browse data.
4. Optionally sign in and enable encrypted personal sync.

```bash
code --install-extension lang2hong.devbelt-db-client
```

### Shortcuts

| Shortcut | macOS | Action |
|---|---|---|
| `Ctrl+Enter` | `Cmd+Enter` | Run query or current statement |
| `Ctrl+Alt+Enter` | `Cmd+Ctrl+Enter` | Run in a new panel |
| `Ctrl+Shift+E` | `Cmd+Shift+E` | EXPLAIN |
| `Ctrl+Alt+F` | `Cmd+Alt+F` | Search database objects |
| `Ctrl+Alt+C` | `Cmd+Alt+C` | Search connections |

### Requirements and status

- VS Code **1.85.0** or newer.
- The local SQL path (MySQL, PostgreSQL, SQLite) is the most mature part of the product.
- Redis, Elasticsearch and AI features are available and continue to receive real-world hardening.
- Personal sync is E2EE and opt-in; dual-device installed-build validation is pending.

### Documentation

- [Product overview](https://github.com/lang2hong/devbelt)
- [Documentation center](https://github.com/lang2hong/devbelt/tree/main/docs)
- [Issues](https://github.com/lang2hong/devbelt/issues)

## 中文

### 为什么选择 DevBelt

- **一个工作区，多种引擎。** MySQL、PostgreSQL、SQLite、Redis、Elasticsearch 共用统一的工作区、页签模型与安全模型。
- **从查询到结果。** 执行当前语句或选中 SQL、取消长查询、查看执行计划、编辑结果行并导出数据。
- **结构设计是一等能力。** 表设计器、DDL、ER 图、Schema 对比，以及 PostgreSQL 多 schema、多库导航。
- **AI 融入工作流。** 生成 SQL、解释与优化、错误诊断、基于结果样本的数据问答和结果可视化。
- **安全内建。** 凭据保存在 VS Code `SecretStorage`；SSH 隧道校验主机密钥；只读与生产保护默认 fail-closed；写操作进入审计。
- **个人连接保持私密。** 可选端到端加密同步，连接元数据与本地路径在离开设备前完成加密。

### SQL 工作台

![SQL 编辑器与结果表格](resources/screenshots/01-sql-workbench.png)

- 连接分组、连接测试与 SSH 隧道。
- SQL 编辑、上下文补全、格式化、执行与取消。
- 编辑器内 `EXPLAIN`。
- 多结果表格、筛选排序、分页与受控行内编辑。
- 查询历史、审计日志、定时备份、服务器仪表盘与对象搜索。
- CSV、JSON、XML、XLSX、SQL 导入导出与库间数据传输。

### 查询洞察

- **可视化 EXPLAIN**：支持 MySQL（`FORMAT=JSON`）、PostgreSQL（`FORMAT JSON`）、SQLite（`EXPLAIN QUERY PLAN`），提供计划树、节点详情、告警高亮（大表全扫描、filesort、临时表、高风险嵌套循环、缺少索引）与原始计划复制。只执行普通 `EXPLAIN`，语句只做规划、不会执行。PostgreSQL 已在 CI 的 PostgreSQL 16 上做集成测试，真实业务库上的人工走查尚未进行。
- **AI 解释计划**：把精简、有上限的计划摘要发给 AI Chat 解释。
- **索引建议**：只针对计划中有告警的表；按「等值 → 范围 → 排序」组合列，检查已有索引与主键/唯一键，给出置信度、理由与风险。可复制 DDL，不会自动执行。
- **慢查询分析**（`DevBelt: 慢查询分析`）：按 SQL 模板聚合本地查询历史，可按总/平均/最大耗时或次数排序，显示失败次数，一键打开 SQL 或 EXPLAIN。保留条数可用 `devbelt.insights.historyLimit` 调整。
- **SQL 诊断**：`.sql` 编辑器内提示缺少 `WHERE` 的 `UPDATE`/`DELETE`、`DROP`/`TRUNCATE`/`ALTER`、`NOT IN (子查询)`、`SELECT *` 与方言不符的写法；`devbelt.diagnostics.enabled` 总开关，`devbelt.diagnostics.rules` 按规则调整级别。
- **数据字典**：库节点 → 数据 → 生成数据字典，导出 Markdown 或 HTML，不包含任何连接信息。

### 监控

![AI 提出监控任务](resources/screenshots/06-monitor-proposal.png)

- **定时只读检查**：行数、一个数值指标、或基于已有列的新增行；命中条件时弹 VS Code 通知。
- **只提出、不创建**：Agent 模式下助手只能以卡片形式**提出**任务；你选间隔和提醒条件、确认后才会执行。
- **后台任务**：图表、检查记录、下次检查、失败次数，间隔和条件可编辑。

![后台任务抽屉](resources/screenshots/07-monitor-tasks.png)

### 结构与数据

![ER 图](resources/screenshots/02-er-diagram.png)

- 表设计器与 DDL 生成。
- ER 图、Schema 对比与同步 SQL。
- PostgreSQL 多 schema 写入、DDL、导出与数据编辑，对象名按 schema 限定。
- PostgreSQL 多库浏览，按库懒建会话。
- 备份/恢复与模拟数据生成。

### Redis

![Redis 键浏览器与值编辑器](resources/screenshots/03-redis.png)

- 单机、Cluster、Sentinel 连接，支持 SSH 隧道与 TLS。
- 键浏览器、分隔符折叠、SCAN 分页（每次「加载更多」默认 2000 个键，`devbelt.redis.keyPageSize`）与二进制安全键。
- 全部核心数据类型原生编辑：string、hash、list、set、zset、Stream。
- Stream 消费组、pending 明细、`XACK` 与 `XCLAIM`。
- CLI 控制台、命令日志、慢日志与服务器状态。
- 只读模式与危险命令确认。

### Elasticsearch

![Elasticsearch 文档浏览与 DSL 控制台](resources/screenshots/04-elasticsearch.png)

- HTTP/HTTPS、Basic/API Key、TLS 与 SSH 隧道。
- 集群总览、节点列表与索引浏览。
- mapping、settings、aliases 查看。
- 文档 `search_after` 分页浏览，创建、编辑、删除与批量删除。
- DSL 控制台，结果分页并结构化展示。
- REST 控制台，结构化错误、截断提示与在途请求取消。
- 只读 fail-closed 与审计日志。

### AI 助手

![AI Chat（图表与用量详情）](resources/screenshots/05-ai-chat.png)

- AI Chat 流式回复、会话历史（较早的消息压缩成摘要，不直接丢弃）与 Schema 上下文。
- 自然语言生成 SQL、SQL 解释与优化、错误诊断。
- 数据问答，样本发送需显式确认。
- 表设计生成与审阅。
- 结果图表：柱状图、折线图、面积图、饼图、堆叠柱状图、横向条形图。

![SQL EXPLAIN 与 AI 解读](resources/screenshots/08-explain.png)
- 每条回复显示积分消耗、耗时与触发时间。
- SQL 行内补全（默认关闭，按 `Alt+/` 触发）。
- 支持服务端代理或自带 API Key。
- AI 偏好与自定义规则端到端加密跨设备同步。
- **Agent 模式**（默认关闭）：在 AI Chat 选好连接，打开输入框下方的「Agent」开关（监控类请求会自动打开）。助手会逐步查结构、跑只读 SQL 与普通 `EXPLAIN`，并受步数 / 工具次数 / 时间预算限制（默认 12 次 / 24 次 / 120 秒，可用 `devbelt.ai.agent.*` 调整）。
- **写操作只能提出**：DML / DDL 先给出方案，能试执行的先试执行并回滚，只有你在原生弹窗中批准后才会真正执行。`devbelt.ai.agent.allowWrites`、`devbelt.ai.agent.allowDdl`、`devbelt.ai.agent.allowProduction` 控制允许提出哪些；每次决策写入本地 JSONL 执行账本。
- **AI 对话入口**：DevBelt 侧栏标题、状态栏，以及查询结果面板的 `✦ AI` 按钮（只预填当前 SQL，不会自动发送）。
- **EXPLAIN 面板「实际执行」**：在独立只读会话上执行 `EXPLAIN ANALYZE`，获得真实行数与耗时（MySQL / PostgreSQL；生产连接需开启 `devbelt.explain.allowAnalyzeProduction`）。

### 同步、安全与审计

- 个人连接同步端到端加密，服务端只保存密文。
- 自动同步**默认关闭**（`devbelt.sync.autoSync`）；可手动立即同步 / 拉取 / 推送，或显式开启。
- SSH 主机密钥校验：
  - `tofu`（默认）：首次连接确认 SHA256 指纹，接受后信任。
  - `strict`：只信任 `known_hosts` 中已有主机。
  - 密钥变更或 `@revoked` 一律硬失败。
- 凭据保存在 VS Code `SecretStorage`。
- 只读模式、生产保护与写操作审计。
- 验证器（2FA/TOTP）密钥保存在操作系统密钥库。

### 快速开始

1. 从 VS Code 插件市场安装 DevBelt。
2. 打开 DevBelt 活动栏，新建连接。
3. 测试连接，打开 SQL 编辑器或浏览数据。
4. 如需跨设备同步，登录并启用端到端加密个人同步。

```bash
code --install-extension lang2hong.devbelt-db-client
```

### 快捷键

| 快捷键 | macOS | 操作 |
|---|---|---|
| `Ctrl+Enter` | `Cmd+Enter` | 运行查询或当前语句 |
| `Ctrl+Alt+Enter` | `Cmd+Ctrl+Enter` | 在新面板运行 |
| `Ctrl+Shift+E` | `Cmd+Shift+E` | EXPLAIN |
| `Ctrl+Alt+F` | `Cmd+Alt+F` | 搜索数据库对象 |
| `Ctrl+Alt+C` | `Cmd+Alt+C` | 搜索连接 |

### 要求与状态

- 需要 VS Code **1.85.0** 或更高版本。
- 本地 SQL 路径（MySQL、PostgreSQL、SQLite）是当前最成熟的部分。
- Redis、Elasticsearch 与 AI 能力已可用，仍在持续进行真机硬化。
- 个人同步为端到端加密、可选启用；双设备安装版验证仍在进行。

### 文档

- [产品介绍](https://github.com/lang2hong/devbelt)
- [文档中心](https://github.com/lang2hong/devbelt/tree/main/docs)
- [问题反馈](https://github.com/lang2hong/devbelt/issues)

## License / 许可

MIT