# Changelog

All notable changes to DevBelt DB Client are documented in this file.

本文件记录 DevBelt DB Client 的所有重要变更。

## [0.2.0] - 2026-10-23

### English

#### Added

- **Visual EXPLAIN** for MySQL, PostgreSQL and SQLite: plan tree, node details, warning highlights, multi-statement tabs, raw-plan copy and a raw fallback when a structured plan is unavailable. Plain `EXPLAIN` only; statements are never executed.
- **AI: Explain plan** from the plan panel, using a compact and bounded plan summary.
- **Index suggestions** for tables the plan flags: equality → range → sort column order, existing-index and primary/unique-key checks, redundant prefix-index hints, and copyable DDL with confidence, reasons and risks. Never executed.
- **Slow Queries** panel built from local query history: grouping by SQL template, sorting, connection/time/keyword filters, failure counts and one-click SQL or EXPLAIN.
- **SQL diagnostics** for `.sql` editors: `UPDATE`/`DELETE` without `WHERE`, `DROP`/`TRUNCATE`/`ALTER`, `NOT IN (subquery)`, `SELECT *` and dialect mismatches, with per-rule severity settings.
- **Data dictionary export** as Markdown or HTML (tables, columns, indexes, foreign keys), with no connection details in the output.
- Settings: `devbelt.insights.historyLimit`, `devbelt.diagnostics.enabled`, `devbelt.diagnostics.rules`, `devbelt.dictionary.format`.

#### Improved

- Query history retention is configurable (10–1000, default 100) and failed executions are recorded.
- Plan warnings only fire for large scans (≥ 1000 estimated rows or unknown size), so small MySQL/PostgreSQL tables no longer raise false alarms.

#### Fixed

- SQLite `EXPLAIN QUERY PLAN` returned no rows because the sqlite3 CLI rewrote it as an ASCII tree; the EXPLAIN panel and AI optimization now receive the plan.
- Replacing the SQL while an EXPLAIN was running could briefly show the previous plan.
- MySQL EXPLAIN could run against another database when the editor had no database context.
- SQL errors during EXPLAIN were reported as "could not parse plan" instead of the real error.
- Index suggestions were missing whenever the SQL used table aliases (MySQL and SQLite report aliases in their plans).
- One failing statement in a multi-statement EXPLAIN no longer hides the plans of the others; it shows its own error.
- On a PostgreSQL schema node, EXPLAIN now resolves unqualified tables in that schema (isolated session), matching the index-suggestion metadata.
- The data dictionary for a PostgreSQL database node records the schema it exported.
- `#` comments in `.sql` files without a bound connection are no longer reported as code.

#### Known limitations

- Column selectivity is not available, so index suggestions are rated medium at most.
- Slow queries come from local history only; server-side statistics (`performance_schema`, `pg_stat_statements`) are not read yet.
- Diagnostics that need schema metadata (implicit conversions, `NOT IN` with nullable columns) are not included yet.
- SQLite `EXPLAIN QUERY PLAN` has no row estimates, so every plain table scan on SQLite is flagged regardless of size.
- PostgreSQL EXPLAIN is integration-tested against PostgreSQL 16 in CI; a manual walkthrough on a real PostgreSQL workload has not been done yet.

### 中文

#### 新增

- **可视化执行计划**：MySQL、PostgreSQL、SQLite 计划树、节点详情、告警高亮、多语句标签、原始计划复制，结构化计划不可用时回退显示原始输出。只执行普通 `EXPLAIN`，语句不会被执行。
- **AI 解释计划**：在计划面板中把精简、有上限的计划摘要发给 AI 解释。
- **索引建议**：只针对计划中有告警的表；按「等值 → 范围 → 排序」组合列，检查已有索引与主键/唯一键，提示冗余前缀索引；提供可复制的 DDL，并附置信度、理由与风险。不会自动执行。
- **慢查询分析**：基于本地查询历史按 SQL 模板聚合，支持排序、按连接/时间/关键字过滤、失败计数，一键打开 SQL 或 EXPLAIN。
- **SQL 诊断**：`.sql` 编辑器提示缺少 `WHERE` 的 `UPDATE`/`DELETE`、`DROP`/`TRUNCATE`/`ALTER`、`NOT IN (子查询)`、`SELECT *` 与方言不符的写法，可按规则调整级别。
- **数据字典导出**：Markdown 或 HTML（表、列、索引、外键），输出不含任何连接信息。
- 新增设置：`devbelt.insights.historyLimit`、`devbelt.diagnostics.enabled`、`devbelt.diagnostics.rules`、`devbelt.dictionary.format`。

#### 改进

- 查询历史保留条数可配置（10–1000，默认 100），并记录执行失败。
- 计划告警只针对大表扫描（估计 ≥ 1000 行或行数未知），MySQL / PostgreSQL 小表不再误报。

#### 修复

- SQLite `EXPLAIN QUERY PLAN` 被 sqlite3 命令行改写成 ASCII 树导致取不到结果；EXPLAIN 面板与 AI 优化现在能拿到计划。
- EXPLAIN 执行中替换 SQL 时可能短暂显示上一条 SQL 的计划。
- 编辑器没有库上下文时，MySQL EXPLAIN 可能在其他库上执行。
- EXPLAIN 时的 SQL 错误被显示成「无法解析计划」，而不是真实报错。
- SQL 使用表别名时没有索引建议（MySQL 与 SQLite 的计划里报告的是别名）。
- 多语句 EXPLAIN 中某条失败时不再连带其他语句，失败的那条单独显示报错。
- 在 PostgreSQL schema 节点上执行 EXPLAIN 时，未带前缀的表按该 schema 解析（独立会话），与索引建议读取的元数据一致。
- PostgreSQL 库节点导出的数据字典会写明实际导出的 schema。
- 未绑定连接的 `.sql` 文件中，`#` 注释不再被当作代码报出诊断。

#### 已知限制

- 无法获取列选择性，索引建议的置信度最高为「中」。
- 慢查询只来自本地历史，暂不读取服务端统计（`performance_schema`、`pg_stat_statements`）。
- 依赖表结构的诊断（隐式类型转换、`NOT IN` + 可空列）暂未提供。
- SQLite 的 `EXPLAIN QUERY PLAN` 没有行数估计，SQLite 上的普通表扫描不论大小都会告警。
- PostgreSQL EXPLAIN 已在 CI 的 PostgreSQL 16 上做集成测试，真实业务库上的人工走查尚未进行。

## [0.1.0] - 2026-10-21

### English

#### Added

- **Multi-engine SQL workspace**: MySQL, PostgreSQL and SQLite connections with groups, connection testing, SSH tunnels, query history, audit log, backups, server dashboard and object search.
- **SQL editing and execution**: context-aware completion, formatting, run current statement/selection, cancellation, EXPLAIN and multi-result grids.
- **Data and schema tools**: controlled inline editing, CSV/JSON/XML/XLSX/SQL import/export, database-to-database transfer, table designer, DDL, ER diagrams and schema comparison.
- **PostgreSQL workspace**: multi-schema browsing and schema-qualified writes/DDL/data editing, plus multi-database navigation with lazy derived sessions.
- **Redis client**: standalone/Cluster/Sentinel connections, SSH/TLS, key browser, native editors for all five data types, Stream consumer groups and pending entries, `XACK`/`XCLAIM`, CLI console, slow log and binary-safe operations.
- **Elasticsearch client**: cluster and node overview, index/mapping/settings/aliases inspection, document browsing and CRUD, bulk delete, DSL console with `search_after` paging, REST console with request cancellation and fail-closed read-only mode.
- **AI assistant**: AI Chat, natural-language to SQL, SQL explanation/optimization, error diagnosis, data Q&A with opt-in samples, table design generation/review, inline completion and streaming conversation history.
- **AI result charts**: bar, line, area, pie, stacked bar and horizontal bar charts inferred from query results.
- **AI usage details**: every assistant response can show credits used, duration and trigger time; credits are displayed with up to three decimals.
- **AI business rules sync**: business rules are stored as encrypted sync metadata and shared across devices.
- **Personal connection sync**: end-to-end encrypted connection, group, saved-query and query-folder sync. Automatic sync is off by default and can be enabled with `devbelt.sync.autoSync`.
- **Security controls**: credentials in VS Code `SecretStorage`, SSH host-key verification with `tofu`/`strict` policies, read-only mode, production guards and audit logging.
- **Authenticator**: local TOTP codes with groups, tags, search, copy and export; secrets remain in the OS keychain.
- **Bilingual UI**: complete Chinese and English interface.

#### Improved

- Result grid: row details, select-all, in-result search, keyboard navigation and safer copy actions.
- Redis key tree: clearer folder paging, node interaction and localized dynamic labels.
- Elasticsearch panel: independent in-flight requests, response generation guards and clearer error states.
- AI Chat: connection-state refresh, model access dialog synchronization, quota feedback and chart selection that follows explicit user intent.
- Account center and tree menus: grouped navigation and clearer command organization.
- Personal sync: business rules included in encrypted sync; automatic sync remains opt-in.

#### Fixed

- Redis key node click fallback and stale tree command arguments.
- Elasticsearch concurrent request cancellation and stale document/DSL responses.
- AI connection status and asynchronous model-access snapshots.
- i18n key drift, unused catalog entries and mixed-language labels.
- Several query, export and schema-operation edge cases.

#### Status

- Local SQL is the most mature path.
- Redis, Elasticsearch and AI are available and continue to receive real-world hardening.
- Personal sync is end-to-end encrypted and opt-in; dual-device installed-build validation is pending.

### 中文

#### 新增

- **多引擎 SQL 工作台**：MySQL、PostgreSQL、SQLite 连接，支持连接分组、连接测试、SSH 隧道、查询历史、审计日志、备份、服务器仪表盘和对象搜索。
- **SQL 编辑与执行**：上下文补全、格式化、运行当前语句/选中 SQL、取消、EXPLAIN 和多结果表格。
- **数据与结构工具**：受控行内编辑、CSV/JSON/XML/XLSX/SQL 导入导出、库间数据传输、表设计器、DDL、ER 图和 Schema 对比。
- **PostgreSQL 工作区**：多 schema 浏览与 schema 限定写入/DDL/数据编辑；多库导航与按库懒建会话。
- **Redis 客户端**：单机/Cluster/Sentinel、SSH/TLS、键浏览器、五类原生数据编辑、Stream 消费组与 pending 明细、`XACK`/`XCLAIM`、CLI 控制台、慢日志与字节级操作。
- **Elasticsearch 客户端**：集群与节点总览、索引/mapping/settings/aliases 查看、文档浏览与 CRUD、批量删除、DSL 控制台与 `search_after` 分页、REST 控制台请求取消、只读 fail-closed。
- **AI 助手**：AI Chat、自然语言生成 SQL、SQL 解释/优化、错误诊断、需显式确认的数据问答、表设计生成/审阅、Inline 补全与流式会话历史。
- **AI 结果图表**：柱状图、折线图、面积图、饼图、堆叠柱状图、横向条形图。
- **AI 用量展示**：每条助手回复显示积分消耗、耗时和触发时间；积分最多保留 3 位小数。
- **AI 业务规则同步**：业务规则作为加密同步元数据跨设备共享。
- **个人连接同步**：端到端加密同步连接、分组、保存查询与查询文件夹；自动同步默认关闭，可通过 `devbelt.sync.autoSync` 开启。
- **安全控制**：凭据保存在 VS Code `SecretStorage`；SSH 主机密钥支持 `tofu`/`strict` 校验；只读模式、生产保护与审计日志。
- **验证器**：本地 TOTP 动态口令，支持分组、标签、搜索、复制与导出；密钥只保存在操作系统密钥库。
- **中英双语界面**。

#### 改进

- 结果表格：行详情、全选、结果内搜索、键盘导航与更安全的复制操作。
- Redis 键树：文件夹分页、节点交互与动态标签中文化。
- Elasticsearch 面板：独立请求、响应代次守卫与更清晰的错误状态。
- AI Chat：连接状态刷新、模型接入弹层同步、配额反馈，以及按用户明确意图选择图表。
- 账户中心与树菜单：分组导航与命令组织更清晰。
- 个人同步：业务规则纳入加密同步；自动同步保持默认关闭，需显式开启。

#### 修复

- Redis 键节点点击容错与树命令参数缓存问题。
- Elasticsearch 并发请求取消与旧文档/DSL 响应覆盖问题。
- AI 连接状态与模型接入异步快照问题。
- i18n 键漂移、死键与中英混用文案。
- 若干查询、导出与结构操作边界问题。

#### 状态

- 本地 SQL 是当前最成熟的路径。
- Redis、Elasticsearch 与 AI 已可用，仍在持续进行真机硬化。
- 个人同步端到端加密、可选启用；双设备安装版验证仍在进行。