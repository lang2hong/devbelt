# Changelog

All notable changes to DevBelt DB Client are documented in this file.

本文件记录 DevBelt DB Client 的所有重要变更。

## [0.4.0] - 2026-10-27

### English

#### Added

- **Data monitoring** (on by default, every task is created by you): scheduled read-only checks on MySQL, PostgreSQL and SQLite tables, with VS Code notifications when a condition is met.
  - **Row count**: right-click a table → More… → *Monitor Row Count…*, pick an interval and a condition. No model is involved.
  - **Metric**: one read-only `SELECT` returning one row with 1–10 numeric columns (for example a freshness lag); the notification compares one chosen column.
  - **New rows**: watches an existing integer or date/time column for rows added since the last check; rows sharing the same value are de-duplicated by primary key.
  - In Agent mode the assistant can only **propose** a metric or new-rows task with `propose_monitor`; a card shows the SQL / column, current values and warnings, and nothing is created until you click *Create and start*. The proposal is validated again on confirmation. Right-click → *Set Up Monitoring with AI…* opens the chat with Agent on.
  - **The alert condition is yours to decide**: the condition the assistant suggests is shown as a suggestion, and creating stays disabled until you adopt it or pick your own type and value. The assistant is told not to invent a threshold when you did not ask for one, and a suggested condition never takes effect on its own.
  - **Background Tasks** (More menu in AI Chat, status bar, or command), newest first: list, line or bar chart, check history, latest new rows, next check time and failure count, pause / resume / check now / remove, **edit the interval and alert condition**, and *Ask AI to explain*, which sends only the numeric history unless you tick *include the latest new rows* (sensitive columns redacted).
  - Intervals: 1 minute to 24 hours in the picker, plus custom values from 5 seconds (5 s is the floor, to protect the database); the interval can be changed later without recreating the task.
  - Safety: checks run on an isolated session made read-only at the database level, with a 30 s timeout, no query history and one check at a time per connection + database + schema; production connections are refused unless `devbelt.ai.monitor.allowProduction` is on; at most 5 tasks per connection and 20 in total; tasks are paused every time VS Code starts, after three failures in a row, or when their connection is removed or changed; only one VS Code window runs and edits them (other windows are view-only; when that window closes, another takes over with the tasks paused). Task definitions and up to 500 history points per task stay under the extension's global storage, including the cursor value and up to 1000 primary-key values of rows already seen for new-rows tasks; new-row contents are kept in memory only.
- Settings: `devbelt.ai.monitor.enabled`, `allowProduction`, `queryTimeoutSeconds`, `notifyCooldownMinutes`, `maxTasks`; `devbelt.redis.keyPageSize`.
- **Connections, groups, saved queries, query history, audit log and backup schedules are per account too.** Switching accounts closes the previous account's sessions and result panels (connection ids may point to a different connection), then reloads the tree. The first time you use an account, a one-time dialog offers to copy the local connections/history/audit into it (copy only; the signed-out data stays).
- **AI data is per account**: chat history, model-access preferences and the API key now live in an account scope (`local` when signed out). Switching accounts shows that account's data; existing local data is copied, not moved, so nothing disappears. Quota and the account hub refresh on switch.
- Slow Queries, query history, the audit log, connection-pool status, Background Tasks and the authenticator are now reachable from the sidebar **⋯** menu and the connection node's Tools menu; Format SQL is in the editor context menu.
- **Long conversations are compressed instead of truncated**: the last 8 messages stay verbatim and older ones become a rolling model-written summary (cached in the session, refreshed only when 4+ new old messages accumulate; a deterministic compact transcript is used if the model is unavailable). The context drawer shows how much was summarized and how many characters are injected.
- **Monitoring requests switch on Agent mode automatically** (the toggle visibly turns on and a one-line notice explains why) so `propose_monitor` is available; nothing is created without confirming the card. The tables you mention in the message are now ranked first when the schema context has to be trimmed.
- Redis key tree: `devbelt.redis.keyPageSize` controls how many keys one “Load more” click scans (default 2000, range 200–5000; previously a fixed 500).
- Result grid: a sort icon on every column header (ascending → descending → clear) with `aria-sort`; the pagination bar stays visible while the result set scrolls; the AI side drawer can be dragged wider and remembers its width.

#### Fixed

- Pressing Enter to pick a candidate in a Chinese/Japanese IME no longer sends the AI Chat message or runs the Redis console command.
- The connection test can no longer stay on "Testing…": it always returns within 45 seconds, and Elasticsearch timeouts now include the method and URL.
- PostgreSQL Agent runs used the selected database name as the schema and kept querying the connection's default database; they now use the selected database with the connection's schema.
- Discarding a monitoring proposal removes the card, and it no longer comes back when the conversation is reopened.
- Opening a task in Background Tasks shows its chart and history right away instead of waiting for a check.
- Agent mode only falls back to plain chat when the tool definitions are really rejected; other request errors are shown as they are.
- The server logs rejected AI Chat requests (validation code and field-level reason only, no message content), so 400 errors can be diagnosed.
- Account isolation follow-ups: connection passwords are stored per account, so editing or deleting a copied connection in one account no longer changes another; switching accounts reloads the current account's passwords, closes in-flight sessions, and pauses Background Tasks (their connection ids belong to the previous account); clearing a BYOK key in an account no longer brings the local key back; the copy prompt now includes saved queries, query folders and backup schedules.

#### Known limitations

- Row count only sees the net change (10 inserts and 10 deletes look like no change); new-rows monitoring does not see updates or deletes.
- Nothing is checked while VS Code is closed.
- When more than 50 new rows arrive in one check, rows inserted between counting them and reading the new cursor maximum can be skipped.
- A slow metric query (trial run of 5 s or more) is only flagged on the card; it is not blocked. Creating a metric task runs the query up to three times (proposal, re-check on confirm, baseline).
- If a laptop sleeps for longer than the lock timeout, two windows can briefly both run a check before the old one notices it lost the lock; a new-rows notification may then repeat once.
- PostgreSQL monitoring is covered by unit tests only in this release.

### 中文

#### 新增

- **数据监控**（默认可用，任务都由你创建）：定时只读检查 MySQL、PostgreSQL、SQLite 的表，命中条件时弹 VS Code 通知。
  - **行数**：表右键 → 更多… →「监控行数变化…」，选间隔和提醒条件，不调用模型。
  - **指标**：一条只读 `SELECT`，返回 1 行、1–10 列数值（例如数据新鲜度延迟）；提醒比较其中一列。
  - **新增行**：基于表里已有的整数或时间列，检查上次之后新增的行；游标值相同的行按主键去重。
  - Agent 模式下，助手只能用 `propose_monitor` **提出**指标或新增行任务；对话里显示提案卡片（SQL / 列、当前值、提示），你点「创建并开始」才会创建，确认时会再校验一次。表右键 →「让 AI 帮我设置监控…」会打开对话并开启 Agent。
  - **提醒条件由你决定**：助手给出的条件只作为建议显示，必须你点「采用」或自己选类型和数值，创建按钮才可用。助手被告知你没说阈值时不要自己编，建议的条件也不会自动生效。
  - **后台任务**（AI Chat「⋯」菜单、状态栏或命令），按创建时间倒序：任务列表、折线图或柱状图、检查记录、最近新增的行、下次检查时间与连续失败次数，暂停 / 继续 / 立即检查 / 删除、**修改间隔和提醒条件**，以及「让 AI 解读」——默认只发送数值历史，勾选「附带最近的新增行」才会发送行内容（敏感列遮蔽）。
  - 间隔：预设 1 分钟到 24 小时，也可以自定义，最短 5 秒（保护数据库）；创建后还能直接改间隔，不用重建任务。
  - 安全：在独立会话上执行并在数据库层设为只读；单次超时 30 秒，不写查询历史，同一「连接 + 库 + schema」一次只跑一个检查；生产连接默认拒绝，需开启 `devbelt.ai.monitor.allowProduction`；每个连接最多 5 个、总共最多 20 个任务；每次启动 VS Code、连续失败 3 次、连接被删除或修改时任务自动暂停；只有一个 VS Code 窗口执行和修改任务（其他窗口只能查看；该窗口关闭后由其他窗口接手，任务先暂停）。任务定义和每个任务最多 500 个历史点保存在扩展的全局存储里，新增行任务还会保存游标值和最多 1000 个已见行的主键值；新增行内容只保存在内存中。
- 设置：`devbelt.ai.monitor.enabled`、`allowProduction`、`queryTimeoutSeconds`、`notifyCooldownMinutes`、`maxTasks`；`devbelt.redis.keyPageSize`。
- **连接、分组、保存的查询、查询历史、审计日志、备份计划也按账号隔离。**切换账号会关闭上一个账号的会话和结果面板（连接 id 在新账号里可能指向另一条连接），再重新加载树。第一次进入某个账号时会问一次是否把本机的连接/历史/审计复制过去（只复制；未登录的数据保留）。
- **AI 数据按账号隔离**：对话历史、模型接入偏好、apiKey 现在存放在账号作用域里（未登录为 `local`）。切换账号后看到的是该账号的数据；旧的本机数据是「复制」而不是「移动」，不会消失。额度和账号中心会随切换刷新。
- 慢查询分析、查询历史、审计日志、连接池状态、后台任务、验证器现在都能从侧栏 **⋯** 菜单和连接节点的「工具」菜单点开；「格式化 SQL」加到了编辑器右键菜单。
- **长对话改为压缩而不是截断**：最近 8 条保留原文，更早的消息由模型写成滚动摘要（存在会话里，攒够 4 条旧消息才更新；模型不可用时退回确定性压缩）。上下文抽屉会显示压缩了多少条、注入了多少字符。
- **监控类请求会自动开启 Agent 模式**（开关会明显变为开启，并有一行说明），这样才有 `propose_monitor`；不确认卡片不会创建任何任务。你消息里提到的表在表结构超预算时会被排到最前面。
- Redis 键树：新增 `devbelt.redis.keyPageSize`，控制点一次「加载更多」扫描多少键（默认 2000，范围 200–5000；原来是固定 500）。
- 结果表格：每个列头都有排序图标（升序 → 降序 → 取消），并带 `aria-sort`；结果滚动时分页栏固定在底部可见；AI 侧抽屉可拖宽并记住宽度。

#### 修复

- 中文 / 日文输入法按回车选词时，AI Chat 不再误发送，Redis 命令行也不再误执行。
- 测试连接不会再一直停在「测试中」：45 秒内一定返回结果；Elasticsearch 超时信息会带上请求方法和地址。
- PostgreSQL 上 Agent 把选中的库名当成了 schema，并且一直查询连接的默认库；现在使用选中的库和连接配置的 schema。
- 放弃监控提案后卡片直接移除，重新打开会话也不会再出现。
- 在「后台任务」里打开任务，图表和检查记录会直接显示，不用等下一次检查。
- Agent 模式只在工具定义确实被拒绝时才退回普通问答，其他请求错误按原因显示。
- 服务端会记录被拒绝的 AI Chat 请求（只记校验代码和字段级原因，不记消息内容），方便排查 400 错误。
- 账号隔离补漏：连接密码按账号分键存放，在一个账号里修改或删除复制来的连接不会再影响另一个账号；切换账号会重新加载当前账号的密码、关闭在途会话，并暂停后台任务（任务里的连接 id 属于上一个账号）；在账号里清除自带 Key 后不会再被本机 Key 复制回来；迁移提示复制的内容补上了保存的查询、查询文件夹和备份计划。

#### 已知限制

- 行数监控只看净变化（新增 10 行、删除 10 行显示为无变化）；新增行监控看不到修改和删除。
- VS Code 关闭期间不检查。
- 一次新增超过 50 行时，在统计行数和读取新游标最大值之间插入的行可能被跳过。
- 指标查询较慢（试执行 ≥ 5 秒）时只在卡片上提示，不拦截。创建一个指标任务最多会执行 3 次该查询（提案、确认时复核、取基线）。
- 笔记本睡眠超过锁超时后唤醒，旧窗口发现自己失去锁之前，两个窗口可能各执行一次检查，新增行提醒可能重复一次。
- 本版本 PostgreSQL 的监控只有单元测试覆盖。

## [0.3.0] - 2026-10-24

### English

#### Added

- **Agent mode in AI Chat** (off by default): schema inspection, read-only SQL and plain EXPLAIN in a step-by-step loop, with step limits, cancellation and a fallback to plain chat when the model does not support tool calling.
- **Approval-gated writes**: the agent can propose one DML or DDL statement; a native modal shows the target, SQL, dry-run impact and irreversibility, and only an approved statement is executed. MySQL/PG DML is dry-run inside a rolled-back transaction; triggers, DDL and SQLite never run a dry run.
- **Execution ledger**: every write approval and result is appended to `<globalStorage>/agent/ledger.jsonl` with fsync; `PROPOSED`/`EXECUTING` failures block the operation, interrupted executions recover as `UNKNOWN`.
- **MCP server** (off by default): loopback-only Streamable HTTP with per-client bearer tokens, rate limits, Host/Origin checks and an audit log; exposes the five read-only tools for one configured connection.
- **Masked export**: deterministic column masking (email/phone/name/address/idCard/bankCard/redact/null/fixed/regex/hash), PII columns require an explicit rule, preview before export, CSV/SQL output, atomic writes.
- **Foreign-key subset export**: bounded `referenced`/`referencing` closure with depth and row limits, single-column keys only, dependency-ordered SQL, and shared masking domains so masked keys still match.
- **EXPLAIN ANALYZE** ("Execute" in the plan panel; MySQL 8 and PostgreSQL): really executes one read-only `SELECT`/`WITH`/`VALUES` after a confirmation, on a separate read-only session that can be cancelled and honours `devbelt.sql.queryTimeoutSeconds`. Production connections are refused unless `devbelt.explain.allowAnalyzeProduction` is on. MySQL TREE output is parsed into the plan tree; refusals and failures keep the current plan on screen.
- Settings: `devbelt.ai.agent.*`, `devbelt.mcp.*`, `devbelt.masking.configPath`, `devbelt.explain.allowAnalyzeProduction`.

#### Changed

- **Plan panel redesign**: three tabs, Table (default) / Plan tree / JSON. For MySQL the table shows the traditional `EXPLAIN` columns (`id`, `select_type`, `table`, `type`, `possible_keys`, `key`, `key_len`, `ref`, `rows`, `filtered`, `Extra`), read with an extra plain `EXPLAIN` that does not execute the statement (derived from the JSON plan if that fails); PostgreSQL shows one row per plan node, SQLite its plan rows. Problem rows are highlighted with a short note; a full scan with no condition on that table is noted as expected instead of flagged. One or two plain-language conclusions sit above the table, with index suggestions below it; a badge shows whether the plan is an estimate or an executed run (with time); the SQL is a collapsible, copyable line formatted for the dialect. Buttons are now "Run again" and "Execute".
- Query results and the plan panel open as a new tab in the current editor group instead of splitting the editor.
- AI "Explain plan" answers (and visible reasoning) in Chinese when the UI is Chinese.
- **Read-only SQL connections are now enforced by the database**, not only by client-side SQL checks: MySQL `SET SESSION TRANSACTION READ ONLY`, PostgreSQL `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`, SQLite opened read-only with `PRAGMA query_only=ON`. Statements that previously slipped past the client check (for example `nextval()`, `SELECT … FOR SHARE`, SQLite `ATTACH`) now fail on read-only connections. On MySQL this also blocks creating temporary tables. If the read-only setting cannot be applied, the connection fails instead of opening as writable.

#### Fixed

- SQLite: SQL text could reach the `sqlite3` shell as a dot-command (for example a line starting with `.shell`). Queries are now sent as a single line and dot-commands are rejected. Multi-line SQL and line breaks inside string literals keep working.

#### Known limitations

- SQLite result cells show a stored line break as `\n`; the stored value is correct. This display behaviour is unchanged from earlier versions.

### 中文

#### 新增

- **AI Chat 的 Agent 模式**（默认关闭）：查 Schema、跑只读 SQL 与普通 EXPLAIN，逐步展示；带步数上限、取消，以及模型不支持工具调用时退回普通问答。
- **写操作审批**：Agent 只能提出单条 DML / DDL；原生模态框展示目标、SQL、dry-run 影响与不可回滚提示，只有批准后才执行。MySQL / PG 的 DML 在事务内试执行后回滚；有触发器、DDL、SQLite 不做试执行。
- **安全执行账本**：每次写审批与结果追加到 `<globalStorage>/agent/ledger.jsonl` 并 fsync；`PROPOSED` / `EXECUTING` 写入失败会阻断操作，异常中断的执行恢复为 `UNKNOWN`。
- **MCP Server**（默认关闭）：仅监听本机的 Streamable HTTP，逐客户端令牌、限流、Host / Origin 校验与审计；只为所选连接暴露 5 个只读工具。
- **脱敏导出**：确定性列脱敏（email/phone/name/address/idCard/bankCard/redact/null/fixed/regex/hash），PII 列必须显式配置规则，导出前预览，支持 CSV / SQL，原子写入。
- **外键子集导出**：受限的 `referenced` / `referencing` 闭包，带深度与行数上限；只支持单列键，按依赖顺序生成 SQL，父子键共享脱敏域。
- **EXPLAIN ANALYZE**（计划面板「实际执行」；MySQL 8 / PostgreSQL）：在计划面板确认后真实执行一条只读 `SELECT` / `WITH` / `VALUES`；使用独立的只读会话，可取消，超时沿用 `devbelt.sql.queryTimeoutSeconds`。生产连接默认拒绝，需开启 `devbelt.explain.allowAnalyzeProduction`。MySQL 的 TREE 文本解析为计划树；被拒绝或失败时保留当前计划。
- 设置：`devbelt.ai.agent.*`、`devbelt.mcp.*`、`devbelt.masking.configPath`、`devbelt.explain.allowAnalyzeProduction`。

#### 变更

- **执行计划面板改版**：三个标签：表格（默认）/ 计划树 / JSON。MySQL 表格为传统 `EXPLAIN` 列（`id`、`select_type`、`table`、`type`、`possible_keys`、`key`、`key_len`、`ref`、`rows`、`filtered`、`Extra`），通过额外一次不执行语句的普通 `EXPLAIN` 读取，失败时由 JSON 计划推导；PostgreSQL 每个计划节点一行，SQLite 显示计划行。有问题的行高亮并附简短说明；对该表没有过滤条件的全表扫描注明属正常，不再标红。表格上方是一两句结论，下方是索引建议；顶部标明「估算」或「实际执行（耗时）」；SQL 为可展开、可复制的一行，按方言格式化。按钮改为「重新运行」「实际执行」。
- 查询结果与执行计划面板在当前编辑器组新开标签页，不再分屏。
- 中文界面下，AI 解释计划的回答与可见推理使用中文。
- **只读 SQL 连接改为在数据库层生效**，不再只依赖客户端 SQL 检查：MySQL 使用 `SET SESSION TRANSACTION READ ONLY`，PostgreSQL 使用 `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`，SQLite 以只读方式打开并设置 `PRAGMA query_only=ON`。过去能绕过客户端检查的语句（如 `nextval()`、`SELECT … FOR SHARE`、SQLite `ATTACH`）在只读连接上会报错；MySQL 上也无法再创建临时表。只读设置失败时建连失败，不会降级为可写。

#### 修复

- SQLite：SQL 文本可能被 `sqlite3` 命令行当作点命令执行（例如以 `.shell` 开头的行）。现在查询以单行发送并拒绝点命令；多行 SQL 和字符串中的换行不受影响。

#### 已知限制

- SQLite 结果中存储的换行显示为 `\n`，实际存储值正确；这一显示行为与之前版本相同。

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