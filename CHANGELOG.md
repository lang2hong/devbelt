# Changelog

All notable changes to DevBelt DB Client are documented in this file.

本文件记录 DevBelt DB Client 的所有重要变更。

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