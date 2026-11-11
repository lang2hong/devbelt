# Changelog

All notable changes to DevBelt DB Client are documented in this file.

本文件记录 DevBelt DB Client 的所有重要变更。

## [0.4.15] - 2026-11-11

### English

- **Read-only SQL Server connections are now enforced in the client core.** Previously every panel and command had to remember to check the flag; now any write statement is rejected centrally, so a new entry point cannot bypass it.
- Execution plans still work on read-only SQL Server connections.
- SQL Server connections no longer sync path and URL fields the engine does not use (Unix socket, client certificates, connection strings). CA files and SSH keys still sync.
- When you mark a SQL Server connection as read-only, the form explains that enforcement happens in the client, because SQL Server has no database-level read-only mode.

### 中文

- **SQL Server 只读连接改由客户端核心统一拦截。** 以前每个面板和命令都要自己记得判断只读；现在任何写语句都会被中心护栏拒绝，新入口不会漏拦。
- 只读的 SQL Server 连接上，执行计划仍然可用。
- SQL Server 连接不再同步该引擎用不到的路径与 URL 字段（Unix socket、客户端证书、连接串）；CA 文件与 SSH 私钥仍会同步。
- 勾选 SQL Server 连接的只读时，表单会说明拦截发生在客户端——SQL Server 没有数据库层只读。

## [0.4.14] - 2026-11-11

### English

- **SQL Server connections now sync across devices**, with the same rules as MySQL and Elasticsearch: connection settings, TLS options, SSH tunnel settings and queries are kept in sync, while colors and timeouts stay local to each machine.
- SQL Server is available on both Free and Pro plans.
- The plan page now shows Redis, Elasticsearch and SQL Server by name instead of marking them as coming soon.
- Fixed: when a SQL Server connection points at a CA file that is missing on the current machine, you get an actionable prompt before connecting instead of a low-level file error.
- Upgrade notice: version 0.4.13 stops inbound sync when it encounters a synced SQL Server connection. Upgrade every device to 0.4.14 before using SQL Server connections on a multi-device account.

### 中文

- **SQL Server 连接现在支持跨设备同步**，规则与 MySQL、Elasticsearch 一致：连接配置、TLS 选项、SSH 隧道配置和查询都会同步；颜色与超时保持每台机器本地。
- SQL Server 在免费版与 Pro 版都可用。
- 套餐页按名称显示 Redis、Elasticsearch 与 SQL Server，不再标记为“即将支持”。
- 修复：SQL Server 连接指向的 CA 文件在当前机器上缺失时，连接前会给出可操作的提示，而不是底层文件错误。
- 升级提示：0.4.13 遇到同步过来的 SQL Server 连接时入站同步会停住。在多设备账号上使用 SQL Server 连接前，请把所有设备升级到 0.4.14。

## [0.4.13] - 2026-11-10

### English

- **SQL Server is now supported.** Connect with SQL authentication, browse databases, schemas, tables, views, columns, indexes and foreign keys, and work with your SQL Server data next to MySQL, PostgreSQL and SQLite.
- TLS is on by default; you can opt into a trusted-self-signed certificate or point to a CA file, and certificate checks still work through SSH tunnels.
- Query results are paginated, and each result set from a stored procedure or batch opens in its own tab.
- Table design covers create/alter/drop for tables, columns, indexes and foreign keys, including computed columns, check constraints, identity columns and column comments.
- Execution plans render as a visual tree with warnings for missing join predicates, key lookups, spills and implicit conversions.
- AI Chat and Agent read-only queries work on SQL Server too, with the same guardrails as the other engines.
- The table preview sorts by the primary key when one exists, so paging is stable.
- The result panel's Copy menu gained an SQL (INSERT) item; the standalone Copy INSERT button moved into that menu.
- Date and time cells are wider while editing, and the calendar icon is visible in dark themes.
- A one-time notice appears when a database server is older than the version this release was verified against, so a missing feature is easier to explain. Connections are never blocked.

Known limits: parameterized queries are not available for SQL Server, and monitoring is not available for SQL Server yet.

### 中文

- **新增 SQL Server 支持。** 使用 SQL 账号连接，浏览数据库、schema、表、视图、列、索引与外键，和 MySQL、PostgreSQL、SQLite 在同一个工作区里协作。
- 默认开启 TLS；可选用自签名证书，或指定 CA 文件。通过 SSH 隧道连接时证书校验仍然生效。
- 查询结果支持分页；存储过程或批处理返回的每个结果集都独立显示为一个标签页。
- 表设计覆盖表、列、索引、外键的建、改、删，含计算列、CHECK 约束、IDENTITY 列与列注释。
- 执行计划以可视化树呈现，并提示缺失连接条件、键查找、溢出到临时表与隐式转换。
- AI Chat 与 Agent 的只读查询同样支持 SQL Server，安全护栏与其他引擎一致。
- 表预览在有主键时按主键排序，翻页更稳定。
- 结果面板的「复制」菜单新增 SQL（INSERT）项，原来单独的「复制 INSERT」按钮并入该菜单。
- 日期与时间单元格在编辑时更宽，深色主题下日历图标可见。
- 连接低于本版已验证的数据库版本时提示一次，便于判断功能缺失的原因；不会阻止连接。

已知限制：SQL Server 暂不支持参数化查询，监控功能暂不支持 SQL Server。

## [0.4.12] - 2026-11-05

### English

- Query results now paginate locally, so large result sets render smoothly instead of freezing the table.
- The query panel supports 50/100/200/500 rows per page, and page changes apply instantly.
- Table preview and query results now share the same pagination bar and page-size options.
- The chart Y-axis picker is now a compact dropdown instead of a permanently expanded list.
- The table column menu stays inside the window, so long field names are no longer clipped.
- AI-generated SQL no longer adds a 10-row LIMIT by default; a 100-row safety cap applies. When results may exceed 100 rows, the chat offers a shortcut to run the query in the panel for more.
- AI Chat inline results show 10 rows per page by default, with 10/20/50/100/200 options.

### 中文

- 查询结果支持本地分页，大结果集不再因一次性渲染而卡顿。
- 查询面板每页可选 50/100/200/500，翻页即时生效。
- 表预览与查询结果使用同一套分页控件和每页选项。
- 图表 Y 轴改为紧凑下拉浮层，不再长期展开占用工具栏。
- 表预览的字段菜单限制在窗口内，长字段名不再被左侧裁掉。
- AI 生成的 SQL 默认不再追加 10 行 LIMIT，由客户端以 100 行安全上限兜底；结果可能超过 100 行时，聊天内提供“去面板执行”查看更多。
- AI 对话内联结果默认每页 10 行，可选 10/20/50/100/200。

## [0.4.11] - 2026-11-04

### English

- Results with only numeric columns now render as a bar chart in AI Chat; switch the X column and tick any combination of Y columns to compare several metrics side by side.
- Grouped results by year/month are shown as a time-series line chart automatically.
- Chart detection now respects actual column types, so numeric-looking text (IDs, codes) is no longer treated as a metric.
- Chart rendering stays responsive on extreme numeric ranges.

### 中文

- AI 对话中只有数值的结果会直接生成柱状图，可切换 X 列、勾选任意多个指标列（多 Y）同图对比。
- 按年份/月份分组的结果自动用折线图展示。
- 图表识别结合真实列类型，纯数字文本列（编号、代码）不再被误当数值。
- 极端数值范围下图表渲染保持流畅。

## [0.4.10] - 2026-11-03

### English

- Heartbeats now include the VS Code version and OS kernel/version; activity is reported after real usage, at most once a day.
- AI Chat can see larger schemas and keep longer conversations.
- The web console gets a cleaner sidebar with a mobile drawer.

### 中文

- 心跳新增 VS Code 版本与系统内核/版本；真实使用后也会补报活跃，每天最多一次。
- AI 助手可以看到更大的表结构、保留更长对话。
- Web 控制台界面更新：侧栏与移动端抽屉更清爽。

## [0.4.9] - 2026-11-02

### English

- Install/active telemetry no longer depends on VS Code's global telemetry switch; the extension's own telemetry setting is the only control.
- A one-time notice explains what is sent and offers to turn anonymous stats off.
- Heartbeats and refresh rejections are now diagnosable in the **DevBelt Diagnostics** output channel.

### 中文

- 安装/活跃统计不再依赖 VS Code 全局遥测开关，仅由扩展自身的遥测设置控制。
- 首次激活时若全局遥测关闭，会弹一次说明，并提供「关闭匿名统计」。
- 心跳与刷新被拒原因会写入 **DevBelt Diagnostics** 输出面板，便于排查。

## [0.4.8] - 2026-11-02

### English

- Marketplace and GitHub README images/links now render correctly.
- Signing in to the same account from another VS Code window no longer shows a false account-switch warning.
- Security and stability improvements.

### 中文

- 修复 Marketplace 与 GitHub README 的图片/链接渲染。
- 另一个窗口登录同一账号时不再误弹账号切换警告。
- 安全与稳定性改进。

## [0.4.7] - 2026-10-30

### English

- Security updates and stricter email/payment validation; feedback supports three 2 MiB images.
- Local path overrides are isolated per account, with a bulk fix command.
- Browser authenticator unlock is opt-in and lasts 30 minutes in the current tab.

### 中文

- 安全升级与更严格的邮箱/支付校验；反馈支持 3 张 2 MiB 图片。
- 本机路径覆盖按账号隔离，并支持批量补齐。
- 网页验证器解锁改为可选，仅在当前标签页保留 30 分钟。

## [0.4.6] - 2026-10-30

### English

- Local path overrides are isolated per account.
- Passwords stay in the system secure storage.

### 中文

- 本机连接路径覆盖按账号隔离。
- 密码保存在系统安全存储中。

## [0.4.5] - 2026-10-30

### English

- Authentication and AI key handling received the first batch of security hardening.

### 中文

- 认证与 AI Key 处理完成第一批安全加固。

## [0.4.4] - 2026-10-30

### English

- Documentation only: the Marketplace page is Chinese by default, with the English README on GitHub.

### 中文

- 仅文档调整：Marketplace 默认显示中文，英文 README 移至 GitHub。

## [0.4.3] - 2026-10-29

### English

- Feedback supports up to three screenshots and has dedicated sidebar entries.
- The feedback panel is now a single readable column.
- AI result charts support negative values with line charts.
- Free-plan engine fallback, import/export copy and authenticator quota messages are corrected.

### 中文

- 反馈支持最多 3 张截图，侧边栏入口并列展示。
- 反馈面板改为单列，窄编辑器分组下更易读。
- AI 结果图表支持负数，自动使用折线图。
- 修正 Free 套餐引擎兜底、导入/导出与验证器配额提示。

## [0.4.2] - 2026-10-29

### English

- In-app feedback with replies, unread badges and anonymous/account-linked submissions.
- Anonymous daily heartbeat for install and active-installation counts.
- Result charts support multiple Y axes, editable titles and per-column aggregation.
- Sync diagnostics, failure notifications, auto-unlock and slow-query accuracy improved.
- Free plan capabilities are enforced: ER diagrams and profile export are Pro, with at most two open connections.
- Quota and account-switch errors are clearer and localized.

### 中文

- 应用内反馈与站内回复，支持未读徽标、匿名/账号关联提交。
- 每日匿名心跳统计安装与活跃安装。
- 结果图表支持多 Y 轴、可编辑标题与按列聚合。
- 同步诊断、失败提示、自动解锁与慢查询准确性改进。
- Free 能力边界生效：ER 图与连接配置导出为 Pro，最多同时打开 2 个连接。
- 配额与切号错误提示更清晰并完成本地化。

## [0.4.1] - 2026-10-28

### English

- Authenticator entries, groups, tags and secrets are isolated per account.
- AI domain context, default directives and business rules are per account.
- Data Check now reports items it could not restore instead of claiming success.

### 中文

- 验证器条目、分组、标签与密钥按账号隔离。
- AI 域上下文、默认指令与业务规则按账号隔离。
- 数据体检不再把「未修复」报成「已修复」。

## [0.4.0] - 2026-10-27

### English

- Data monitoring for MySQL/PostgreSQL/SQLite: row count, metric and new-row checks, with background tasks and AI proposals.
- Connections, saved queries, history, audit log and backup schedules are isolated per account.
- AI chat history, model access and keys are per account; long conversations are compressed instead of truncated.
- Monitoring requests can use Agent mode, with explicit confirmation before creating anything.
- Redis key paging is configurable, and result grids gain per-column sorting with a persistent pagination bar.

### 中文

- MySQL/PostgreSQL/SQLite 数据监控：行数、指标、新增行检查，支持后台任务与 AI 提案。
- 连接、保存查询、历史、审计日志与备份计划按账号隔离。
- AI 对话历史、模型接入与 Key 按账号隔离；长对话压缩而非截断。
- 监控请求可使用 Agent 模式，创建前必须显式确认。
- Redis 键分页可配置；结果表格支持列排序与固定分页栏。

## [0.3.0] - 2026-10-24

### English

- AI Chat Agent mode with approval-gated writes.
- MCP server exposing read-only tools to local AI clients.
- Masked export and foreign-key subset export.
- EXPLAIN ANALYZE and a redesigned plan panel.
- Read-only connections are enforced at the database level.

### 中文

- AI Chat Agent 模式，写操作需显式审批。
- MCP Server，向本地 AI 客户端提供只读工具。
- 脱敏导出与外键子集导出。
- EXPLAIN ANALYZE 与执行计划面板改版。
- 只读连接改为数据库层强制生效。

## [0.2.0] - 2026-10-23

### English

- Visual EXPLAIN for MySQL, PostgreSQL and SQLite with plan trees and warnings.
- AI plan explanation and index suggestions.
- Slow Queries panel built from local query history.
- SQL diagnostics for `.sql` editors.
- Data dictionary export as Markdown or HTML.

### 中文

- MySQL、PostgreSQL、SQLite 可视化执行计划，支持计划树与告警。
- AI 解释计划与索引建议。
- 基于本地查询历史的慢查询分析。
- `.sql` 编辑器 SQL 诊断。
- 数据字典导出为 Markdown 或 HTML。

## [0.1.0] - 2026-10-21

### English

- Multi-engine SQL workspace for MySQL, PostgreSQL and SQLite.
- Redis and Elasticsearch clients with dedicated browsers and consoles.
- AI assistant: chat, NL2SQL, explanations, diagnosis, data Q&A, charts and inline completion.
- End-to-end encrypted personal connection/query sync.
- Security controls, local authenticator and a complete bilingual UI.

### 中文

- MySQL、PostgreSQL、SQLite 多引擎 SQL 工作区。
- Redis 与 Elasticsearch 客户端，含专用浏览器与控制台。
- AI 助手：对话、NL2SQL、解释、诊断、数据问答、图表与行内补全。
- 个人连接/查询端到端加密同步。
- 安全控制、本地验证器与完整中英双语界面。