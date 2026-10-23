# P10 · Insight（0.2.0）

> 状态：代码已交付（0.2.0，2026-10-23）；PostgreSQL 真库、Clean Profile smoke、截图待补
>
> 目标版本：`0.2.0`
>
> 上游：`docs/版本路线图.md`

## 1. 背景

当前 DevBelt 已具备 SQL 执行、EXPLAIN、查询历史、Schema 元数据和 AI 解释能力，但诊断链路仍然偏“文本化”：

- EXPLAIN 结果是原始表格/文本，用户需要自己读；
- 查询历史只有最近 100 条，缺少慢查询聚合；
- 没有索引建议；
- SQL 风险只能靠执行前确认，编辑器内没有静态诊断；
- Schema 文档需要手工整理。

0.2.0 的目标是把这些能力串成：

> 写 SQL → 看计划 → 找瓶颈 → 拿建议 → 生成文档

## 2. 目标

- 三种 SQL 引擎（MySQL / PostgreSQL / SQLite）都能看到结构化执行计划。
- 能从历史查询中定位慢查询，并一键打开 SQL / EXPLAIN。
- 能给出可解释、可复制的索引建议，但不自动执行。
- 在 `.sql` 编辑器中提供可配置的静态诊断。
- 能从 Schema 生成 Markdown / HTML 数据字典。

## 3. 非目标

0.2.0 不包含：

- AI Agent 写库 / 多步自动执行
- MCP Server
- SQL Notebook
- ORM / Migration
- 数据脱敏
- dbt
- SQL Server
- 性能基准平台 / APM
- 自动创建索引

## 4. 用户流程

### 4.1 看执行计划

1. 在 SQL 编辑器选中语句，执行 `EXPLAIN`。
2. 打开 Explain 面板：
   - 左侧计划树；
   - 节点详情；
   - 高亮全表扫描 / filesort / 临时表 / 高成本节点。
3. 点击节点查看表、索引、rows、cost、filter。
4. 可选：让 AI 解释“为什么慢、优先改哪里”。

### 4.2 找慢查询

1. 打开 “Slow Queries” 面板。
2. 默认展示本地查询历史聚合：
   - 总耗时 Top N；
   - 平均耗时；
   - 执行次数；
   - 最近一次执行时间。
3. 按连接、时间范围、关键字过滤。
4. 点击记录：打开 SQL / 直接 EXPLAIN。

### 4.3 看索引建议

1. 在 Explain 面板或慢查询详情点击 “Index suggestions”。
2. 展示：
   - 建议 SQL；
   - 对应查询；
   - 命中字段；
   - 理由与风险（写放大、低选择性、重复索引）。
3. 复制 SQL；不自动执行。

### 4.4 编辑器诊断

打开 `.sql` 文件时：

- 有风险的 `UPDATE/DELETE` 显示 warning；
- `SELECT *`、`NOT IN` + NULL、隐式转换等显示提示；
- 可通过设置关闭规则或整体关闭。

### 4.5 数据字典

1. 右键连接 / 数据库 → “Generate data dictionary”。
2. 选择范围与格式（Markdown / HTML）。
3. 导出到 workspace。
4. 内容包含表、列、类型、可空、默认值、注释、主键、索引、外键。

## 5. 功能规格

### 5.1 可视化 EXPLAIN

#### 支持矩阵

| 引擎 | 计划来源 | 说明 |
|---|---|---|
| MySQL | `EXPLAIN FORMAT=JSON` | 旧版本/失败时回退文本 `EXPLAIN` |
| PostgreSQL | `EXPLAIN (FORMAT JSON)` | `ANALYZE` 单独开关，仅只读 SELECT |
| SQLite | `EXPLAIN QUERY PLAN` | 文本/表格归一化 |

#### 统一计划模型

```ts
interface ExplainPlanNode {
  id: string;
  operation: string;
  object?: string;
  index?: string;
  estimatedRows?: number;
  actualRows?: number;
  estimatedCost?: number;
  actualTimeMs?: number;
  loops?: number;
  filter?: string;
  joinCondition?: string;
  warnings: ExplainWarning[];
  children: ExplainPlanNode[];
}

type ExplainWarning =
  | 'fullTableScan'
  | 'filesort'
  | 'temporaryTable'
  | 'highCost'
  | 'nestedLoop'
  | 'missingIndex';
```

#### UI

- 计划树 + 详情面板；
- 成本/耗时热力标记；
- 原始计划复制；
- 解析失败时展示原始文本，不白屏；
- AI 解释按钮（复用 AI Chat / 解释能力）。

#### 安全

- 默认 `EXPLAIN`，不执行查询。
- `EXPLAIN ANALYZE`：
  - 仅允许只读 SELECT；
  - 必须二次确认；
  - 生产环境额外确认；
  - 只读连接直接拦截；
  - 不允许自动触发。

### 5.2 慢查询分析

#### 数据源

- 本地查询历史（默认）：
  - `costTime`、`rowCount`、`connectionId`、`database`、`time`；
  - 当前上限 100 条，0.2 增加可配置保留量或独立聚合缓存。
- 可选服务器统计：
  - MySQL `performance_schema.events_statements_summary_by_digest`；
  - PostgreSQL `pg_stat_statements`；
  - 需要显式开启，只读查询，权限不足时降级。

#### 功能

- Top N（按总耗时 / 平均耗时 / 最大耗时）；
- 时间范围、连接、数据库过滤；
- 查询归一化/聚合（相同 SQL 模板合并）；
- 一键打开 SQL / EXPLAIN；
- 不记录参数明文。

### 5.3 索引建议

#### 输入

- SQL 文本；
- EXPLAIN 计划；
- 表结构、现有索引、列类型；
- 可选：慢查询聚合。

#### 规则（首版）

- WHERE 等值/范围列；
- JOIN 连接列；
- ORDER BY / GROUP BY 列；
- 复合索引顺序：等值列 → 范围列 → 排序列；
- 排除已有索引前缀；
- 低基数/低选择性列降权；
- 识别重复/冗余索引。

#### 输出

- 建议索引 SQL；
- 置信度（high / medium / low）；
- 理由；
- 风险提示；
- 复制按钮。

#### 约束

- 不自动执行；
- 不修改 Schema；
- AI 只做解释，不替代规则判断。

### 5.4 SQL 诊断

使用 VS Code `DiagnosticCollection`，作用域为 `.sql` 文件。

首版规则：

- `SELECT *`（信息级，可关）；
- `UPDATE/DELETE` 缺少 `WHERE`（warning/error）；
- `NOT IN` + 可空列（warning）；
- 隐式类型转换（warning）；
- 方言不兼容（warning）；
- 危险 DDL（DROP/TRUNCATE/ALTER）提示。

配置：

- `devbelt.diagnostics.enabled`（默认 true）
- `devbelt.diagnostics.rules.<rule>`（按规则开关/级别）
- 诊断只做静态提示，不连接数据库；需要 Schema 的规则在拿到元数据后增强。

### 5.5 数据字典

#### 输入

- 连接、数据库、Schema；
- 表、列、类型、可空、默认值、注释；
- 主键、唯一键、索引、外键。

#### 输出

- Markdown：
  - 目录；
  - 按表分节；
  - 列说明表；
  - 索引/外键；
  - ER 图链接。
- HTML：同一内容，可打印/分享。

#### 约束

- 不导出凭据、连接串、密码；
- 大 Schema 分页/截断；
- 注释为空时留空，不编造；
- 导出前显示范围与文件路径。

## 6. 技术设计

### 6.1 模块

| 模块 | 职责 |
|---|---|
| `packages/explain-core` | 方言 EXPLAIN 解析、统一计划模型、告警识别 |
| `apps/vscode-ext/src/explain/` | 命令、面板、消息协议、AI 解释接线 |
| `apps/vscode-ext/src/insights/` | 慢查询聚合、索引建议规则 |
| `apps/vscode-ext/src/diagnostics/` | SQL Diagnostics Provider |
| `apps/vscode-ext/src/docs/` | 数据字典生成与导出 |
| `webview` | ExplainView / SlowQueryView / 文档预览 |
| `i18n` | 中英文词条 |
| `test` | 解析 fixture、规则单测、真实库矩阵 |

### 6.2 命令

- 复用 `devbelt.explainQuery`，默认安全 EXPLAIN。
- 新增：
  - `devbelt.explainAnalyze`（只读 SELECT + 确认）
  - `devbelt.slowQueries`
  - `devbelt.generateDictionary`
  - `devbelt.indexSuggestions`（面板内动作）

### 6.3 配置

| 配置 | 默认 | 说明 |
|---|---|---|
| `devbelt.explain.analyze` | `false` | 是否允许 `EXPLAIN ANALYZE` |
| `devbelt.insights.historyLimit` | `100` | 本地历史保留量 |
| `devbelt.insights.serverStats` | `false` | 是否读取服务器统计 |
| `devbelt.diagnostics.enabled` | `true` | SQL 诊断总开关 |
| `devbelt.dictionary.format` | `markdown` | 默认导出格式 |

### 6.4 协议

Explain / SlowQuery / Dictionary 使用独立 webview mode 或独立 Panel：

- `explain`：计划树、节点详情、原始 JSON；
- `slowQueries`：聚合列表、过滤、详情；
- `dictionary`：预览与导出结果。

消息必须强类型，禁止把密码/连接串下发给 webview。

### 6.5 查询历史

- 保留现有 `QueryHistoryEntry` 字段；
- 增加可配置保留量；
- 慢查询聚合只读本地历史，不改变同步语义；
- 服务器统计结果不持久化 SQL 参数明文。

## 7. 安全与隐私

- 所有 EXPLAIN 默认不执行 SQL；
- `EXPLAIN ANALYZE` 只允许只读 SELECT，且确认；
- 只读连接 / 生产环境门禁复用现有 `confirmSqlExecution` 语义；
- 诊断、索引建议、数据字典不读取凭据；
- 数据字典导出前排除连接串、密码、SSH 信息；
- 服务器统计查询只读，权限不足时降级；
- 所有新增 AI 调用复用现有配额、脱敏和审计。

## 8. 国际化

新增词条必须中英文成对：

- Explain 节点/告警/详情；
- 慢查询指标；
- 索引建议理由/风险；
- 诊断规则；
- 数据字典标题/字段。

遵循 `test/i18n/catalog.test.ts` 的死键与占位符约束。

## 9. 测试矩阵

### 单元测试

- MySQL JSON 计划解析（含嵌套 join、filesort、临时表）；
- PostgreSQL JSON 计划解析（含 parallel、index scan、seq scan）；
- SQLite `EXPLAIN QUERY PLAN` 解析；
- 解析失败回退；
- 慢查询聚合/归一化；
- 索引建议规则（命中、去重、低选择性、复合顺序）；
- 诊断规则；
- 数据字典 Markdown/HTML 生成。

### 真实库矩阵

| 引擎 | 场景 |
|---|---|
| MySQL 8 | 全表扫描、索引扫描、JOIN、filesort、临时表 |
| PostgreSQL 15+ | seq scan、index scan、parallel、nested loop |
| SQLite | 全表扫描、索引、ORDER BY |

### 手工 UI

- Explain 树展开/折叠、节点详情、原始复制；
- 慢查询过滤/排序/打开 SQL；
- 索引建议复制；
- 诊断开关；
- 数据字典导出与预览。

### 发布门禁

- [x] typecheck / build / 全量测试
- [ ] 三种引擎真实库计划解析 —— SQLite 3.45、MySQL 8.0.36 已通过；**PostgreSQL 待 CI / 真实环境**
- [x] `EXPLAIN ANALYZE` 只读/生产保护测试 —— 0.2.0 不提供 ANALYZE（只执行普通 EXPLAIN），只读/生产确认由 `confirmSqlExecution` 覆盖并有面板测试
- [x] 索引建议 5 个固定用例（另有真实 MySQL 7 例）
- [ ] 诊断误报抽查 —— 需要真实 `.sql` 文件样本，未执行
- [ ] 数据字典大 Schema 导出 —— 真实库 20 表 / 186 列已验证；500+ 表规模未验证
- [x] 中英文词条完整、无死键（catalog 测试）
- [ ] 干净 Profile VSIX smoke test —— 本地无图形环境；CI `vsix-smoke` 已补 explain-core 构建与 P10 断言，**待在 CI 上执行**
- [ ] Marketplace 截图：EXPLAIN、慢查询、索引建议、数据字典 —— README 已预留 07–10 号位，待补真实截图
- [x] CHANGELOG / README 更新
- [x] 无凭据进入日志/错误/遥测 —— 计划/字典/慢查询的下发与输出均不含连接凭据，有测试断言

## 10. 任务拆分

| 阶段 | 任务 |
|---|---|
| 1 | `explain-core` 模型 + MySQL 解析 + fixture |
| 2 | PostgreSQL / SQLite 解析 + 回退 |
| 3 | ExplainView + 节点详情 + 告警高亮 |
| 4 | AI 解释接线 |
| 5 | 慢查询聚合 + 过滤 + 打开 SQL |
| 6 | 索引建议规则 + 复制 |
| 7 | SQL Diagnostics Provider + 配置 |
| 8 | 数据字典生成/导出 + 预览 |
| 9 | 真实库矩阵 + 性能 + i18n |
| 10 | VSIX smoke + 截图 + CHANGELOG |

> 进度（2026-10-22）：阶段 1–3 已完成。`packages/explain-core` 提供 MySQL / PostgreSQL / SQLite 解析、统一计划模型、告警识别与异常回退；ExplainView 已接入结构化 EXPLAIN、计划树、节点详情、告警高亮、原始计划复制与回退。S3.1 已修复阶段 Review 问题（MySQL 默认库回退、报错与回退区分、过期结果丢弃、告警按 `largeScanRows`（默认 1000）收紧、原始计划 1 MB 上限、面板生命周期测试）。真实库矩阵与 F5 手工走查尚未执行（归入阶段 9）。阶段 4 已完成：ExplainView 提供「AI 解释计划」，把当前语句的规范化计划文本（≤200 节点 / 8000 字符）经 AI Chat 解释，复用 `optimize` 配额与审计，暂不带 schema 上下文。阶段 5 已完成（本地历史部分）：`DevBelt: Slow Queries` 面板按 连接 + 库 + SQL 模板聚合本机查询历史，支持按总/平均/最大耗时与次数排序、按连接/时间/关键字过滤、失败计数、一键打开 SQL 或 EXPLAIN；历史保留量可配置（`devbelt.insights.historyLimit`，10–1000，默认 100）。服务器统计（performance_schema / pg_stat_statements）未做，需真实库与权限验证。阶段 6 已完成：ExplainView 增加「索引建议」，仅针对计划中大表全扫描 / filesort 的表，用保守的谓词提取（简单等值/范围/JOIN/ORDER BY，遇 OR、函数包裹、子查询即放弃）按「等值 → 范围 → 排序」组合，跳过已有索引前缀、排除主键/唯一列，DDL 由方言 `createIndexSql` 生成、只复制不执行；同时提示冗余前缀索引。降级说明：拿不到列选择性（无统计），因此置信度最高为「中」、低基数类型（bool/tinyint(1)）降为「低」，并在风险中标注「选择性未知」。阶段 7 已完成：`.sql` 编辑器静态诊断（不连库），规则 `updateDeleteWithoutWhere`、`dangerousDdl`（DROP/TRUNCATE 警告、ALTER 提示）、`notInSubquery`、`selectStar`（hint）、`dialectMismatch`（仅文档绑定连接时：PG 反引号/`LIMIT a, b`，MySQL `ILIKE`/`::type`）；字符串/注释/美元引用内不触发；`devbelt.diagnostics.enabled` 总开关与 `devbelt.diagnostics.rules` 按规则覆盖级别；编辑防抖 300ms、超过 200k 字符跳过。推迟：隐式类型转换、`NOT IN` + 可空列（需 Schema 元数据）。阶段 8 已完成：库节点右键「数据 → 生成数据字典」导出 Markdown / HTML（`devbelt.dictionary.format` 决定默认格式），含目录、表注释、估计行数、列（类型/可空/默认值/键/注释）、索引、外键（按约束聚合，同库表可跳转）；只读元数据，最多 500 张表、4 路并发、可取消，单表读取失败跳过并提示；文本统一转义，HTML 自带严格 CSP，文档不含任何连接信息。偏离规格：不嵌入 ER 图链接（ER 图仅在扩展内可用，导出文件无法链接）；不含视图/例程/触发器；无预览面板。阶段 9（真实库验证，2026-10-23）：
>
> - **修复**：SQLite 驱动启动参数加 `-cmd ".explain off"`。此前 sqlite3 CLI 把 `EXPLAIN QUERY PLAN` 改打印为 ASCII 树，`.mode tcl` 解析拿到 0 行，SQLite 的 EXPLAIN 面板 / AI 优化一直为空（0.1.0 既有缺陷）。
> - **SQLite 3.45**：`explainSqliteReal.test.ts` 4 例通过（全扫描 + 建议、索引查找、主键查找、TEMP B-TREE、LIST SUBQUERY 子节点、覆盖索引、常量行）。
> - **MySQL 8.0.36（RDS，`db_client_verify`）**：`explainMysqlReal.test.ts` 7 例通过（大表全扫描 + 建议、等值 → 范围复合、已有索引命中、filesort + 等值/排序建议、JOIN（表名为别名）、GROUP BY 临时表、主键/唯一排除、低基数降级）；既有 db-core MySQL 集成测试 18 例通过。
> - **MySQL 只读（`db_client_dev`）**：20 张表、55 条普通 `EXPLAIN FORMAT=JSON` 全部解析成功；均为小表，无告警、无误报建议；数据字典元数据读取 20 表 / 186 列 / 52 索引用时约 1.6s、无失败。3 份脱敏后的真实输出作为 `real-mysql-*.json` 回归 fixture。
> - **待 CI**：PostgreSQL（本地无环境）；`mysqlReal.test.ts` 的 C2 备份用例需要 `CREATE DATABASE` 权限，`dbclient` 在 RDS 上没有，交给 CI 容器。
> - **未做**：性能基准、F5 手工走查、诊断误报抽查（需要真实 SQL 文件样本）。

阶段 10 起待实施。

> 0.2.0 发布后复查（2026-10-23）修复：H1 表别名导致索引建议缺失（计划节点名经 `extractPredicates().aliases` 映射回真实表名，MySQL / SQLite 真库别名用例通过）；M3 PG schema 节点上的 EXPLAIN 改在独立会话设置 `search_path`（不在共享会话开事务，避免回滚用户未提交事务）；L1 多语句中单条失败只影响该条；L2 PG 库节点数据字典写明 `current_schema()`；L3 未绑定连接文档里的 `#` 注释不再误报；M1/M2 CHANGELOG / README 补充 SQLite 无行数估计、PostgreSQL 待真实业务库验证。
>
> CI（run 39891513870，`c12c2c4`）：build (20/22)、integration（db-core 55 文件含 explainMysqlReal 8 例 / explainSqliteReal 5 例 / pgReal / pgMultiSchemaReal；server 95 文件）、e2e、vsix-smoke 全部通过。注意：`pgReal` / `pgMultiSchemaReal` 不覆盖 EXPLAIN；PostgreSQL EXPLAIN 真库测试（`explainPgReal.test.ts`，提交 `0a11807`）已补：6 例（大表 Seq Scan 告警与建议、索引命中、别名、JOIN、Sort 节点、search_path 解析），CI run 39895238460 在 PostgreSQL 16 上实际执行并全部通过。真实业务库人工走查仍待进行。

## 11. 风险与开放问题

| 风险 | 应对 |
|---|---|
| 不同版本 EXPLAIN 格式差异 | 解析器按版本容错；失败回退原始文本 |
| `EXPLAIN ANALYZE` 执行写语句 | 仅只读 SELECT + 二次确认 + 生产保护 |
| 索引建议误导 | 标注置信度/风险；不自动执行 |
| 诊断误报 | 规则可关闭；仅高置信度默认开启 |
| 大 Schema 文档过大 | 分页/截断/按 Schema 导出 |
| 服务器统计权限不足 | 降级本地历史，不报错阻断 |
| 查询历史仅 100 条 | 增加可配置保留量或本地聚合缓存 |

## 12. CHANGELOG 模板

```md
## [0.2.0] - 2026-XX-XX

### English

#### Added
- Visual EXPLAIN for MySQL, PostgreSQL and SQLite.
- Slow-query insights with optional performance_schema / pg_stat_statements.
- Index suggestions with rationale and risk notes.
- SQL diagnostics for common risky patterns.
- Data dictionary export.

#### Improved
- Explain plans are normalized, searchable and AI-explainable.

#### Fixed
- ...

### 中文

#### 新增
- MySQL、PostgreSQL、SQLite 可视化执行计划。
- 慢查询分析，可选接入 performance_schema / pg_stat_statements。
- 带理由和风险提示的索引建议。
- 常见风险 SQL 诊断。
- 数据字典导出。

#### 改进
- 执行计划统一为可搜索、可 AI 解释的结构。

#### 修复
- ...
```