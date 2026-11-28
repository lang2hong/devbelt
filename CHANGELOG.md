# Changelog

All notable changes to DevBelt DB Client are documented in this file.

本文件记录 DevBelt DB Client 的所有重要变更。

## [0.4.22] - 2026-11-28

### English

- **MariaDB is now a first-class engine.** Create MariaDB connections directly (10.11 / 11.4 / 11.8 / 12.3 LTS); the tree, status panel, plans and MCP treat it as MariaDB while the engine reuses the MySQL implementation. Existing MySQL-type connections that are actually MariaDB are detected and can be switched with one click.
- **Browse and manage sequences.** A Sequences category lists MariaDB sequences with start/increment details; view the definition, create from a template, or delete with confirmation. `NEXT VALUE FOR`, `NEXTVAL` and `SETVAL` count as writes for read-only and AI auto-run.
- **Real execution plans on MariaDB.** The plan panel uses `ANALYZE FORMAT=JSON` for actual execution and understands MariaDB's filesort and temporary-table nodes.
- **Safer MariaDB specifics.** JSON columns stay text end-to-end; `ed25519` accounts fail with an actionable message instead of a driver TODO.
- **Connection details.** Reveal a saved password on demand in the edit form; copy connection info from the tree or form — summary without password by default, full connection string only after confirmation.
- **Anonymous engine statistics.** Heartbeats can include which engines were used that day (fixed enum; never hosts, databases, users or SQL). Controlled by the existing telemetry settings.
- **MCP and AI.** MariaDB connections can be exposed over MCP and used as AI schema context like MySQL.

> MariaDB connections require 0.4.22 or later to sync across devices.

### 中文

- **MariaDB 成为独立引擎。** 新建连接可直接选择 MariaDB（10.11 / 11.4 / 11.8 / 12.3 LTS）；连接树、状态面板、执行计划和 MCP 都按 MariaDB 展示，底层复用 MySQL 实现。已有的 MySQL 类型连接如果实际是 MariaDB，会自动识别并提示一键改为 MariaDB。
- **序列可浏览、可管理。** 连接树新增「序列」分类，显示起始值与步长；可查看定义、按模板新建、确认后删除。`NEXT VALUE FOR`、`NEXTVAL`、`SETVAL` 按写入处理，只读连接与 AI 自动执行都会拒绝。
- **MariaDB 实际执行计划。** 计划面板用 `ANALYZE FORMAT=JSON` 获取真实行数与耗时，并识别 MariaDB 的 filesort 与临时表节点。
- **MariaDB 细节处理。** JSON 列全程按文本处理；`ed25519` 账号会得到可操作的提示，而不是驱动的 TODO 报错。
- **连接信息。** 编辑连接时可按需显示已保存密码；连接树或表单可一键复制连接信息——默认不含密码，含密码连接串需二次确认。
- **匿名引擎统计。** 心跳可携带当天使用过的数据库类型（固定枚举，不含主机、库名、用户名或 SQL），受现有遥测开关控制。
- **MCP 与 AI。** MariaDB 连接可以像 MySQL 一样通过 MCP 暴露，并作为 AI schema 上下文。

> MariaDB 连接需要 0.4.22 及以上版本才能在设备间同步。

## [0.4.21] - 2026-11-27

### English

- **AI is now DevBelt AI.** The AI entry points (chat, agent, explain/optimize, MCP) now use the DevBelt AI name; behavior is unchanged.
- **Start with a sample database.** Run **Try Sample Database** from the command palette or the empty connection tree to open a bundled SQLite sample (customers, products, orders). You can run queries and ask AI about the schema without configuring MySQL or PostgreSQL first. The sample connection is local-only: it does not sync to other devices and does not count toward your saved-connection limit.
- **Safety is visible where it matters.** Production connections show a **Production read-only · 10s** badge in AI Chat. When AI auto-runs a query, the running indicator also states: read-only auto-run, 10s timeout, writes/DDL never auto-run.
- **AI Error Doctor.** When a query fails, click **Explain & fix** to get a plain-language cause and a corrected SQL, compare the original and fixed statements, then apply the fix to the editor or run it. Nothing runs automatically; if AI cannot produce a usable fix, it falls back to the existing AI diagnose flow.
- **MCP setup guide.** The MCP config page now walks through exposing a connection, choosing Cursor / Claude / VS Code or another client, and copying the generated config. Tokens stay read-only and can be revoked at any time.

### 中文

- **AI 统一为 DevBelt AI。** 对话、Agent、解释/优化、MCP 等入口统一使用 DevBelt AI 名称，功能行为不变。
- **内置示例库，打开就能用。** 命令面板或空连接树的「试用示例库」会打开内置 SQLite 示例库（customers / products / orders）。不用先配 MySQL 或 PostgreSQL，就能运行查询、让 AI 解释表结构。示例连接只在本机使用：不参与跨设备同步，也不占用保存连接配额。
- **安全模式只在关键处出现。** 生产连接在 AI Chat 顶栏显示「生产只读 · 10s」徽标；AI 自动执行查询时，执行中指示会同时说明：只读自动执行、10 秒超时、写/DDL 不自动执行。
- **AI 报错修复。** SQL 报错时点「解释并修复」，会得到原因和修复后的 SQL；可以对比原 SQL 与修复 SQL，再应用到编辑器或直接运行。不会自动执行；AI 无法给出可用修复时，回退到原有「AI 诊断」。
- **MCP 接入指引。** MCP 配置页增加三步说明：启动连接、选择 Cursor / Claude / VS Code 等客户端、生成并复制配置。token 仍是只读、可随时撤销。

## [0.4.20] - 2026-11-27

### English

- **AI Chat uses the full width.** Messages, SQL blocks, result tables and the composer now fill the panel; only the normal content padding remains, so wide screens no longer waste space on both sides.
- **Long SQL and results fold.** SQL blocks have a fold button in the top-right corner. Long SQL opens with a 16-line preview and a "Show all" control; after expanding, clicking Collapse hides the whole block (header only), and Show all brings the full query back. Blocks of 16 lines or fewer have no fold control, and streaming output stays expanded. Result cards fold from the title row and keep the row count and elapsed time visible.
- **Fewer false "slow query" blocks.** Production auto-run now only holds back queries with no `WHERE`, a leading `%` in `LIKE`, or `SELECT DISTINCT *`. Filtered `DISTINCT`, multiple JOINs, subqueries, `GROUP BY`/`HAVING` and `UNION` are allowed to auto-run. A 10-second client timeout cancels a slow production auto-run and asks you to run it manually; manual runs are not timed. Read-only-only, the five-per-reply cap, the serial queue and the MSSQL preflight are unchanged.
- **Wide tables keep all their columns.** The AI schema context no longer stops at 50 columns per table. Auto mode injects at most the 50 most relevant tables (60K characters); tables you select explicitly are loaded up to 200 tables and 110K characters. When the context is truncated, the table badge and schema note say so instead of silently dropping columns. The prompt now forbids borrowing a similar column from another table and tells the model to ask when a column is missing.
- **AI sees schema changes.** After a table is altered — in DevBelt or another client — refreshing the connection tree makes the next AI message reload the table and column metadata, so newly added columns can be used without waiting for the 60-second cache to expire. SQL that was already generated still needs to be regenerated or edited.

### 中文

- **AI Chat 默认占满宽度。** 消息、SQL 代码块、结果表和输入框都占满面板可用宽度，只保留正常内容边距，宽屏下不再两边留白。
- **长 SQL 与结果表可折叠。** SQL 代码块右上角新增折叠按钮；长 SQL 默认显示前 16 行预览并提供「展开全部」，展开后点「收起」会完全收起、只保留标题行，再点「展开」恢复全文。不超过 16 行的代码块不显示折叠按钮，流式生成期间保持展开。结果卡可从标题行折叠，收起后仍显示行数与耗时。
- **减少误拦「慢查询」。** 生产自动执行只拦无 `WHERE`、前导 `%` 的 `LIKE`、`SELECT DISTINCT *`；带过滤的 `DISTINCT`、多 JOIN、子查询、`GROUP BY`/`HAVING`、`UNION` 都可以自动执行。生产自动执行增加 10 秒客户端超时，超时会取消并提示手动运行；手动运行不计时。只读限制、单回复 5 条、串行队列和 MSSQL 预演保持不变。
- **宽表加载全部列。** AI schema 上下文不再限制每表 50 列。自动模式最多注入最相关的 50 张表（60K 字符）；显式勾选的表最多 200 张、110K 字符。上下文被截断时，表徽标和 schema 说明会明确提示，不再静默丢列。提示词新增规则：禁止借用另一张表的相似列，列缺失时要询问用户。
- **AI 跟随表结构变化。** 改表后（DevBelt 内或其他客户端），刷新连接树即可让下一次 AI 请求重新读取表和列，新字段不用等 60 秒缓存过期；已经生成的 SQL 仍需重新生成或手动修改。

## [0.4.19] - 2026-11-26

### English

- **AI auto-run is predictable.** A reply with several read-only SQL blocks now runs them in order, at most five per reply; the rest stay manual with an inline notice. Production connections can auto-run read-only queries, but potentially slow ones (no WHERE, multiple JOINs, UNION, GROUP BY, subqueries, a leading `%` in LIKE) are held back with a notice. Writes and DDL never auto-run. Results default to a table; charts are drawn only when you ask for them. Switching chats, loading history or closing the panel stops queued runs.
- **AI Chat got a visual pass.** Messages use an adaptive centered column (up to 1200px), assistant replies are grouped in low-contrast cards, and long SQL collapses behind a "Show all" control. When a reply has multiple SQL blocks they are numbered **SQL 1 / SQL 2**, and the assistant is instructed to put each query's explanation and confirmation points under its own "Query N" heading. SQL is syntax-highlighted; copy/run/edit actions are icons; result tables have a sticky header, zebra rows and tabular numbers.
- **AI requires signing in.** Chat, agent mode, inline completion and the explain / optimize actions now require an account — including when you use your own API key. Your key and model settings are kept and apply immediately after signing in. Local database work (connections, queries, backup, monitoring, the authenticator) stays available without an account.
- **Per-account data isolation.** Connection passwords, AI keys, chat sessions, monitor tasks and legacy data are separated per account. When several accounts share one machine, a newly signed-in account no longer sees connections, monitor tasks or AI data created by the previous one; connections that had inherited the previous account's password now show no password and ask for it again.
- **Deleting while signed in now sticks.** Connections, groups, saved queries, query folders and backup schedules deleted while signed in no longer reappear after you sign out. Note the other direction: items created or renamed while signed in are not copied back to the signed-out state, so signing out shows what you had before signing in.
- **Write protection follows the live connection.** Read-only and production flags are re-read from the saved connection instead of a panel's startup snapshot: if you switch an open panel's connection to read-only, write actions stop immediately (Redis / Elasticsearch / MongoDB buttons grey out); if the connection is deleted — including a delete synced from another device — its panels close.
- **PostgreSQL 10 works again.** The index query used a column that only exists in PostgreSQL 11+, so listing indexes failed on 10 (table designer, schema compare, schema sync). Index metadata is now fetched with a version-safe query. PostgreSQL 10 is covered by CI for the first time.
- **MongoDB 4.4 is verified.** The CI job for 4.4 could not start the server (it used a shell that 4.4 images do not ship), so 4.4 had never actually been tested. That is fixed and the 4.4 suite now runs and passes.
- **SQLite values keep their type.** Backups, SQL exports and data sync no longer turn integers in untyped columns into text, and no longer fold very large floating-point values into infinity; the backup writer also splits large tables into several INSERT statements and includes indexes.
- **Tighter safety gates.** Elasticsearch confirmation cannot be bypassed by path spelling (trailing slash, encoded names, nested `match_all`, `_aliases` remove, bulk deletes, data-stream/template deletion, `_close`); AI auto-run of Elasticsearch bodies is validated; Redis auto-run uses a read-only command whitelist; MCP tokens are scoped to selected databases; monitor proposals respect `sensitiveTables`.
- **Smaller fixes.** MySQL column edits keep `AUTO_INCREMENT`; schema sync creates parent tables before child tables; editing an index validates before dropping the old one; PostgreSQL database drop works; cancelling the database picker in import/export cancels the operation; deleted AI chats stay deleted; ES auto-run failures explain themselves. Connections closed by the background health check now show as closed in the tree immediately instead of failing only when expanded.

### 中文

- **AI 自动执行更可预期。** 一条回复里有多个只读 SQL 块时按顺序执行，单次最多 5 条；其余保留手动执行并在代码块下方提示。生产连接可以自动执行只读查询，但可能较慢的查询（无 WHERE、多个 JOIN、UNION、GROUP BY、子查询、前导 `%` 的 LIKE）会拦下并提示。写与 DDL 永不自动执行。结果默认表格，只有明确要图表才画图。切换会话、加载历史或关闭面板会停止排队中的执行。
- **AI Chat 视觉整理。** 消息改为自适应居中列（最宽 1200px），助手回复用低对比卡片分组，长 SQL 默认折叠并可「展开全部」。一条回复有多个 SQL 块时显示 **SQL 1 / SQL 2**，并在提示词里要求每个查询的说明和确认点放在各自的「查询 N」下。SQL 增加语法高亮；复制/运行/编辑等操作改为图标；结果表增加 sticky 表头、斑马纹和等宽数字。
- **AI 需要登录。** AI 对话、Agent 模式、行内补全，以及解释 / 优化操作都改为需要登录后使用；自带 Key 也一样。已保存的 Key 与模型配置会保留，登录后立即生效。本地数据库功能（连接、查询、备份、监控、验证器）无需登录即可使用。
- **账号数据隔离。** 连接密码、AI Key、AI 会话、监控任务与旧版本地数据按账号分开存放。同一台电脑上有多个账号时，后登录的账号不再看到上一个账号创建的连接、监控任务和 AI 数据；原先"碰巧"继承了上一个账号密码的同 id 连接，现在会显示没有密码，需要重新输入。
- **登录状态下的删除会保留。** 登录时删除的连接、分组、保存的查询、查询文件夹和备份计划，退出登录后不再出现。反方向要注意：登录时新建或改名的数据**不会**写回未登录状态，退出登录后看到的是登录前的样子。
- **写保护跟随当前连接配置。** 只读与生产标记改为读取已保存的连接，而不是面板启动时的快照：把已打开面板的连接改成只读后，写操作立即被拦住（Redis / Elasticsearch / MongoDB 的写按钮随之变灰）；连接被删除时（包括另一台设备同步过来的删除）相关面板自动关闭。
- **PostgreSQL 10 恢复可用。** 索引查询用到 PostgreSQL 11 才有的列，导致 PG 10 上读取索引失败（表设计器、结构比对、结构同步都受影响）。索引元数据改用版本安全的查询，PG 10 也第一次纳入 CI 验证。
- **MongoDB 4.4 真正经过验证。** 4.4 的 CI 任务此前根本启动不了服务（用了 4.4 镜像里没有的 shell），测试从未执行。已修复，4.4 套件现在会实际运行并通过。
- **SQLite 值保留类型。** 备份、SQL 导出与数据同步不再把无类型列里的整数写成文本，也不会把极大的浮点数折成无穷；备份还把大表拆成多条 INSERT，并带上索引。
- **安全门禁收紧。** Elasticsearch 的危险操作确认不能再靠写法绕过（尾斜杠、编码名、嵌套 `match_all`、`_aliases` remove、批量删除、删数据流/模板、`_close`）；AI 自动执行的 Elasticsearch 请求体增加校验；Redis 自动执行改用只读命令白名单；MCP 令牌绑定到所选数据库；监控提案遵守 `sensitiveTables`。
- **其它修复。** MySQL 改列保留 `AUTO_INCREMENT`；结构同步先建父表再建子表；编辑索引先校验再删旧索引；PostgreSQL 删库可用；导入/导出取消选库即取消；已删除的 AI 会话不会复活；ES 自动执行被拦下时提示可读。后台健康检查关闭的连接会立即在树里显示为已关闭，不再等展开时才报错。

## [0.4.18] - 2026-11-17

### English

- **MCP manager panel.** A new MCP view in the sidebar and a dedicated manager panel replace the old menu popups: expose or hide connections, start/stop each server, pin or restore ports, generate client configs per database, and review or revoke tokens and recent calls in one place. The status bar entry opens the same panel.
- **Multi-database SQL tools and scoped client configs.** MCP and Agent `list_tables` / `describe_table` accept optional `database` / `schema` arguments, so one SQL connection can inspect tables in more than one database. In the client config tab you can tick databases; each one becomes a separate entry with `?database=`, including for PostgreSQL.
- **MCP naming and port controls.** Client config keys use `devbelt_<group>_<name>_<db>_<env>`, drop a group prefix repeated in the connection name, and fall back to a short connection ID. Tokens do not expire; revoke them manually from the manager panel.
- **MCP client presets.** Generate and copy configs for Claude Desktop / Cursor / Copilot, VS Code, Kiro, Trae, Qoder, Windsurf, Cline / Roo Code and OpenCode, each using that client's root key and transport fields. Server keys are ASCII-safe; non-ASCII connection names fall back to the short connection ID.
- **MCP query rows.** SQL `run_read_only_query` returns actual row values by default: 100 rows when `maxRows` is omitted, up to 1000. Results are limited by row count only, not by character clipping; `truncated` means more rows exist. Disable with `devbelt.mcp.includeRows`. Redis / Elasticsearch / MongoDB value samples remain opt-in via `devbelt.mcp.includeSample`.
- **Sensitive values are redacted by default.** Sensitive result columns (`access_key`, `password`, `token`, `secret`, etc.) come back as `[REDACTED]` in both MCP and AI Chat Agent rows. `includeSensitive: true` only works when the host setting `devbelt.mcp.includeSensitive` / `devbelt.ai.agent.includeSensitive` is enabled. Non-sensitive strings still go through embedded-secret redaction.
- **MCP audit, timeout and health.** `get_audit_log` returns the current client's recent calls (SQL redacted/truncated), `timeoutMs` overrides the default SQL timeout up to 120 seconds, `list_tables` accepts `search`, and the loopback server exposes `GET /health`.
- **Sensitive tables and row quotas.** Configure table-name globs in `devbelt.mcp.sensitiveTables` / `devbelt.ai.agent.sensitiveTables` (`secret_config`, `*_credentials`); any query or EXPLAIN that mentions a matching table is rejected, closing the alias/expression gap in column-name masking. Per-client and per-turn row quotas (`devbelt.mcp.maxRowsPerMinute`, `devbelt.ai.agent.maxRowsPerTurn`) stop pagination from draining a whole table. MCP audit SQL now replaces string literals with `?` and `get_business_context` reports `configured` for the whole scope even when a `table` filter returns no notes.
- **MCP token history.** Client tokens are listed newest first. Click a token to see its connection, creation time, last use and call counts, then open a fresh config flow for that connection. Only token hashes are stored, so the original token value is never recoverable.
- **MCP business context.** MCP clients can call `get_business_context` to load connection business rules plus human-maintained table/column notes and sample values. `list_tables` adds a `note` field, `describe_table` adds column `note` / `sample`, and database comments remain separate as `comment`. Server instructions tell clients to call it before generating SQL. Disable with `devbelt.mcp.includeNotes`.
- **MCP metadata is complete.** `list_schemas`, `list_tables` and `describe_table` no longer inherit AI Chat's 50-table / 60-column context budget or the 8,000-character tool-result cap. MCP clients receive the full schema result; only `run_read_only_query` keeps the row limit (100 by default, up to 1000).
- **AI Chat Agent returns query rows.** `run_read_only_query` now returns actual rows in AI Chat Agent mode too: 100 rows by default, up to 1000, without character-based clipping. `devbelt.ai.agent.includeSample` now only controls Redis / Elasticsearch / MongoDB value samples. Table discovery tools also return the complete schema on demand instead of stopping at 50 tables.
- **MCP is a Pro feature.** Pro can expose up to 5 connections; Free sees an upgrade prompt instead of MCP controls. Requests from expired entitlements return `403 pro_required`, and the entitlement is checked again on every request. Existing Pro users keep working with older servers through a `planCode` fallback.
- **Clickable MCP controls.** Start, stop and restart are available as buttons in the MCP panel and the MCP view title; `MCP: Restart Servers` restarts every running exposed connection without changing fixed ports.
- **Monitor from a chosen start date.** AI Chat new-row monitors accept an optional start date (`YYYY-MM-DD`) when the cursor column is a date/time column. The first check counts rows from that date to now; leaving it empty keeps the existing behavior of starting after the current maximum. The proposal card has a date picker, and the task details show the chosen date.
- **Unified read-only auto-run.** `devbelt.ai.autoRunReadOnlySql` (default `true`) now covers MongoDB too: read-only find / aggregate blocks with an explicit collection are executed after a reply and shown inline, just like read-only SQL, Redis commands and Elasticsearch search bodies. Production connections never auto-run; writes and DDL never auto-run. Value samples sent to the model still require `devbelt.ai.agent.includeSample`.

### 中文

- **MCP 管理面板。** 侧栏新增 MCP 视图和独立管理面板，取代原来的菜单弹窗：勾选/取消暴露连接、逐个启停 Server、固定或恢复端口、按数据库生成客户端配置，并在同一处撤销令牌、查看最近调用。状态栏入口打开同一个面板。
- **SQL 多库工具与按库配置。** MCP 与 Agent 的 `list_tables` / `describe_table` 支持可选的 `database` / `schema` 参数，一个 SQL 连接可以查看多个库。客户端配置页可勾选数据库，每个库生成带 `?database=` 的独立条目，PostgreSQL 也适用。
- **MCP 命名与端口控制。** 客户端配置键使用 `devbelt_<分组>_<连接名>_<库>_<env>`，连接名里重复的分组前缀会自动去掉，名称为空时追加短连接 ID。Token 不过期，需要时在管理面板手动撤销。
- **MCP 客户端预设。** 可为 Claude Desktop / Cursor / Copilot、VS Code、Kiro、Trae、Qoder、Windsurf、Cline / Roo Code、OpenCode 生成并复制配置，分别使用对应客户端的根键与传输字段。配置 key 只保留 ASCII；中文连接名回退为短连接 ID。
- **MCP 查询行值。** SQL 的 `run_read_only_query` 默认返回真实行值：不传 `maxRows` 时 100 行，最多 1000 行。只按行数限制，不再按字符裁剪；`truncated` 表示还有更多行。可用 `devbelt.mcp.includeRows` 关闭。Redis / Elasticsearch / MongoDB 的值样本仍由 `devbelt.mcp.includeSample` 控制（默认关闭）。
- **敏感值默认脱敏。** MCP 与 AI Chat Agent 的结果行里，`access_key` / `password` / `token` / `secret` 等敏感列默认返回 `[REDACTED]`；只有宿主设置 `devbelt.mcp.includeSensitive` / `devbelt.ai.agent.includeSensitive` 开启且调用传 `includeSensitive: true` 才返回明文。非敏感字符串仍会做内嵌凭据清理。
- **MCP 审计、超时与健康检查。** 新增 `get_audit_log` 返回当前客户端最近调用（SQL 脱敏/截断）；`timeoutMs` 可覆盖默认 SQL 超时到 120 秒；`list_tables` 支持 `search`；本地服务提供 `GET /health`。
- **敏感表与行数配额。** 可在 `devbelt.mcp.sensitiveTables` / `devbelt.ai.agent.sensitiveTables` 配置表名 glob（如 `secret_config`、`*_credentials`）；命中时查询与 EXPLAIN 整条拒绝，补上别名/表达式绕过列名脱敏的缺口。MCP 每客户端每分钟、AI Chat Agent 每轮的行数配额（`devbelt.mcp.maxRowsPerMinute` / `devbelt.ai.agent.maxRowsPerTurn`）阻止用分页拉走整表。MCP 审计 SQL 现在把字符串字面量替换为 `?`；`get_business_context` 在 `table` 过滤为空时仍按整个 scope 返回 `configured`。
- **MCP 令牌历史。** 客户端令牌按创建时间倒序排列；点击令牌可查看绑定连接、创建时间、最近使用与调用次数，并从该连接进入新的配置生成流程。令牌只保存哈希，历史明文无法恢复。
- **MCP 业务上下文。** MCP 客户端可调用 `get_business_context` 读取连接级业务规则、人工表/列说明和人工样例值。`list_tables` 增加 `note`，`describe_table` 增加列级 `note` / `sample`，数据库注释继续放在 `comment`，不覆盖。Server instructions 会提示客户端在生成 SQL 前先调用该工具。可用 `devbelt.mcp.includeNotes` 关闭。
- **MCP 元数据返回完整结果。** `list_schemas` / `list_tables` / `describe_table` 不再套用 AI Chat 的 50 表 / 60 列预算和 8,000 字符工具结果上限，MCP 客户端拿到完整 schema；只有 `run_read_only_query` 保留行数限制（默认 100，最多 1000）。
- **AI Chat Agent 返回查询行值。** `run_read_only_query` 在 AI Chat Agent 模式也默认返回真实行值：默认 100 行、最多 1000 行，不再按字符截断。`devbelt.ai.agent.includeSample` 现在只控制 Redis / Elasticsearch / MongoDB 的值样本；表发现工具也按需返回完整 schema，不再停在 50 张表。
- **MCP 为 Pro 功能。** Pro 最多暴露 5 个连接；Free 只显示升级引导。权益失效后请求返回 `403 pro_required`，并且每次请求都会重新检查权益。旧服务端没有 `allowMcp` 字段时，Pro 用户通过 `planCode` 回退继续可用。
- **MCP 可点击控制。** MCP 面板和视图标题栏提供启动、停止、重启按钮；`MCP：重启服务` 会重启所有运行中的暴露连接，并保持固定端口不变。
- **监控可指定开始日期。** AI Chat 的新增行监控在游标列为日期时间类型时，可以填写可选的开始日期（`YYYY-MM-DD`）。首次检查会统计该日期至现在的行；留空则保持“从当前最大值之后开始”的原有行为。提案卡片提供日期选择器，任务详情会显示已选日期。
- **统一只读自动执行。** `devbelt.ai.autoRunReadOnlySql`（默认 `true`）现在也覆盖 MongoDB：带显式 collection 的只读 find / 聚合会在回复结束后自动执行并内联展示，与只读 SQL、Redis 命令、Elasticsearch 搜索体一致。生产连接不自动执行；写与 DDL 永不自动执行。向模型发送值样本仍由 `devbelt.ai.agent.includeSample` 控制（默认关闭）。

## [0.4.17] - 2026-11-17

### English

- **MongoDB support.** Connect with `mongodb://` or `mongodb+srv://` (Atlas), browse databases, collections and indexes, page/filter/project documents with `_id` keyset paging, run read-only aggregation pipelines, edit documents, create/drop collections and indexes, and import/export EJSON/JSONL. Free and Pro both include MongoDB.
- **MongoDB batch delete.** Select documents on the current page and delete up to 100 at once. Each document is reported separately, so a partial failure does not hide the successful deletes, and the actual delete count is audited.
- **MongoDB change streams.** Watch a collection or a whole database on a replica set. Pause/resume keeps the resume token, events are shown as EJSON and can be copied, and a watch stops automatically after 100 events or 5 minutes. Standalone servers explain that a replica set is required instead of failing silently.
- **MongoDB transactions and GridFS.** Batch imports and batch deletes can run as replica-set transactions: each 100-document batch commits or rolls back as a unit, and committed batches are kept. SSH tunnels and standalone servers are rejected instead of silently falling back. Browse GridFS buckets and files, and upload, download or delete files with a 50 MB limit.
- **MongoDB masked export (optional).** Normal EJSON/JSONL export is unchanged. When masking is explicitly enabled, masking-core rules are applied to nested paths and array elements, matched fields are previewed before the file is written, and an unmapped PII field aborts the masked export rather than leaking values.
- **MongoDB AI (read-only).** AI Chat gets a MongoDB scope and read-only agent tools for listing databases/collections, field names and types, bounded find/aggregate and `explain()`. MongoView can draft find or aggregation queries and show execution statistics plus index hints. Drafts are not executed until you click Run. In this release the model receives field names, BSON types, indexes and counts only — never document values.
- **MongoDB run actions and tree actions.** `find`/aggregate code blocks in AI Chat now offer **Run in Chat** (inline result table) and **Run in Panel** (opens MongoView with the draft preloaded). Results stay on your machine and are not sent back to the model. The connection tree can also create a database together with its first collection and optional index, create collections, and create/drop indexes from collection nodes.
- **Redis and Elasticsearch auto-run.** Read-only Redis command blocks and search-shaped Elasticsearch DSL blocks now run automatically after a reply, with the same safety rules as SQL auto-run: same connection and scope, never on production connections, and at most 3 blocks per reply. Non-query JSON such as mappings is not executed automatically, and the DSL tab now explains when `size: 0` returns a count without documents.
- **Readable AI Chat charts.** When an X-axis label no longer fits horizontally, charts rotate labels vertically and grow the label area; short labels stay horizontal, and long labels remain available in the hover tooltip.
- **MongoDB MCP.** The local MCP server accepts MongoDB connections with the same six read-only tools. Production connections stay denied, MCP stays off by default, and results contain field names, counts and plan statistics only.

### 中文

- **MongoDB 支持。** 支持 `mongodb://` 与 `mongodb+srv://`（Atlas）连接，浏览数据库/集合/索引，按 `_id` keyset 分页并过滤/投影文档，执行只读聚合管道，编辑文档，创建/删除集合与索引，导入导出 EJSON/JSONL。Free 与 Pro 均包含 MongoDB。
- **MongoDB 批量删除。** 当前页多选后一次最多删除 100 条；逐条报告结果，部分失败不会掩盖已成功删除的文档，审计记录实际删除数。
- **MongoDB Change Streams。** 副本集上可监听单个集合或整个数据库；暂停/继续保留 resume token，事件按 EJSON 展示并可复制，监听在 100 个事件或 5 分钟后自动停止。单机模式会明确提示需要副本集，不会静默失败。
- **MongoDB 事务与 GridFS。** 批量导入/批量删除可选择副本集事务：每 100 条文档一批，整批提交或回滚，已提交批次保留。SSH 隧道与单机直接拒绝，不静默降级。可浏览 GridFS bucket 与文件，并上传/下载/删除文件（50 MB 上限）。
- **MongoDB 脱敏导出（可选）。** 普通 EJSON/JSONL 导出保持原样；显式勾选脱敏后才按 masking-core 规则处理嵌套字段与数组元素，写文件前预览命中字段；PII 字段没有规则时拒绝本次脱敏导出，避免泄露。
- **MongoDB AI（只读）。** AI Chat 新增 MongoDB 作用域与只读 Agent 工具：列库/集合、字段名与类型、受限 find/aggregate、`explain()`。MongoView 可生成查询/聚合草稿并展示执行统计与索引建议。草稿不会自动执行，点击运行才查询；本版本只向模型发送字段名、BSON 类型、索引与计数，不发送文档值。
- **MongoDB 运行入口与树操作。** AI Chat 里的 `find`/聚合代码块新增**在对话中运行**（结果表格内联）与**在面板中运行**（打开 MongoView 并预填草稿），结果只留在本机，不回传给模型。连接树还可以新建数据库及其首个集合（可选初始索引）、新建集合，并在集合节点上创建/删除索引。
- **Redis 与 Elasticsearch 自动执行。** 只读 Redis 命令块和搜索形态的 Elasticsearch DSL 块现在会在回复结束后自动执行，安全规则与 SQL 自动执行一致：连接与作用域必须一致、生产连接不执行、每条回复最多 3 块。映射等非查询 JSON 不会自动执行；DSL 页也会说明 `size: 0` 只返回总数、不返回文档。
- **AI Chat 图表更易读。** X 轴标签横向放不下时自动旋转纵向并增加标签区高度；短标签保持横向，完整长标签仍可在悬停提示中查看。
- **MongoDB MCP。** 本地 MCP 服务器支持 MongoDB 连接，提供同一套六个只读工具。生产连接继续拒绝，MCP 默认关闭，结果只含字段名、计数与执行计划统计。

## [0.4.16] - 2026-11-13

### English

- **Smaller download.** The extension bundle is now minified (about 11.7 MB down to about 6.6 MB), and the bundled `sqlite3.exe` ships only in the Windows packages. Windows x64, Windows ARM64 and a universal package (Linux, macOS and others) are published separately; VS Code picks the right one automatically.
- **Telemetry follows VS Code.** The anonymous heartbeat is sent only when VS Code's telemetry level is `all` and `devbelt.telemetry.enabled` is on. Turning either off stops it immediately. The one-time notice that used to appear when global telemetry was off is gone, because nothing is sent in that case.
- **Easier to report problems.** New command **DevBelt: Report Issue**, and a "Report this issue" button on connection failures, command errors and some sync failures. It opens the feedback form pre-filled with version, system, database type and the error text, with common secrets, addresses and user names masked. Nothing is sent until you review it and press Submit. Please check the text before sending.
- **AI agent for Redis and Elasticsearch.** Turn on Agent mode on a Redis or Elasticsearch connection and the model can look things up with read-only tools: Redis `redis_scan`, `redis_inspect`, `redis_read`, `redis_info`; Elasticsearch `es_list_indices`, `es_mapping`, `es_search`. The model never writes a command: each tool sends a fixed set of requests and every read is bounded (no `KEYS`, `HGETALL` or `SMEMBERS`; at most 20 search hits). Values and document contents stay hidden from the model unless you turn on **Agent: include sample**; with it off the model only sees structure (types, lengths, field names, counts). Redis Cluster is not supported by these tools yet.
- **MCP for Redis and Elasticsearch.** The local MCP server now accepts Redis and Elasticsearch connections with the same read-only tools. MCP is still off by default, only listens on 127.0.0.1, and needs a token. A leaked token now exposes the connection you selected, whichever database engine it is, so treat it like a database password. Production connections stay denied for MCP.
- **SQL Server reads are checked by the server.** SQL Server has no session-level read-only mode, and a keyword check on its own was bypassed in testing (for example `SELECT 1E5DELETE ...` is two statements to the server). Now the agent, `explain_query`, AI auto-run and MCP first ask SQL Server to describe the exact text it is about to run (`SET SHOWPLAN_XML`); only exactly one `SELECT` is allowed, otherwise nothing runs. Verified against SQL Server 2019 and 2022. If the login can write to the database, DevBelt shows a one-time notice with a script that creates a read-only login; writes from the agent still need your approval. A read-only login remains the strongest protection.
- **Security fixes (second round).** AI auto-run now applies the full read-only check on every database, so side-effecting functions and comment/identifier edge cases (a lone `\r` ending a comment in PostgreSQL, `$$` inside an identifier, SQLite `[...]` names) are no longer auto-run. Re-registering an unverified address now uses the password from the latest registration and re-sends the verification link, so someone who pre-registers your address cannot keep access to it. AI top-up packs are no longer marked used up while they still have balance. Row samples mask credentials inside composite field names and Bearer tokens. Elasticsearch requests whose path contains `.` or `..` are rejected.
- **Security fixes.** The self-hosted server now derives the real client address behind a reverse proxy, so sign-in attempt limits and audit logs are per-IP again. The development Docker Compose file no longer ships a default MySQL root password and only publishes its ports on localhost. Connection strings whose password contains `/`, `?` or `#` are now recognised as containing a secret, so the whole string is moved into the editor's secure secret vault instead of staying in plain text. Column types entered in the table designer reject a comma outside parentheses. Deleting rows now checks that every primary-key value is present, instead of producing a condition that cannot match. Queries that use `REPLACE()` as a string function are no longer mistaken for writes on a read-only connection. Row samples sent to the AI mask credentials found inside the values (URLs, password/token pairs, bearer tokens), not only in columns whose name looks sensitive. Database transfer no longer builds a SQL block that a crafted table name could terminate early.
- **AI auto-run and Run in chat.** Auto-run only runs read-only statements, on every engine. Clicking **Run** on a statement that is not read-only (INSERT, UPDATE, DDL and so on) now asks first and offers to run it in the query panel, instead of running straight away in a development environment. The agent now shows the tokens, credits and time of the whole turn, not just the last model call.
- **SQL Server:** import, restore and export use `BEGIN TRANSACTION`, and restore recognizes the transaction statements in exported dumps, so a restored database is committed instead of left in an open transaction. Exported SQL Server dumps no longer contain the source database name, so restoring into another database cannot touch the original tables. `BEGIN TRY` blocks are no longer mistaken for transactions, and `ROLLBACK` is tracked correctly. Monitoring supports schema-qualified tables and rejects date/time cursors on tables without a primary key. A paged query (`OFFSET ... FETCH`) no longer gets a `TOP` added, and ordinary names such as `REPLACE(...)` are no longer rejected.
- **AI:** the model can no longer turn on row samples that you turned off or raise the row limit; SQL Server write proposals that chain a second statement without a semicolon, or call linked servers, are rejected, while ordinary DDL proposals work; the optimize-plan step only runs a single read-only statement.
- **Sync:** each database engine now syncs only the path and URL fields it actually uses (for example a leftover MySQL socket path or connection URL is no longer synced with a Redis or SQL Server connection). Upgrade every device to 0.4.14 or later before using SQL Server connections on a multi-device account.
- **Server:** if the billing configuration cannot be read, the AI proxy now still returns the reserved quota and frees the concurrency slot; docs and plan cards list SQL Server; updated a static-file dependency to remove two moderate advisories.
- **Forgot your password.** The sign-in page now has a **Forgot password?** link. It sends a one-time link valid for 30 minutes; after you set a new password, every signed-in device is signed out and must sign in again. An unverified account is also verified by the same link, so the mailbox owner can always recover an account that someone else pre-registered.
- **PostgreSQL backups keep their structure.** A full backup now includes primary keys, unique/check/foreign keys, indexes and sequences, including `SERIAL` and identity columns. Restoring a dump gives you back the same constraints and auto-increment behaviour, not just the columns and rows.
- **Billing and sync fixes.** Refunding an AI top-up now refuses orders whose tokens were already used, and a failed quota settlement releases the reservation instead of slowly eating the monthly allowance. Manually issued top-ups no longer count as revenue, months with no AI requests show zero cost, and a payment confirmed after the local order expired (or after the plan was archived) is still delivered. On the sync side, a device that has 1,000 records waiting for an unavailable plan now pauses instead of silently dropping the oldest ones, and an already-applied change retried after the 24-hour receipt window no longer gets stuck as a nonce error.
- **New AI pricing.** Pro is now **¥4/month** (was ¥8) and keeps its **1,000 credits** per month; the free tier keeps **200 credits**; top-up credits are **¥4 per 1,000** (was ¥5). Peak-hour margin is 24.5% on both Pro and top-ups; blended margin across peak/off-peak is 43%. Existing subscriptions and already-paid orders are unchanged — the price change only applies to new orders.
- **Device-bound sign-in.** Each DevBelt installation now keeps an Ed25519 key in VS Code's secret storage, and refresh must be signed by it. A stolen refresh token alone can no longer keep a session alive, and the key is bound to the installation/device, not to an account: signing into another account on the same installation reuses it. After updating, sign in once on each device. If the system keychain is unavailable, DevBelt refuses to fall back to the old identifier and tells you how to enable it.
- **One installation identity.** The installation's public-key fingerprint is also used for anonymous install/active telemetry and for the feedback thread key (the feedback key is derived locally and never stored as a separate ID). Existing installs keep their old anonymous ID and feedback key so historical stats and threads still work; new installs do not create separate IDs. The raw OS/VS Code machine ID is used only for device binding and is not sent in telemetry.
- **Known limits:** SQL Server `GO` batch separators are not supported yet; trigger scripts containing `;` are split into separate statements; SQL Server has no dashboard, server-status page or masked export yet. Restore, scheduled backup, drop database, foreign-key, trigger and routine menus stay MySQL/PostgreSQL (and SQLite where applicable) until they are verified against a real SQL Server. Clearing a password on one device does not yet clear it on your other devices. Device binding covers session refresh; access tokens remain short-lived bearer tokens (15 minutes), and the web console still uses HttpOnly cookies plus CSRF. Self-hosted deployments must update the server before updating the extension (the new login body fields are rejected by older servers).

### 中文

- **下载更小。** 扩展代码已压缩（约 11.7 MB 降到约 6.6 MB），内置的 `sqlite3.exe` 只随 Windows 包发布。Windows x64、Windows ARM64 与通用包（Linux、macOS 等）分开发布，VS Code 会自动选择匹配的包。
- **遥测遵循 VS Code 设置。** 匿名心跳只在 VS Code 遥测级别为 `all` 且 `devbelt.telemetry.enabled` 开启时才发送，关闭任意一个立即停止。原先全局遥测关闭时的一次性提示已移除，因为这种情况下不会再发送任何数据。
- **更容易反馈问题。** 新增命令 **DevBelt：报告问题**；连接失败、命令出错和部分同步失败的弹窗新增“反馈此问题”按钮，会打开反馈表单并预填版本、系统、数据库类型和错误文本，常见的密钥、地址和用户名会被遮蔽。你检查并点击提交前不会发送任何内容，提交前请再看一遍文本。
- **Redis 和 Elasticsearch 的 AI Agent。** 在 Redis 或 Elasticsearch 连接上打开 Agent 模式后，模型可以用只读工具查看数据：Redis 有 `redis_scan`、`redis_inspect`、`redis_read`、`redis_info`，Elasticsearch 有 `es_list_indices`、`es_mapping`、`es_search`。模型不会自己写命令：每个工具只发固定的请求，每次读取都有上限（不使用 `KEYS`、`HGETALL`、`SMEMBERS`，搜索最多 20 条命中）。除非你打开 **Agent：包含样本**，值和文档内容不会给模型，它只能看到结构（类型、长度、字段名、数量）。这些工具暂不支持 Redis 集群。
- **MCP 支持 Redis 和 Elasticsearch。** 本机 MCP 服务现在可以暴露 Redis 和 Elasticsearch 连接，工具同样只读。MCP 仍默认关闭、只监听 127.0.0.1、需要令牌。令牌一旦泄露，所选连接（不论哪种数据库）就暴露了，请像对待数据库密码一样保管。生产环境的连接仍然禁止通过 MCP 访问。
- **SQL Server 的读查询由服务器校验。** SQL Server 没有会话级只读，单靠关键字检查在测试中被绕过过（例如 `SELECT 1E5DELETE ...` 在服务器看来是两条语句）。现在 Agent、`explain_query`、AI 自动执行和 MCP 在执行前，会先让 SQL Server 描述将要执行的那段原文（`SET SHOWPLAN_XML`），只有恰好一条 `SELECT` 才放行，否则什么都不会执行。已在 SQL Server 2019 和 2022 上验证。如果登录账号对数据库有写权限，DevBelt 会提示一次，并提供创建只读登录的脚本；Agent 的写入仍需要你批准。只读登录依然是最强的保护。
- **安全修复（第二轮）。** AI 自动执行现在对所有数据库都做完整的只读检查：有副作用的函数，以及注释/标识符的边界写法（PostgreSQL 里单独的 `\r` 结束注释、标识符里的 `$$`、SQLite 的 `[...]` 名称）都不再自动执行。重复注册未验证的邮箱时，以最近一次注册输入的密码为准并重发验证链接，抢先注册你邮箱的人无法保留访问权。AI 加油包不会再在仍有余额时被标成已用完。样本行会遮蔽复合字段名里的凭据与 Bearer token。Elasticsearch 路径包含 `.` 或 `..` 时直接拒绝。
- **安全修复。** 自建服务端在反向代理后会取到真实客户端地址，登录尝试次数限制与审计日志重新按 IP 生效。开发用的 Docker Compose 不再内置 MySQL root 默认口令，端口只发布到本机。密码里含 `/`、`?`、`#` 的连接串现在会被识别为含密钥，整条串会移入编辑器的密钥保险箱，而不是留在明文里。表设计器里的列类型不再接受括号外的逗号。删除行时会校验每个主键值都在，不再生成一个匹配不到行的条件。把 `REPLACE()` 当字符串函数用的查询，在只读连接上不再被当成写操作。发给 AI 的样本行会遮蔽值内部的凭据（URL、password/token 键值、Bearer），不再只看列名。库间传输构造的 SQL 块不会再被刻意构造的表名提前结束。
- **AI 自动执行与对话内运行。** 自动执行在所有数据库上都只运行只读语句。点击**运行**一条不是只读的语句（INSERT、UPDATE、DDL 等）时，现在会先询问，并可以改到查询面板执行；以前在开发环境里会直接执行。Agent 现在会显示整轮的 token、积分和耗时，而不只是最后一次模型调用。
- **SQL Server：** 导入、恢复、导出统一使用 `BEGIN TRANSACTION`，恢复能识别导出文件里的事务语句，恢复后的数据会被提交，而不是留在一个未结束的事务里。导出的 SQL Server 脚本不再写入源库名，恢复到另一个库不会改动原库的表。`BEGIN TRY` 块不再被误判为事务，`ROLLBACK` 的状态跟踪也已修正。监控支持带 schema 的表，并拒绝没有主键的表上的时间游标。带分页的查询（`OFFSET ... FETCH`）不再被加上 `TOP`，`REPLACE(...)` 等普通写法不再被拒绝。
- **AI：** 模型不能再打开你已关闭的行样本，也不能提高行数上限；SQL Server 写入提案里不带分号拼接第二条语句、或调用链接服务器的写法会被拒绝，正常的 DDL 提案可以使用；优化建议的执行计划步骤只运行单条只读语句。
- **同步：** 每种数据库现在只同步自己真正用到的路径和 URL 字段（例如 Redis 或 SQL Server 连接上残留的 MySQL socket 路径、连接 URL 不再被同步）。在多设备账号上使用 SQL Server 连接前，请先把所有设备升级到 0.4.14 或更高版本。
- **服务端：** 读不到计费配置时，AI 代理仍会退回预占额度并释放并发名额；文档与套餐卡片补充 SQL Server；升级一个静态文件依赖，消除 2 个中危公告。
- **忘记密码。** 登录页新增 **忘记密码？**：输入邮箱后会收到 30 分钟内有效的一次性链接。设置新密码后，所有已登录设备都会被退出并要求重新登录。未验证的账号也会被同一链接完成验证，因此即使邮箱被人抢先注册，邮箱所有者仍能找回账号。
- **PostgreSQL 备份保留结构。** 整库备份现在包含主键、唯一/检查/外键、索引和序列（含 `SERIAL` 与 identity 列）；恢复后约束和自增行为与源库一致，不再只有列和数据。
- **计费与同步修复。** AI 加油包退款会拒绝已消耗过 token 的订单；额度结算失败会补退预占，不再慢慢吃掉月额度。手工补偿单不再计入实收，没有 AI 请求的月份成本显示为 0；本地订单已过期或套餐已归档时，渠道确认付款后仍会履约。同步方面：积压 1,000 条待同步记录时改为暂停并提示，不再静默丢弃最旧记录；已成功提交的变更在 24 小时回执过期后重试，也不会再卡在 nonce 错误上。
- **全新 AI 定价。** Pro 现在是 **¥4/月**（原 ¥8），**额度保持 1,000 积分/月不变**；免费档保持 **200 积分/月**；充值积分统一 **¥4/千积分**（原 ¥5）。忙时毛利 Pro 与充值均为 24.5%；忙闲混合 43%。已购买的订阅和已支付订单不受影响——改价只对新订单生效。
- **设备绑定登录。** 每个 DevBelt 安装会在 VS Code 密钥存储里生成一把 Ed25519 设备密钥，刷新会话必须由它签名；只偷到 refresh token 已无法续期。密钥绑定的是安装/设备，不跟账号走：同一安装切换账号会复用同一把密钥。升级后需要每台设备重新登录一次。系统钥匙串不可用时，DevBelt 会拒绝退回旧设备标识，并提示你启用密钥存储。
- **统一的安装身份。** 安装公钥指纹同时用于匿名安装/活跃统计和反馈线程凭证（反馈 key 本地派生，不再单独生成或存储一个反馈 ID）。已有安装保留旧的匿名 ID 与反馈 key，历史统计和旧线程仍可读；新安装不再产生额外 ID。原始 OS / VS Code 机器 ID 只用于设备绑定，不进入遥测。
- **已知限制：** 暂不支持 SQL Server 的 `GO` 批分隔符；含 `;` 的触发器脚本会被拆成多条语句；SQL Server 暂无仪表盘、服务器状态页和脱敏导出。恢复、定时备份、删除数据库、外键、触发器与例程菜单，在真实 SQL Server 上验证完成前，仍只对 MySQL/PostgreSQL（以及适用的 SQLite）开放。在一台设备上清空密码，暂时不会同步清空其它设备上的密码。设备绑定覆盖会话刷新；access token 仍是 15 分钟的短期 bearer，Web 控制台仍使用 HttpOnly cookie + CSRF。自部署用户请先升级服务端再升级扩展（新登录字段会被旧服务端拒绝）。

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