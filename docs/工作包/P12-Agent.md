# P12 · Agent（0.3.0）

> 状态：草案（规格待评审，2026-10-23）
>
> 目标版本：`0.3.0`
>
> 上游：`docs/版本路线图.md`
>
> 说明：本文是产品与工程范围草案，不是可实施规格；评审通过并拆出验收矩阵后才进入编码。

## 1. 背景

DevBelt 现有 AI 能力是“副驾驶”：生成、解释、优化、诊断、问答，写操作由用户自己执行。当前事实（已核实）：

- `packages/ai-core` 只有单轮 `chat` / `chatStream`，没有 tool calling、工具注册或 Agent 循环；
- AI Chat 的自动执行只允许 `SELECT / WITH / SHOW / DESCRIBE / EXPLAIN`，且生产连接不自动执行；
- 写语句和 DDL 不做 dry-run，也没有执行前影响行数估计；
- 没有 MCP Server 或 MCP 客户端代码；
- 脱敏只覆盖 AI 样本的敏感列遮蔽（`[REDACTED]`），没有 PII 规则、确定性脱敏、子集化或外键完整性；
- 用户库事务原语存在（`beginTransaction` / `commit` / `rollback`），但没有面向任意 SQL 的 dry-run 封装；
- 服务端 AI 代理只转发 `chat/completions`，请求体没有 `tools` / `tool_choice`；
- 审计已有本地 `AuditLogger`、查询历史和服务端 `audit_events`，但没有 Agent / MCP 工具调用审计。

0.3.0 把三块能力作为**一个集合**交付：

1. **IDE 内 Agent**：查 Schema → 生成 SQL → dry-run → 展示影响 → 批准 → 执行（撤销需新的反向 SQL Proposal）；
2. **MCP Server**：把只读 Schema / 查询 / EXPLAIN 能力提供给外部 AI 客户端；
3. **脱敏 / 子集化**：PII 识别、确定性脱敏、外键完整性、导出。

它们共用一套 Tool Registry、风险分级、审批策略、独立会话和审计，而不是三套并行实现。

## 2. 产品定位调整

产品从“带 AI 辅助的数据库客户端”扩展为：

> **AI 与数据库之间的受控执行层**：人可以在 IDE 内让 Agent 调查和执行；外部 AI 客户端可以通过 MCP 使用同一套受控工具；数据离开数据库前可以按规则脱敏。

仍然服务三条用户价值：

- **少切换**：Schema、SQL、结果、EXPLAIN 不离开 VS Code；
- **少复制**：外部 AI 通过 MCP 直接获得受控的 Schema / 查询能力；
- **少出错**：先计划、先 dry-run、先展示影响，再批准执行。

## 3. 目标

- 提供统一的工具注册与调用模型，Agent、MCP、脱敏导出共用。
- 提供按风险分级的审批策略：只读可设置级授权，写与 DDL 逐条批准，生产默认拒绝。
- 提供受限 dry-run 和影响预览，并明确各引擎的可回滚边界与不能隔离的副作用。
- IDE 内 Agent 支持多步调查、只读执行、写操作审批、结果汇总和中途取消。
- MCP Server 默认关闭、默认只读，仅监听 loopback HTTP，逐客户端短期令牌授权。
- 脱敏导出支持规则化 PII 处理、确定性结果、有限 FK 闭包和预览。
- 所有工具调用可审计：谁、在哪个连接 / 库 / schema、调了什么、谁批准、影响多少行；W2/W3 的安全执行账本必须持久化成功。

## 4. 非目标

0.3.0 不包含：

- 后台自主运行、定时任务、无人值守 Agent；
- 自动批准写操作或 DDL；
- 生产环境默认开放写操作；
- 多人协作、团队 ACL、共享连接；
- 云端 MCP、公网监听、跨设备工具调用；
- 模型训练或微调；
- 通用 BI / 报表；
- 对 MySQL DDL 承诺事务回滚；
- 把完整结果集或未脱敏样本发送给模型；
- 通过 MCP 暴露 Redis / Elasticsearch 写操作。

## 5. 用户流程

### 5.1 IDE 内只读调查

1. 用户在 AI Chat 或 SQL 编辑器发起任务：“orders 最近查询慢，帮我定位”。
2. Agent 生成计划：读取表结构 → 查看索引 → 执行 EXPLAIN → 汇总。
3. 只读工具按设置级授权执行；生产连接仍不自动执行。
4. Agent 输出计划、SQL、EXPLAIN 摘要和建议。
5. 用户可以让 Agent 继续验证候选 SQL，或把 SQL 插入编辑器。

### 5.2 IDE 内写操作

1. 用户要求修改数据或结构。
2. Agent 生成候选 SQL，并调用受限 dry-run / 影响预览。
3. UI 展示：目标连接、库 / schema、完全限定后的 SQL、预计影响行数、脱敏样本、风险级别、dry-run 结果及不可隔离副作用。
4. 用户逐条批准；宿主生成一次性的 `proposalId + approvalNonce`，nonce 不下发模型、Webview 或 MCP。生产连接默认拒绝，只读连接直接拦截。
5. 执行时校验 proposal 的 SQL hash、连接、database、schema、方言和过期状态；任何不匹配都拒绝执行。
6. 正式执行成功后立即提交，不提供执行后回滚；需要撤销时生成反向 SQL，作为新的 Proposal 重新审批。
7. 全过程写入安全执行账本。

### 5.3 MCP 外部客户端

1. 用户在设置中开启 MCP，并选择允许的连接。
2. DevBelt 启动仅监听 `127.0.0.1` 的 HTTP MCP 服务，为每个客户端生成短期令牌；用户把配置片段粘贴到支持 MCP 的客户端。
3. 外部客户端只能调用已授权的只读工具；令牌、端口和连接白名单均可随时撤销。
4. 每次调用记录客户端、工具、连接、耗时、行数和结果状态；不记录结果行。
5. 用户可随时撤销令牌或关闭 MCP。

### 5.4 脱敏导出

1. 用户选择表、行范围、列和脱敏规则。
2. 预览前 N 行脱敏结果。
3. 选择导出格式（SQL / CSV）和目标位置。
4. 按有限 FK 闭包校验完整性；按可排序的依赖顺序导出，无法证明时拒绝。
5. 导出完成后写审计；不把未脱敏数据写入日志。

## 6. 功能规格

### 6.1 Tool Registry

统一定义工具，不允许 Agent 或 MCP 直接拼接任意执行路径。

模型可见工具（`ModelToolRegistry`）：

| 工具 | 风险级别 | 说明 |
|---|---|---|
| `list_connections` | R0 | 只返回 MCP 白名单内的 opaque 连接标识、显示名和引擎；不返回内部 SavedConnection ID 或凭据 |
| `list_schemas` | R0 | 库 / schema 列表 |
| `list_tables` | R0 | 表 / 视图列表 |
| `describe_table` | R0 | 列、索引、外键、注释 |
| `explain_query` | R0 | 普通 EXPLAIN，不执行语句；拒绝 `EXPLAIN ANALYZE` |
| `run_read_only_query` | R1 | 受限只读查询；数据库层只读事务，限行数、限超时 |
| `propose_write` | W2 | 生成写 SQL 并做受限 dry-run / 影响预览，不执行 |
| `propose_ddl` | W3 | 生成 DDL 并做静态检查，不执行 |
| `export_masked` | R2 | 脱敏 / 子集化导出；需要独立导出审批 |

宿主可信执行器（`TrustedExecutor`，不注册为模型工具，MCP 不可见）：

| 操作 | 说明 |
|---|---|
| `approveProposal` | 只能由宿主 UI 触发，生成一次性 nonce |
| `executeApprovedProposal` | 校验 nonce、SQL hash 和目标绑定后执行 |

`apply_write` / `apply_ddl` 不是模型可调用工具；模型只能 propose，不能直接执行。

工具元数据至少包含：名称、描述、参数 schema、风险级别、支持的引擎、是否需要审批、是否允许 MCP、审计字段。

工具实现只能通过现有 `QueryService` / 元数据服务 / 方言层访问数据库，不直接持有驱动连接。工具参数在执行前做严格 schema 校验，拒绝未知字段。

对 SQLite，底层 CLI 不支持驱动参数绑定：首版带值 SQL 仅允许内部生成、已按方言严格转义的受限值类型；无法安全构造时拒绝执行，绝不把 MCP / 模型参数直接内插进 SQL。

### 6.2 风险分级与审批

| 级别 | 内容 | IDE 内 | MCP |
|---|---|---|---|
| R0 | 元数据、普通 EXPLAIN | 设置级授权 | 默认允许（连接在白名单内） |
| R1 | 受限只读查询 | 设置级授权；生产不自动 | 默认允许；数据库层只读事务 + 行数 / 超时限制 |
| R2 | 数据导出 / 外发 | 独立导出审批 | 默认禁止 |
| W2 | 写 DML | 逐条 Proposal 审批 | 不开放 |
| W3 | DDL / 破坏性操作 | 逐条 Proposal 审批；生产默认拒绝 | 不开放 |

MCP 与 Agent 的只读执行不能只依赖 SQL 关键字：PostgreSQL 使用 `BEGIN READ ONLY`；MySQL 使用 `START TRANSACTION READ ONLY`；SQLite 以只读方式打开数据库。显式拒绝 `EXPLAIN ANALYZE`、数据修改 CTE、`SELECT ... INTO OUTFILE`、`FOR UPDATE`、有副作用函数 / 序列和过程调用；无法证明只读时 fail-closed，不降级执行。

审批必须展示：连接、库 / schema、完全限定 SQL、风险级别、预计影响、dry-run 是否成功及其回滚结果、不可隔离副作用，以及“正式执行后不提供回滚”。

W2/W3 必须先创建不可变 `Proposal`：

```text
proposalId, approvalNonce, connectionId, database, schema, dialect,
normalizedSql, fullyQualifiedSql, sqlHash, riskClass, estimatedImpact,
dryRunResult, createdAt, expiresAt, status
```

批准只对该 proposal 生效。`TrustedExecutor.executeApprovedProposal` 必须校验一次性 `proposalId + approvalNonce`、SQL hash、连接 / database / schema / 方言、未过期、未撤销、未执行，并在执行前重新检查只读和生产门禁。approvalNonce 只存在于扩展宿主，不下发模型、Webview 或 MCP。批准、拒绝、执行开始和执行结果分别记入安全执行账本。

现有 `confirmSqlExecution` 只在 critical 风险或生产写时弹确认，普通非生产写不会提示；Agent 的 W2/W3 不能依赖它作为唯一审批，需要新增逐条审批层。

只读自动执行沿用 `devbelt.ai.autoRunReadOnlySql`（默认 `true`）：这是设置级授权，不是逐条弹窗；生产连接、写语句和 DDL 不受此开关影响。

### 6.3 执行底座

- 每次 Agent 会话使用独立 SQL session（`openIsolatedSql`），不污染编辑器、结果面板和其他 Agent 会话。
- PostgreSQL 的 `openIsolatedSql` 当前会把 `search_path` 置为 `pg_catalog`。Agent 必须使用完全限定的对象名，并在 Proposal 中记录绑定 schema；切换 database / schema 后旧 Proposal 全部失效。
- 同一 Agent 会话内工具调用串行；不同独立连接可并行，写操作对同一目标另有排他锁或审批 token。
- 取消：取消当前工具调用，不调用会影响共享连接的全局取消。
- 超时：沿用 `devbelt.sql.queryTimeoutSeconds`，工具可设置更短上限。
- 行数上限：只读查询和预览必须有上限；超出截断并标记。

#### 正式执行

- 审批通过后，在独立 session 中执行；成功后立即提交。
- 不提供执行后回滚；需要撤销时重新生成反向 SQL，作为新的 Proposal 再次审批。
- 执行前必须先持久化 `EXECUTING`；持久化失败则不执行。
- 执行结果持久化 `SUCCEEDED` / `FAILED`；数据库已提交但终态写入失败时标记 `UNKNOWN`，提示人工核查，不谎称失败。

#### dry-run 与影响预览

| 引擎 | DML dry-run | DDL dry-run | dry-run 回滚 / 正式执行 |
|---|---|---|---|
| PostgreSQL | 仅 allowlist DML 在独立只读事务外的事务内试执行后 `ROLLBACK`；设置锁等待上限 | 默认静态预览；仅经引擎 allowlist 的事务型 DDL 可试执行 | dry-run 可回滚，但不能隔离事务外副作用；正式执行立即提交 |
| MySQL | 仅 InnoDB allowlist DML 在独立事务内试执行后 `ROLLBACK`；设置 `innodb_lock_wait_timeout` | 不执行；只做静态检查与 SQL 预览 | dry-run DML 可回滚；DDL 隐式提交，不可回滚；正式执行立即提交 |
| SQLite | 仅 allowlist DML 作为整批 `BEGIN; …; ROLLBACK` 执行（现有连接不支持跨查询事务回调） | 不执行；只做静态检查 | dry-run 受整批事务限制；正式执行立即提交 |

影响估计：

- `UPDATE` / `DELETE`：仅单表、无 JOIN / CTE / 子查询、可解析 WHERE 的语句可改写为 `COUNT(*)`；其他情况显示“未知，只能人工审核”；
- `INSERT`：仅 `VALUES` 行数或受限 `INSERT … SELECT` 的估计行数；其他情况显示“未知”；
- DDL：不估计行数，展示将影响的对象和锁风险；
- 估计值必须标注为估计，不能当作实际影响。

dry-run 必须限制持锁时间；失败或超时立即回滚并报告。触发器、sequence / auto-increment 推进、通知、外部函数、非事务表等事务外副作用不能由 rollback 隔离：检测到已知触发器或无法证明安全时默认降级为静态预览。禁止对生产连接默认执行 dry-run 写操作。

### 6.4 IDE 内 Agent

- 入口：AI Chat 面板；SQL 编辑器选中内容；结果面板错误 / 慢查询入口。
- Agent 循环：计划 → 工具调用 → 观察结果 → 继续或结束；最多步数、最多工具调用次数、总超时可配置。
- 计划与每次工具调用在 UI 中可见；用户可以中途停止。
- 模型必须支持 tool calling；不支持时降级为现有单轮 AI，并明确提示。
- 模型只能调用 `propose_write` / `propose_ddl`；`apply_write` / `apply_ddl` 只由宿主 `TrustedExecutor` 执行，不注册为模型工具。
- Agent 不得在用户未批准时执行 W2/W3；不得绕过只读 / 生产 / 风险门禁。
- 结果汇总只引用已执行工具的真实输出，不编造执行结果。
- 工具回传模型前必须经过 `ToolResultSanitizer`：R0 只发受预算限制的规范化元数据；R1 默认只发列名、行数、截断标记和统计摘要；行样本必须显式开启、脱敏并受行 / 字段 / 字符预算限制；EXPLAIN 只发规范化计划摘要。
- Sanitizer 只做数据最小化，不是授权控制。每次工具调用都由宿主重新校验工具白名单、目标绑定和审批状态；即使模型受提示注入影响，宿主策略仍拒绝越权。
- Schema 注释、表名、查询结果和工具错误均视为不可信数据，封装为不可执行 data envelope；它们不能改变工具白名单、审批策略或连接选择。

### 6.5 MCP Server

- 默认关闭；开启后仅本地运行。
- 传输：仅 loopback HTTP，监听 `127.0.0.1` 的动态端口；不监听 IPv6 / 公网地址。
- 鉴权：每个客户端单独短期令牌，存 SecretStorage；令牌绑定客户端、允许的工具和连接白名单，可轮换、过期和撤销；令牌不写入日志。
- 生命周期：扩展停用、连接白名单变更、用户关闭 MCP 或令牌撤销时立即停止或拒绝后续请求；动态端口和配置片段不持久化到工作区。
- 工具白名单：MCP 只注册 R0 / R1；W2 / W3 不注册、不提供开关。
- 只读执行：PostgreSQL `BEGIN READ ONLY`、MySQL `START TRANSACTION READ ONLY`、SQLite 只读方式打开；拒绝 `EXPLAIN ANALYZE`、数据修改 CTE、`SELECT ... INTO OUTFILE`、`FOR UPDATE`、有副作用函数 / 序列和过程调用。
- 连接白名单：用户显式选择允许 MCP 访问的连接；生产连接默认不允许。
- 限制：最大行数、超时、并发、每客户端速率限制。
- 网络防护：校验 `Host` 与 `Origin`，拒绝 DNS rebinding 和浏览器跨站请求；令牌只允许 `Authorization` header，不接受 URL query；限制请求体大小、Content-Type、空闲连接和总请求超时；token 比较使用恒定时间实现。
- 唯一标识：`list_connections` 只返回白名单内的 opaque 连接标识，不返回内部 SavedConnection ID。
- 审计：每次调用记录客户端、工具、连接、库 / schema、耗时、行数、状态；不记录结果行和凭据。
- 外部客户端不能读取 SecretStorage、连接密码、SSH 私钥或完整连接串。

### 6.6 脱敏 / 子集化

#### 规则

- 内置：email、phone、身份证 / 证件号、姓名、地址、银行卡、自定义正则；
- 动作：替换为固定值、保留格式的部分遮蔽、确定性哈希、置空；
- 每个列可单独选择规则；未选择规则的列默认原样导出，并在预览中明确标识；但 PII 识别命中的列必须由用户显式确认“允许原样导出”，否则拒绝导出。

#### 确定性

- 映射域定义为 `projectSalt + logicalDomain + normalizedInput → maskedValue`；同一项目、同一规则、同一映射域和同一输入产生同一输出；
- 同一 PK/FK 关系必须共享 logicalDomain；哈希使用项目级 salt（SecretStorage），不把 salt 写入导出文件或日志；
- 固定 `NULL`、空字符串和大小写归一化规则；需要保持格式时（如手机号），脱敏结果保持可读格式但不保留原始信息；
- 首版不支持跨机器 salt 导入 / 导出，因此不承诺跨机器脱敏结果一致。

#### 子集化与外键

- 支持按 WHERE 条件选择行；
- 仅单库、已声明 FK 的有限深度闭包；用户选择单向 / 双向闭包，必须设置最大深度和最大行数；超限即停止，不导出部分未知闭包；
- 支持复合键；循环、自引用、跨库 / 未声明关系或无法排序的依赖默认拒绝并说明原因，不承诺完整性；
- 导出顺序按可排序的 FK 依赖排序；
- 导出前验证 NOT NULL、长度、唯一键、复合键和外键；冲突或约束不满足时停止导出，不写入部分结果；
- 不自动删除或修改源库数据。

#### 预览与导出

- 预览默认 20 行，全部经过脱敏；
- 导出格式：SQL / CSV；
- 导出文件不包含连接信息；
- 未脱敏数据不得进入日志、审计、AI 请求或 MCP 响应。

### 6.7 审计

审计分为两层：

- **活动日志**：沿用现有 `AuditLogger`，它存 VS Code Memento、上限固定 1000、写入失败只告警，可清理；仅用于本地可见活动，不可作为安全关键审计依据。
- **安全执行账本**：记录 W2/W3 proposal、批准 / 拒绝和执行状态，使用 append-only JSONL 文件持久化（每条事件写入后 `fsync`，写入方用独占锁文件串行化）；账本写入失败或锁被占用时必须阻断 W2/W3。MCP 调用也必须持久化，不能静默跳过。
- 状态机：`PROPOSED → APPROVED → EXECUTING → SUCCEEDED / FAILED / UNKNOWN`。执行前必须先持久化 `EXECUTING`；启动时把遗留 `EXECUTING` 恢复为 `UNKNOWN`。
- 数据库已提交但终态写入失败时，报告 `UNKNOWN` 并要求人工核查；不得声称执行失败或可回滚。
- 该账本是 fail-closed 本地执行账本，不是不可篡改审计，也不提供跨设备一致性。

安全执行账本新增字段：

| 字段 | 说明 |
|---|---|
| `surface` | `agent` / `mcp` / `masking` |
| `clientId` | MCP 客户端标识（Agent 为空） |
| `tool` | 工具名 |
| `riskClass` | R0 / R1 / R2 / W2 / W3 |
| `decision` | `auto` / `approved` / `rejected` / `blocked` |
| `proposalId` | 关联的 Proposal；启动恢复和重复执行检测使用 |
| `state` | `PROPOSED` / `APPROVED` / `EXECUTING` / `SUCCEEDED` / `FAILED` / `UNKNOWN` |
| `connectionId` / `database` / `schema` | 目标 |
| `sqlHash` | SQL 哈希；可选脱敏 SQL |
| `estimatedRows` / `affectedRows` | 影响估计 / 实际 |
| `durationMs` | 耗时 |
| `errorCode` | 失败分类 |

- 不记录结果行、参数值、密码或连接串；
- 安全执行账本保留、导出和清理策略独立于活动日志，清理动作本身也记录；
- 审计保留量可配置；
- 服务端现有 `audit_events` 继续记录 AI 代理调用，不新增 MCP 服务端审计。

## 7. 技术设计

### 7.1 模块

| 模块 | 职责 |
|---|---|
| `packages/agent-core`（新） | 工具契约、模型工具 / 可信执行器分层、风险分级、Proposal 状态机、Agent 循环、审计事件类型；不依赖 vscode |
| `packages/mcp-server`（新） | loopback HTTP MCP 协议适配、客户端短期令牌、工具 / 连接白名单、限流；通过宿主适配器调用工具 |
| `apps/vscode-ext/src/agent/` | IDE 内 Agent、Proposal 审批 UI、计划展示、取消；TrustedExecutor 接线 |
| `apps/vscode-ext/src/mcp/` | loopback 服务生命周期、动态端口、客户端令牌、连接白名单、审计接线 |
| `apps/vscode-ext/src/masking/` | 脱敏规则、映射域、预览、有限 FK 闭包、约束校验、导出 |
| `packages/ai-core` | 扩展 tool calling：请求 `tools` / `tool_choice`，解析 `tool_calls` 与流式增量 |
| `apps/server` | 代理转发 `tools` / `tool_calls`，计量包含工具调用 token；不记录对话内容 |
| `apps/vscode-ext/src/utils/auditLogger.ts` | 活动日志字段扩展与查询 |
| `packages/agent-core/src/jsonlLedger.ts`（新） | append-only JSONL 安全执行账本、状态机、启动恢复、导出；路径由扩展宿主注入（`globalStorageUri`） |

### 7.2 关键依赖与限制

- 当前 `OpenAICompatibleProvider` 请求体只有 `model / messages / temperature / max_tokens / stream / stream_options`，必须扩展 tool calling；
- 服务端代理当前是 parse-and-forward SSE，需支持 `tools`、`tool_calls` 和流式增量；
- 不是所有模型都支持 tool calling；不支持时降级为单轮 AI；
- MCP SDK 引入前需评审依赖体积、许可证和 Node 版本兼容性；
- loopback HTTP 仍面临同机恶意进程风险，短期令牌必须最小权限、不可出现在日志或工作区文件；
- SQLite CLI 不支持参数化查询，Agent / MCP 的带值 SQL 只能走严格受限的方言转义或拒绝；
- PostgreSQL `openIsolatedSql` 默认 `search_path = pg_catalog`，Agent 必须完全限定对象名；
- SQLite 连接不支持跨查询事务，dry-run 必须按整批事务实现；正式执行立即提交；
- MySQL DDL 隐式提交，不能承诺回滚；正式执行不提供执行后回滚；
- 安全执行账本不使用 SQLite：扩展宿主为 VS Code `^1.85.0`（Node 18），没有内置 `node:sqlite`，引入原生模块会增加 VSIX 打包与跨平台风险；改用 append-only JSONL + `fsync` + 独占锁文件，账本文件与业务库隔离并单独备份。

### 7.3 命令与配置

命令：

- `devbelt.agent.run`（从 Chat / 编辑器发起）
- `devbelt.agent.stop`
- `devbelt.mcp.enable` / `devbelt.mcp.disable`
- `devbelt.mcp.copyClientConfig`
- `devbelt.masking.export`

配置：

| 配置 | 默认 | 说明 |
|---|---|---|
| `devbelt.agent.enabled` | `false` | Agent 总开关 |
| `devbelt.agent.allowWrites` | `false` | 是否允许 W2 工具 |
| `devbelt.agent.allowDdl` | `false` | 是否允许 W3 工具 |
| `devbelt.agent.allowProduction` | `false` | 是否允许生产连接执行写 |
| `devbelt.agent.maxSteps` | `12` | 单次任务最大步数 |
| `devbelt.mcp.enabled` | `false` | MCP 总开关 |
| `devbelt.mcp.allowedConnections` | `[]` | 允许 MCP 访问的连接 |
| `devbelt.masking.previewRows` | `20` | 脱敏预览行数 |

### 7.4 协议

- Agent 与 Webview 之间使用强类型消息：计划、工具调用、审批请求、结果、错误、取消。
- 审批请求必须包含可读且完全限定的 SQL、目标、风险级别、影响估计、dry-run 结果，以及“正式执行后不提供回滚”的说明。
- MCP 使用标准 MCP 消息；工具参数和返回值做 schema 校验，拒绝未知字段；仅接受 loopback 令牌认证的请求。
- 任何协议都不得下发密码、token、私钥或完整连接串。

## 8. 安全与隐私

- Agent / MCP 默认关闭；写 / DDL 默认关闭；生产写默认拒绝。
- 工具只能通过白名单访问数据库，模型不能构造任意连接；目标绑定由宿主注入，不接受模型传入。
- 所有 W2/W3 操作逐条审批，审批内容不可被模型篡改；approvalNonce 只在宿主内。
- MCP 只开放 R0 / R1、仅 loopback HTTP、逐客户端短期令牌、连接白名单、速率限制和网络防护。
- 提示注入防护：Schema 注释、表名、查询结果都视为不可信输入，经 Tool Result Sanitizer 处理；Sanitizer 不是授权控制，宿主每次调用重新校验白名单和审批。
- 结果数据默认不发送给模型；需要样本时必须显式开启并脱敏。
- 脱敏 salt 存 SecretStorage；导出文件、日志、审计不含 salt。
- 审计不记录结果行和参数值。
- dry-run 设置持锁上限，失败立即回滚；生产连接默认不 dry-run 写操作。

## 9. 国际化

- Agent 计划、工具名称、审批、风险级别、dry-run 结果、MCP 状态、脱敏规则均提供中英文词条。
- 协议传稳定状态码，不传本地化文本。
- 数据库错误保留原文，外层提示走 i18n。
- 继续执行死键检查。

## 10. 测试矩阵

### 单元测试

- Tool Registry：工具元数据、参数校验、风险级别、引擎支持；
- 审批策略：R0 / R1 / R2 / W2 / W3、生产、只读、MCP 白名单；
- Agent 循环：最大步数、取消、超时、工具失败、模型不支持 tool calling；
- dry-run：allowlist DML 回滚、影响估计的受支持 / 未知分支、锁超时、触发器降级、DDL 静态预览；
- Proposal：一次性 nonce、SQL / target hash 绑定、过期、撤销、重复执行拒绝、nonce 不下发模型 / Webview / MCP；
- 正式执行：成功即提交、不提供执行后回滚、反向 SQL 需重新审批；
- 安全账本：PROPOSED / APPROVED / EXECUTING / SUCCEEDED / FAILED / UNKNOWN、启动恢复、终态写入失败报告 UNKNOWN；
- Tool Result Sanitizer：数据预算、样本脱敏、注入 data envelope；宿主策略不依赖 Sanitizer；
- MCP：loopback 限制、Host / Origin 校验、短期令牌、工具白名单、连接白名单、速率限制、参数校验、撤销、opaque 连接 ID；
- 只读执行：三种引擎的只读事务 / 只读打开、拒绝 `EXPLAIN ANALYZE` / 数据修改 CTE / INTO OUTFILE / FOR UPDATE；
- 脱敏：规则、映射域、确定性、格式保持、salt 不泄漏、PII 原样导出显式确认、约束校验、预览；
- FK 闭包：单库、深度 / 行数上限、循环 / 跨库拒绝和导出顺序；
- 活动日志与安全执行账本的字段、失败阻断和清理审计。

### 真实库矩阵

| 引擎 | 内容 |
|---|---|
| MySQL 8（CI 验证库） | allowlist InnoDB DML dry-run + 回滚、影响估计、触发器降级、DDL 静态预览、Agent proposal、MCP 只读事务 |
| PostgreSQL 16（CI 验证库） | allowlist DML / DDL dry-run、只读事务、完全限定名、schema、MCP 只读 |
| SQLite | 整批 allowlist dry-run、只读打开、带值 SQL 拒绝 / 受限转义、导出、脱敏 |
| 脱敏 | 三引擎的 FK 闭包、确定性、预览 |

真实库测试沿用各引擎现有环境变量和安全库守卫，不连接 `db_client` 或生产库。

### 安全测试

- 提示注入：表注释、列注释、结果内容尝试改变工具白名单或审批；
- 越权：MCP 客户端调用未授权工具 / 连接、过期 / 撤销令牌、非 loopback 来源；
- Proposal：批准 A 后尝试执行 B、目标切换、过期 nonce、重复执行；
- 凭据：日志、审计、导出、MCP 响应中不出现密码、token、私钥；
- 生产门禁：生产连接写操作和 dry-run 被拒绝；
- dry-run 失败不留下部分写入，已知触发器 / 外部副作用降级；
- 安全执行账本写入失败时 W2/W3 不执行。

### 手工 UI

- Agent 只读调查、写审批、拒绝、取消、失败；
- 模型不支持 tool calling 的降级提示；
- MCP 开启、复制配置、外部客户端调用、撤销令牌；
- 脱敏预览、导出、FK 完整性；
- 审计查看与保留量。

## 11. 任务拆分

| 阶段 | 任务 |
|---|---|
| 1 | `agent-core`：工具契约、风险分级、Proposal 状态机、审计事件 |
| 2 | 安全执行账本：append-only JSONL、`fsync`、锁文件、状态机、启动恢复 |
| 3 | Tool Result Sanitizer 与宿主策略校验 |
| 4 | 只读 Tool Runtime：只读事务、只读打开、受限 SQL 分类 |
| 5 | `ai-core` / server：tool calling、流式解析、代理转发、计量 |
| 6 | IDE 只读 Agent：计划、工具调用、取消、降级 |
| 7 | W2/W3：dry-run、影响预览、Proposal 审批 UI、立即提交语义 |
| 8 | MCP Server：loopback HTTP、短期令牌、白名单、限流、审计 |
| 9 | 脱敏 / 子集化：映射域、约束校验、有限 FK 闭包、预览、导出 |
| 10 | 真实库矩阵、安全测试、i18n |
| 11 | VSIX smoke、文档、截图、CHANGELOG |

每阶段单独验证；引入新依赖（MCP SDK 等）前单独评审。

## 12. 风险与开放问题

| 风险 | 应对 |
|---|---|
| 模型 tool calling 能力不一致 | 能力探测 + 降级为单轮 AI；不支持时不启用 Agent |
| MySQL DDL 不可回滚 | 不执行 DDL dry-run；明确提示；生产默认拒绝 |
| dry-run 持锁或触发事务外副作用 | allowlist、锁等待上限、超时、触发器降级、生产默认不 dry-run 写 |
| Agent 误执行写操作 | W2/W3 一次性 Proposal 逐条审批；SQL / target hash 绑定；模型只能 propose，执行仅在 TrustedExecutor |
| MCP 暴露数据或只读绕过 | 只开放 R0/R1、数据库层只读事务、拒绝副作用语句、loopback HTTP、短期令牌、连接白名单、审计 |
| 提示注入或工具结果泄漏 | Tool Result Sanitizer、数据预算、脱敏样本；宿主每次调用重新校验白名单和审批 |
| 脱敏不彻底、约束冲突或闭包膨胀 | 映射域、约束校验、PII 原样导出显式确认、规则预览、确定性、有限 FK 闭包与上限 |
| 安全账本写入失败或数据库已提交 | 执行前持久化 EXECUTING；终态失败报告 UNKNOWN；不谎称失败或可回滚 |
| 范围过大 | 按阶段交付；每阶段可独立验收 |

已定稿的决策：

1. Agent 循环在扩展宿主；服务端只做无状态模型代理，不保存工具调用状态。
2. 脱敏 salt 为项目级；首版不支持导出 / 导入，不承诺跨机器一致。
3. 本地自带 Key 的 IDE Agent 可用；官方代理走现有 AI 配额；MCP 本地只读不计费；脱敏导出本地可用。
4. MCP 使用官方 SDK，固定版本；引入前评审许可证、依赖树和 VSIX 体积。
5. 安全执行账本使用 append-only JSONL 文件（`fsync` + 独占锁文件），支持状态恢复和导出；不使用 SQLite、Memento 或 SecretStorage。末尾半行视为崩溃残留并在下次写入前修复；中间行损坏直接拒绝读写。
6. 首版 dry-run 仅单表 `UPDATE`、`DELETE`、`INSERT VALUES`；检测到触发器一律降级为静态预览。

## 13. CHANGELOG 模板

```md
## [0.3.0] - 2026-XX-XX

### English

#### Added
- Agent mode: schema inspection, SQL generation, dry-run, impact preview and approval-based execution.
- MCP server: read-only schema, query and EXPLAIN tools with per-client tokens and audit.
- Masking and subsetting export: PII rules, deterministic masking and bounded FK-aware export.

### 中文

#### 新增
- Agent 模式：Schema 检查、SQL 生成、dry-run、影响预览与基于审批的执行。
- MCP Server：只读 Schema、查询与 EXPLAIN 工具，逐客户端令牌与审计。
- 脱敏 / 子集化导出：PII 规则、确定性脱敏与有界外键完整性导出。
```