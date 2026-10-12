# Changelog

## 未发布（0.1.0）

### P9 — AI 能力（NL2SQL / Chat / 解释 / 诊断 / 补全）

- 新包 `packages/ai-core`（`@devbelt/ai-core`）：零依赖 `AiProvider` 接口 + `OpenAICompatibleProvider`
  （Node 内置全局 fetch + SSE 流式 + AbortController/超时/错误分类，支持 streamOptions 透传）
  + SSE parser（`@devbelt/ai-core/sse` 子路径导出，供服务端代理复用）+ schema 上下文序列化（ENUM 注入/列注释
  清洗/状态字典正则提取+500 字上限/大库关键词预筛/3-4K 预算）+ SQL 安全分类（`classifyAiSql(sql, options?) → AiSqlClassification`，复用 db-core）+ 敏感列脱敏（状态字典白名单）+ 6 场景 prompt 模板 + `parseSqlAnswer` 纯函数（sql/intentParaphrase/assumptions）。
- 模型接入双通道：①自带 Key（OpenAI 兼容 baseUrl + SecretStorage 存 apiKey，覆盖
  OpenAI/百炼 DashScope/DeepSeek/Ollama/vLLM 等）；②服务端代理（`/api/ai/chat` **parse-and-forward**，
  复用 parseSse 拦截 finish chunk 记 usage 对账，事件**原样转发**（语义与直连上游一致）；
  客户端断开立即 abort 上游；单 chunk 解析失败不中断流）。
- 权益：新增 `maxAiTokensMonthly` plan feature（0 = 拒绝，无"不限"档）；Free 100K ≈ 15–20 次 /
  Pro 2M ≈ 300–400 次（基于 schema 3-4K 预算的诚实估算）；服务端事务内 **ensure-row + SELECT FOR UPDATE**
  防首次请求间隙锁失效 + 原子预占（reserved_*，completion 封顶 4K）+ finish 对账（强制
  stream_options.include_usage 拿权威 usage，缺失时 delta 估算打 `usageEstimated=true` 审计标记）；
  单段月额度（双段 FIFO 加油包移 P9.1）；客户端发送前估算 tokens；审计只记元数据。
- **S2 已交付（2026-10-12，服务端）**：`apps/server/src/modules/ai/` 落地 `POST /api/ai/chat`
  （登录态 + 20/min 固定窗限流 + hijack 原始响应 SSE、60s 预头超时、上游错误翻译
  401/429/503、未配置上游 503 fail-closed）与 `GET /api/ai/usage`；migration `008_ai_quota`
  （`maxAiTokensMonthly` free=100K/pro=2M 幂等种子 + `ai_token_usage` 表，`usage_month CHAR(7)`）；
  结算释放用 `reserved - LEAST(reserved, ?)` 防 `BIGINT UNSIGNED` 下溢；审计白名单 4 事件
  （completed/failed/aborted/chunk_parse_failed，reason 仅元数据 JSON）。ai-core 增量：`./sse`
  子路径导出 + `ChatRequest.streamOptions` 透传。验证：ai-core 58 单测、server 585 通过/34 跳过
  （4 条 `aiQuota` 真库并发/下溢集成待真库环境或 CI）、全仓 typecheck/lint 全绿。
- **S3 已交付（2026-10-12，客户端）**：独立 `devbelt.ai` WebviewPanel（`aiChat.html` 独立
  vite 入口 + 独立 `aiProtocol`，不走 WebviewMode）+ `apps/vscode-ext/src/ai/`（AiKeyStore
  SecretStorage 缓存/多窗口失效；AiService 双 provider 路由 + 每请求独立 AbortController + 审计；
  ServerProxyProvider `/api/ai/chat` SSE + `/api/ai/usage` + 409 配额/401/429/503 映射；连接级
  域上下文/默认指令/会话历史三组 Memento；schema 薄封装 50 表 + 60s TTL，失败降级）；命令 6 条 +
  工具视图入口 + 设置 5 项（provider/baseUrl/model/includeColumnComments/temperature）+ 中英词条/NLS；
  ai-core 列注释基础渲染（S3 所需，ENUM/字典/预筛随 S4）；db-host `maxAiTokensMonthly` 类型/helper。
  验证：vscode-ext 1587 通过/4 跳过（含 48 条 AI 单测）、ai-core 62、db-host 19、server 585 回归、
  vite 多入口产出名不回归、esbuild bundle 成功、全仓 typecheck/lint 全绿；F5 真机上游客栈留发布硬门禁。
- **S4 已交付（2026-10-12，场景接线 + 意图增强）**：ai-core `parseSqlAnswer`（三字段布局容错解析）+
  nl2sql v5 契约（schema-linking / ENUM 严格映射 / 意图复述 / Assumptions / 引用表优先 / 库-schema 绑定 /
  域上下文与业务规则 user-role 区块）+ 状态列字典片段提取（500 字上限）；五路信号组装与
  `devbelt.ai.explainSql/.optimizeSql/.nl2sqlGhost`（Alt+A 直插 + 假设/复述状态条 + "在 Chat 中细化"回路）
  + 错误诊断（`sqlForAi/secretRisk/askAi` 附加字段、双扫描阻断、内联确认闸、host 二次脱敏）+ 数据问答
  （默认不发样本、确认后打码截断、按设置行数）+ 0 行诊断（AI SQL 归因 + "问 AI 为什么查不到"）+
  Chat 代码块"插入编辑器/执行"（复用现有执行 gate）+ Context 明细抽屉 + 表设计器 AI 生成/审阅（结果回 Chat）+
  schema 注入升级（MySQL 批量列 + 关键词预筛 + @ 引用优先 + 200 表）+ 设置 2 项 + 菜单/键位/NLS。
  验证：ai-core 77、vscode-ext 1605 通过/4 跳过（+18 条 S4 测试）、server 585 回归、全仓
  typecheck/lint 全绿。偏差：表设计器"表内 diff→逐条应用"留后续增量；Alt+A 真 ghost 随 S5；
  `recent-only` 暂等同 current-db。
- **S5 已交付（2026-10-12，Inline 补全）**：ai-core `buildInlineCompletionMessages`（续写文本契约 +
  `<none>` 哨兵）；`aiInlineContext`（引用表提取复用词法器、外键一跳邻接、light schema 1.5K 预算裁剪、
  无会话降级不建连）；`aiInlineProvider`（**仅 Alt+/ / 命令触发**，普通打字零请求；300ms debounce、
  5s 超时、打字取消 abort；口令字面量阻断；输出卫生）；命令 `devbelt.ai.inlineComplete` +
  `alt+/` 键位（when `config.devbelt.ai.enableInlineCompletion`）+ 设置 `enableInlineCompletion`
  （默认 false）；`AiService.chat` 增可选 AbortSignal。验证：ai-core 78、vscode-ext 1622 通过/4 跳过
  （+17 条 S5 测试）、server 585 回归、全仓 typecheck/lint 全绿；F5 真机走查留发布硬门禁。
- **S6 已交付（2026-10-12，加固与文档回填）**：prompt 注入防御测试（system 固定不插值、
  schema 注释注入折叠为单行、域上下文只落 user 区块）；AbortController 隔离回归；错误码契约冻结；
  敏感列机械断言（黑名单全集 + 无辜对照 + 字典片段不打码）；AI 机械门禁（apiKey 无 Memento 读写/
  无日志泄露、协议无 apiKey 载荷、审计仅元数据、setting 默认值与读取点、bridge 未初始化不阻塞）；
  sqlRisk shim 同一引用 + 同输入同输出；大库预筛英文/注释命中补测；诊断载荷二次脱敏抽为纯函数
  （message 命中整段 [REDACTED]、sql 命中剔除）；文档回填 `docs/架构.md`（ai-core/双通道/服务端 AI
  路由与月额度/权益矩阵）与 `docs/产品介绍.md`。验证：ai-core 88、vscode-ext 1636 通过/4 跳过
  （+14 条 S6）、server 585 回归、全仓 typecheck/lint 全绿。多模型手工矩阵/F5 真机走查/真机大库
  预筛留发布硬门禁（未执行）。
- **真机复核修复（2026-10-12）**：AI 请求 401 自动续期并重试一次 —— 新增
  `AuthService.refreshAccessToken`（复用 SyncClient 单飞刷新）+ `ServerProxyProvider.onAuthFailure`
  （仅 401、仅重试一次；续期失败/同 token 不重试；`getUsage` 同语义）+ AiService 注入。
  修复前 access token（15m TTL）过期会直接报 "AI proxy authentication failed (HTTP 401)"。
  测试 +6；仅扩展侧改动，无需服务端重部署。
- **P9 v1 不做加油包**：多档位 SKU / 一次性购买 / 管理后台手工建单 / 退款 / 双段 FIFO 计量移至
  **P9.1**（独立切片评审）。v1 配额条仅展示月额度已用/剩余/重置时间。
- 面板：活动栏 AI 图标 + `devbelt.ai` **独立 WebviewPanel**（对齐 Redis/ES，不走 QueryView 的
  WebviewMode 单入口，独立 HTML 与 aiProtocol），支持 Markdown 渲染、流式、会话历史、代码块复制/插入/执行、
  上下文抽屉（表/列/注释条数/默认指令/域上下文明细）、列注释发送计数状态条、停止/abort、token 估算。
- 七大场景：NL2SQL（Ghost-Text 预览 + 意图复述状态条 + "在 Chat 中细化"一键升级 Alt+A↔Chat 回路）、
  SQL 解释 / EXPLAIN 优化建议、错误诊断（`containsSecretSql` 二次扫描默认阻断）、
  数据问答（默认不发样本+单次确认+敏感 cell 打码+10 行）、Schema 设计建议、
  SQL 编辑器右键 AI 菜单、Inline 补全（`Alt+/`，默认关，light schema ≤1.5K）、
  **0 行结果诊断辅助**（"问 AI 为什么查不到"按钮）。
- 安全：AI 永不自动执行；写/危险标签复用 db-core `analyzeSqlRisk` 共用分类器；只读/生产 gate 复用；
  apiKey 只落 SecretStorage；webview CSP `default-src 'none'`；会话历史存本地 Memento 不进 E2EE 同步；
  列注释默认开启（中文库必需），连接级一键关闭、状态条显示发送条数、Context 抽屉明示（隐私单列）；
  默认业务指令以 user-role 区块注入（不污染固定 system prompt），并明确"仅当列/表存在时适用"。
- 意图识别增强（借鉴 Chat2DB 源码分析 + 三轮评审整改）：五路显式信号融合 + ENUM/字典值严格映射
  （禁止猜 pending 等状态值）+ **意图复述（Intent Paraphrase）** + Assumptions 透明化 + 连接级默认业务
  指令 + 大库 >200 表启发式关键词预筛（批量 information_schema 取数 60s 缓存）+ 列注释/ENUM 参与 schema-linking。
- SQL/Redis/ES/认证/同步零回归；sqlRisk 分类器下沉到 db-core（shim 零改动）；新代码集中在新包/新模块/
  新目录，可整包回滚；migration 008 新建表单桶月额度（`usage_month CHAR(7)`，避免 MySQL YEAR_MONTH 保留字）。
- 阶段文档：[P9-AI](docs/阶段/P9-AI.md)（draft v5.1：加油包移 P9.1、parse-and-forward、S2 阻塞修复、
  意图准确率增强、前后矛盾修正）。加油包详见阶段文档 §十三【P9.1 交付】。

### P7 — Redis 客户端

- 引擎接缝：`ConnectionSession` 判别联合（sql | redis），SQL 路径零行为改动。
- 连接：standalone / Cluster / Sentinel 三模式；ACL、SSL/TLS（自签拒绝·放行）、SSH 隧道（含 Cluster/Sentinel over SSH 的 NAT map）、只读模式 fail-closed。
- 面板：服务器状态、CLI 控制台（命令补全 / 危险命令二次确认 / 只读拦截）、慢日志、命令日志、键浏览器。
- 键浏览：SCAN 分页 + 分隔符折叠 + 批量删除（按 pattern，count-only 预扫 + 计数确认）+ 大 key 保护；string/hash/list/set/zset/stream 查看编辑、TTL、新建/重命名/删除。
- 二进制：string 支持字节级 hex 编辑；有损（非 UTF-8）键/成员只读 + 删除计数校验。

### P7.1 — PostgreSQL 多 schema 与多库

- 多 schema：树 `库 → Schema → 分类 → 对象`（`public`/连接默认 schema 置顶、系统 schema 不列）；写/DDL/导出/数据编辑按 `"schema"."对象"` 限定（含外键跨 schema、视图定义按 oid、触发器按 schema+表）。
- 多库：浏览该连接可见的全部库（按 CONNECT 权限过滤）；按库懒建会话（上限 4 + LRU），SSH 隧道引用计数复用；「在该库执行」（不提供 `USE`）。
- 定时备份：PG 逐 schema 备份（目标相对，可恢复到任意目标 schema）；导入 SQL 脚本/恢复按目标 schema 设 `search_path`。
- 不支持：PG 跨库结构/数据对比（明确拒绝）。

### P8 — Elasticsearch 客户端

- 新引擎：Elasticsearch（http/https、Basic/ApiKey、TLS、SSH 隧道、只读）；`ConnectionSession` 判别联合扩第三种，SQL/Redis 路径零行为改动。
- db-core：`EsClient` 零依赖（Node 内置 http/https）统一请求封装 + 请求日志 + 只读切面（fail-closed）+ 危险判定。
- 面板：集群总览、索引列表/详情（mapping/settings/aliases 只读）、文档 `search_after` 分页 + CRUD、DSL 查询控制台、REST 控制台（任意 method/path/body）、节点、请求日志。
- 安全：只读切面 fail-closed（GET/HEAD 恒放行；非 GET 仅 POST 且命中读路径白名单；`/_nodes` 管理端点、`_bulk` 等 403，可单条解锁）；危险操作 host 侧确认（DELETE index 需输入索引名）；写请求落审计。
- 修复（复核）：并发 REST 请求不再互相取消（每请求独立 AbortController + 面板关闭统一 abort）；REST 控制台 Enter/历史双击不再绕过在途守卫；面板销毁后不再回写消息；ES 相关文案全部入 i18n。

### 同步前提（D15）

- 本版按「**从未发布过启用同步的旧客户端**」处理，**未加服务端最低版本门禁**。若该前提被推翻，需回补服务端版本门禁。
- 已知限制：未使用 SQL 参数绑定（标识符走白名单 + 字面量转义）；放宽白名单前必须先改为参数绑定。