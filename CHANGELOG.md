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
- **AI Chat 结果图表（2026-10-15，结果驱动 + 手写 SVG 零依赖）**：内联查询结果支持
  **柱状（含分组）/折线（多线）/饼**三种图表——①用户消息命中图表意图词（图表/柱状/
  趋势/占比/chart…）→ 查询完成后按结果形态**自动渲染**（仍可一键切回表格）；②未命中 →
  默认表格 + 形态可用的图型按钮手动切换。类型判定纯前端确定性推断（`inferCharts`：时间样
  x→线优先、两列小额全正→饼、≤60 行→柱；行/点/扇区上限与多序列 6 条封顶，不满足不给按钮
  fail-open 回表格）；悬停数值提示 + 图例；AI 零额外 token、host/协议/执行链零改动。
  验证：vscode-ext 1771（+12）全绿。**修（同日）**：雪花/手机号/编号类「数字型 ID 列」
  （如 tenant_id）误判为度量导致不出图——`idLikeColumn`（列名 id/no/phone…、超 2^53 整数、
  ≥11 位非指标名整数）判类别列；真机 tenant_id 用例回归。
  验证：vscode-ext 1775（+4）。**补（同日）**：图表语义三件套——标题（「按 {维度} 统计：{指标}」+
  原结果标题副行）、轴标签（x=维度名 / y=指标名·多序列「数值」）、提示行（共 N 项·总计·悬停查看数值）。
  验证：vscode-ext 1775 全绿（bundle 重建）。**再补（同日）**：①自动执行门禁拒绝模板占位符
  （`<tenant_id>`/`...`/`{{x}}` —— 缺 schema 时 AI 吐的待替换模板不再被自动跑出语法错）；
  ②柱状图单序列数值标注阈值放宽至 30 行；③数字型长 ID 轴标签/图例改显示**尾段**（…后 6 位，
  雪花 ID 高位相同，截头分不清柱子；完整值在悬停提示）。**再补**：提示词增加别名一致性指令
  （列引用前缀必须在 FROM/JOIN 有声明；单表用无限定列名——修「t.<col> 但无 t 别名」类格式错）；
  缺 schema 时**禁止**在 sql 块输出占位符模板（改为文字追问表名）。验证：ai-core 113 / vscode-ext 1776 全绿。
  **图表视觉重做**：①按容器实测宽度（ResizeObserver）绘制，去掉 viewBox 缩放——宽面板下字号不再放大 2~3 倍；
  ②`niceTicks` 顶刻度保证 ≥ 最大值（修柱子/顶值冲出绘图区）；③x 标签水平显示 + 公共前缀折叠（雪花 ID 只显示区分尾段，
  截断保尾）+ 放不下抽稀，不再旋转裁切；④柱宽封顶 + 顶部圆角，多序列也标顶值（放得下才显示）；分组悬停高亮，提示列完整 x 值与各序列值；
  ⑤折线：竖向游标 + 单序列面积淡填充；⑥饼图改环形（中心总计）+ HTML 图例（标签/数值/占比）；⑦去掉图内大号轴标题（标题行已说明含义）。
  纯函数抽到 `charts/chartMath.ts`（DOM 无关，可单测）。验证：vscode-ext 1795（+19）/ typecheck 全绿。
- **AI 保留字标识符修复（2026-10-15，提示词 + 本地兜底双保险）**：模型直出裸
  MySQL 保留字列名（如 `condition`）导致语法错的真机问题——① nl2sql prompt 增加保留字
  引号指令（方言引号：MySQL/SQLite 反引号、PG 双引号）；② ai-core 新增
  `quoteReservedIdentifiers`（精选保留字表 + 上下文守卫：ORDER BY/GROUP BY/LIMIT n/
  RANK()/INTERVAL 'n'/排序方向不误伤；字符串/注释/已引段不动；限定列 `t.condition`
  照样补引；未知方言 fail-open）；③ host 收流完成后对 ```sql 块改写，经
  `AiFinishDown.content`（新增，权威最终版）下发——显示 = 落库 = 自动执行 = 插入编辑器
  四者一致。验证：ai-core 113（+11，含真机复现用例）/ vscode-ext 1759 全绿。
- **AI Chat 结果内联渲染（2026-10-15）**：SQL/Redis/ES 的 in-chat 执行结果不再堆在回复
  末尾，而是**渲染在对应代码块正下方**（`blockRef` 消息下标+块下标+代次绑定，host 原样
  透传；代次守卫防会话切换后迟到的结果回填错位，失效回退尾部气泡）。旧路径/无 ref 结果
  保持尾部气泡行为不变。
- **AI Chat 只读 SQL 自动执行（2026-10-15，P9 §6.7.1E 红线受控例外）**：AI 回复完成后，
  其中的 SQL 代码块经 `classifyAiSql` 判定为**无风险只读语句**即自动执行并在对话中渲染
  结果 md 表（每条回复上限 3 块；沿用行数上限/确认/只读/生产门禁/审计的既有执行路径）；
  **写与 DDL 一律不自动**，保留手动「Run in chat」。验证：vscode-ext 1756（+6）。
- **P9-AI 评审跟进修复（2026-10-16，自动执行/内联/图表/补引）**：①自动执行增加**语句形态
  白名单**（骨架化后逐语句必须 SELECT/WITH/SHOW/DESC/DESCRIBE/EXPLAIN 起始，叠加原
  `classifyAiSql` 风险分类）——修「BEGIN/COMMIT/ROLLBACK/SET/USE/KILL/FLUSH/LOCK TABLES
  被分类器判 read 后自动执行」的共享会话风险（ROLLBACK/KILL/LOCK 会波及其它面板）；
  ②Stop 中断（aborted）的回复不再自动执行半截 SQL；③自动执行限定关系引擎（Redis/ES 下
  不再误走 SQL 路径、误开非 SQL 会话）；④内联结果表格视图补渲染标题/摘要（含 LIMIT
  追加/多语句提示，与图表视图信息口径一致）；⑤柱/线图要求数值全非负（负值不再钳成
  0 基线误导，fail-open 回表格）；⑥保留字补引覆盖 CASE WHEN/THEN/ELSE 起始位；⑦
  MessageList 类型对齐 `AiToolResultPayload` / CodeBlock inject 兜底直发 / catalog 缩进。
  验证：ai-core 114（+1：CASE 起始位用例）/ vscode-ext 1799 通过/4 跳过（+4：控制语句、
  多语句夹带、注释前缀/字符串分号、负值形态用例）/ typecheck 全绿。
- **AI Chat 复审修复（2026-10-16，自动执行目标一致性）**：①回复级自动执行门禁
  `canAutoRunForReply`——连接/库须与**回复发起时**一致（生成期间切换连接或库，按旧 schema
  生成的 SQL 不再跑到新目标）、**生产连接不自动执行**（保留手动按钮）、仅关系引擎；
  ②webview `chunk`/`finish` 丢弃不属于当前会话的消息（`isForeignSession`；生成中切走会话
  不再把旧回复流进新会话并在那里自动执行；新会话首发无 activeId 时不误丢）；③清理图表死代码
  （`CHART_META.comp`、Bar/Line 未使用的 `yAxis` prop）。验证：vscode-ext 1807 通过/4 跳过
  （+8）/ typecheck 全绿。
  **补**：新增设置 `devbelt.ai.autoRunReadOnlySql`（默认开）——关闭后 AI 回复里的只读 SQL 一律不自动执行，
  保留手动「Run in chat」（红线例外的用户侧安全阀）。
- **AI Chat「业务规则」入口（2026-10-16）**：Chat 侧栏新增「业务规则」折叠区（头部显示
  已配置/未配置，展开显示术语/规则字数），「编辑」打开弹层——**UI 合并、存储与提示词保持分离**：
  上下两个多行文本框分别写入 `domainContext` / `defaultDirectives`（`maxlength=2000` 与 host 截断
  一致、字数计数、无改动时保存置灰、Ctrl/Cmd+Enter 保存、Esc 关闭、未保存关闭确认；编辑中
  host 快照刷新不覆盖输入；未选连接时按钮禁用并提示）。解决连接树 `showInputBox` 只能单行、
  入口不可见、配置是否生效无从确认的问题；连接树右键命令保留。新增 `ai/businessRules.ts`
  （载荷校验/摘要纯函数）。验证：vscode-ext 1813 通过/4 跳过（+6）/ typecheck 全绿。
- **AI Chat 执行可见/可取消 + 慢查询优化 + 注入措辞对齐（2026-10-16）**：①in-chat SQL 内联
  执行时代码块下方显示「执行中 N.Ns」实时计时与「取消」按钮（`toolRunning` 下行，host 开始时间
  为准），≥10s 追加「查询较慢，可继续等待或取消」；取消走单查询 token（`runHeadless` 新增可选
  `onStart` 句柄，返回 `userCanceled`，不记历史/审计；确认门禁被拒也会结束执行中指示）；新建
  会话/面板销毁时取消全部在途查询，「Stop」仍只停止 AI 生成。②完成或取消且耗时 ≥5s 时结果区显示
  「耗时 N，较慢」+「让 AI 优化」——在**当前会话**追加用户消息，先 EXPLAIN（不带 ANALYZE）再走
  optimize prompt 流式回复；该回复不触发自动执行；`runExplain` 抽到 `ai/explainPlan.ts` 与编辑器
  命令共用。③Chat/数据问答的业务规则注入改为与 NL2SQL 同一套两个区块（`DOMAIN_CONTEXT_HEADER`/
  `BUSINESS_RULES_HEADER` 共用常量：术语“优先于先验”、规则“列存在才适用”），不再合成单块。
  验证：vscode-ext 1819 通过/4 跳过（+6）/ ai-core 114 / typecheck 全绿。
- **AI 模型接入（2026-10-16，弹层 + 厂商目录 + 选择性同步）**：自带 Key 从「设置页改 3 项 +
  单行密码框输 Key + 右下角看测试结果」收敛为 Chat 状态条一个「模型接入」弹层——模式 / 厂商 /
  baseUrl / 模型 / API Key / 同步项一次配齐。①**厂商目录**：服务端迁移 010 新表 `ai_providers`
  （预置 OpenAI/阿里百炼/DeepSeek/智谱/小米/Moonshot/硅基流动/MiniMax），管理后台新页「AI 模型
  厂商」（增改/启停/模型列表，console+CSRF+幂等+审计+reason）；客户端 `GET /api/ai/providers`
  （公开只读限流）+ Memento 缓存（1h TTL）+ 内置兜底，目录响应按不可信输入校验（仅 https）。
  ②**弹层**：厂商下拉（预设 ∪ 自定义 ∪「＋自定义厂商」）、baseUrl 可编辑（https 强制，回环
  http 例外）、模型下拉 + 自定义模型、Key 密码框（显示开关/已保存占位/清除）、**明示密钥发往
  地址**且未知主机告警、「测试连接」直连 chat/completions 并把失败映射为稳定原因码内联展示
  （auth/model/network/timeout/rate/server）、「保存」后即生效。③**选择性同步（本机勾选，双向
  生效）**：新同步实体 `aiModelAccess`（db-host codec/apply/mutator + 宿主后端；无跨实体引用）——
  payload 分「当前选择/自定义厂商与模型/API Key」三组，**发送端只编码勾选组、接收端按组合并**
  （缺省组保留本机值；Key 端到端加密只在勾选时传输、接收端写 SecretStorage、对端关闭不清空本机）；
  本机记录永不存 Key（stripKey 兜底 + 治理测试钉住）；勾选项存本机 Memento 不随同步走。运行时
  落地：模式/baseUrl/model 写用户级设置（readAiConfig 数据源）；同步到达但本机无 Key → 提示输入。
  顺带修复：`sessionFactory` 此前未把 `schemaNotesBackend` 转发给会话（S7f 注记同步实际未接入、
  收到记录会因缺后端抛错）——本次接线 `aiModelAccessBackend` 时一并补上。验证：server 628 /
  admin-ui 44 / vscode-ext 1836 全绿（+codec 合并/勾选门禁/纯函数/治理 29 例）+ 全仓 typecheck；
  迁移 010 未在真实 MySQL 执行（部署前须在测试库验证）。**修（同日）**：①服务端代理模式隐藏
  「测试连接」（测试的是自带 Key 的直连地址，代理模式下按钮无意义）；②「自定义模型…」选中后
  输入框不出现——原实现 set 时清空 model、get 又按空值回退导致 v-if 永不成立，改显式选中态
  `customModelSelected`（换厂商复位；已保存的自定义模型初始即选中）。
- **选择性同步（2026-10-16，`devbelt.sync.items`）**：新增按机器生效的同步项开关——连接与
  分组 / 保存的查询 / 表注记 / 验证器 / AI 模型接入 五类可分别关闭（默认全开，行为与现状一致）。
  **关闭语义**：本机不推送该项；云端变更入 deferred 暂存、不覆盖本机（重新打开后自动重放补齐，
  无需重拉）；本地数据保留不清除；同步体检不把该类型计为「本地缺少云端记录」。**依赖级联**
  （引擎侧强制）：查询/文件夹/表注记引用连接，关闭「连接与分组」时随停。AI 模型接入的三组
  子项（选择/自定义/Key）是类型内部粒度，仍由模型接入弹层控制。实现：db-host `EntityStore`
  类型过滤 + 引擎 `typeEnabled`（pull 跳过入 deferred / 体检过滤）+ 结果计数 `skippedDisabled`；
  扩展端 `sync/syncItems.ts`（解析/级联/实时读取纯函数）+ 装配。测试：引擎停用/重放/出站/体检
  四路径 + 级联矩阵。验证：vscode-ext 1846 通过/4 跳过 / db-host 23 / typecheck 全绿。
- **SQL 执行超时可设置（2026-10-16，默认 300 秒）**：新增设置 `devbelt.sql.queryTimeoutSeconds`
  （默认 300，范围 0–86400，0 = 不超时；**改动实时生效**，无需重连——`QueryService` 每次查询读取
  静态值）。db-core 静态默认由 30s 调整为 300s，作用于全部 SQL 会话（结果面板 / Chat in-chat /
  表面板 / 元数据 / EXPLAIN）；长查询可用 Chat 内联「取消」中止。连接表单「请求超时 (ms)」仍按
  连接覆盖全局值；新连接默认改为**留空 = 跟随全局**（原硬编码 30000ms 会一直压住全局设置，
  占位提示说明）；已保存连接的显式值不变（清空字段即跟随全局）。Redis/ES 的命令超时不受影响
  （各自仍读连接级 requestTimeout）。测试：`utils/sqlTimeout` 解析/装配 +3；db-core 682 /
  vscode-ext 1849 全绿 + typecheck。顺带修复：同步引擎选择性同步测试遗留的重复导入与未用变量
  （该阶段当时只跑了 vitest 未跑 tsc）。
- **AI 计费引擎 + 管理员后台化（2026-10-16，迁移 011）**：一切业务参数显性进管理后台——
  ①**模型计价表** `ai_model_pricing`（模型唯一；输入/输出分价——分/1M token；权重 k 可覆盖，
  缺省由单价推导）；②**计费设置** `ai_billing_settings`（单行：激活模型、上游 baseUrl、
  **上游 API Key（只写不读**——GET 仅回 configured+尾号提示，幂等请求体与审计均脱敏**）**、
  全局调整系数；60s 缓存 + 写后即时失效；全空回退 env（兼容现状）；③**统一 token 口径**：
  计费 token = (输入 + 输出 × k) × 系数，**预占与结算同口径**（并发保护不失效），quota 空间
  整体即计费 token；审计分列原始/计费/成本（costCents 按分价折算，缓存价不分=保守高估）；
  ④**财务月报** `GET /api/admin/ai/finance`（按月：原始/计费 token、折算成本、加油包+套餐实收、
  毛利——成本按激活模型现价折算，历史为近似）；⑤admin-ui 新页「AI 计费」（设置/计价表/月报
  全可视可改，reason 必填）；⑥**管理员后台化**：用户页新增「设为/撤销管理员」（防自锁：不可改
  自己角色；审计 granted/revoked）。验证：server 644（+16：计费数学/生效配置回退与缓存/路由
  鉴权与脱敏/角色防自锁）/ admin-ui 46（+2）/ typecheck 全绿；迁移 011 未在真实 MySQL 执行。
- **积分化 + 多模型计费（2026-10-16，迁移 012）**：
  - **积分口径**：1 积分 = 1000 计费 token；加油包→「积分充值」、月额度→「本月赠送」。db-ui/扩展/
    admin-ui 所有额度/余额/消耗数字统一 ÷1000 展示（`lib/credits.ts`）；管理端近月用量/请求明细保留
    原始 token（对账口径）。vscode 配额条 i18n 中英同步（credits）。
  - **每模型计费倍率**：`ai_model_pricing.multiplier_override`（NULL=用全局）；生效规则
    `模型倍率 ?? 全局倍率`；计价 CRUD/DTO 透传。
  - **请求流水** `ai_request_log`（每笔一行：原始/计费 token、当时 k 与倍率、当时成本；不存对话文本）；
    结算事务内与配额扣减同生共死；保留 180 天（retentionCleanup 分批清理）。
  - **区间毛利统计**：`GET /api/admin/ai/finance/summary?from=&to=`（≤12 月）——合计/逐月/每模型；
    成本取流水当时值（精确），收入取订单。AI 计费页「经营概览」区间选择（本月/近3/6/12月）+
    指标卡 + 实际输出占比；「模型价格」加列：计费倍率/每积分成本（输入输出混合公式）/测算毛利率。
  - **接入设置**：厂商+模型联动下拉选激活模型；`typical_output_ratio`（成本测算输出占比，默认 0.2）。
  - **用户请求流水视图**：`GET /api/admin/ai/users/:userId/requests`（id 倒序 keyset）；用户详情
    「AI 积分」页签新增请求记录表（时间/模型/输入输出/消耗积分/当时成本/耗时）。
  - **修复既有口径 bug**：`ai_token_usage` 此前只存计费 token，财务月报把它当原始 token 使用——
    输出成本被多乘 k（高估）。012 加 `raw_*` 两列（存量回填 raw=计费，近似），`financeMonthly`
    原始/计费分列、成本按原始 × 单价；`billingTokens` 不再二次加权。
  验证：server 656（+9：倍率优先级/流水写入/summary/请求流水路由）/ admin-ui 52 / db-ui 128 /
  vscode-ext 1849 全绿；迁移 012 未在真实 MySQL 验证（随下次部署自动执行）。
- **管理后台 UX 整改（2026-10-16）**：
  - **用户详情页**（新 `/users/:id`）：点列表邮箱进入；页签=概览/订单/发票/AI 用量/同步数据/操作记录，
    集中查看与该用户相关的一切数据；操作按钮（禁用/订阅/角色）收进详情页头。列表页只留「详情 + 启用/禁用」。
  - **同步明细**：新增 `GET /api/admin/users/:id/sync-records`（记录级元数据：类型/记录ID/版本/密文大小/时间，
    kind 过滤 + id 倒序 keyset 分页）；页面展示同步状态卡（状态版本/加密套件）+ 分类汇总 + 记录明细，并标注
    「端到端加密，平台只能看到元数据」。仓储新增 `ISyncRecordRepo.listMetadataByKind`（MySQL+fake）。
  - **页签化**：AI 加油包拆「档位/订单」（删用户配额查询，指向用户详情页）；AI 计费拆「经营概览（指标卡）/
    模型价格/接入设置」，公式收进可展开说明。
  - **去专业化文案**：调整系数→计费倍率、权重 k→输出折算倍数、env 回退→使用服务器默认；审计页筛选/表头
    中文化 + 事件类型显中文名（`lib/auditLabels`）；厂商页字段中文化+表单标签。
  - **订单页**：13 列收敛为 7 列 + 「详情」弹窗；订单/审计/发票页用户 ID 可点跳用户详情。
  - 新组件 `Tabs.vue`/`FormField.vue`（表单项带标签/必填/帮助）；用户列表时间筛选加标签。
  验证：server 647（+3 sync-records 路由用例）/ admin-ui 52 / typecheck+build 全绿。
- **后台界面重构（2026-10-16）**：admin-ui 改为左侧分组侧栏（运营/商业化/AI/系统）；用户页行内操作收进
  「更多 ▾」下拉，状态/角色改徽标；db-ui 导航分「账户」「订阅与账单」两组 + 子导航（补 AI 加油包入口）。
  `theme.css` 统一页头/筛选条/表格/按钮层级/徽标/下拉，两端页面 scoped 中重复样式已移除。纯视觉，无 API/路由变更。
- **用户管理 · AI 数据视图（2026-10-16）**：用户页新增「AI 用量」弹层——本月配额（已用/预占/
  月剩余/加油包/重置时间）、**近 6 个月用量**（计费 token 口径，输入/输出/请求数分列）、
  **加油包购买**（笔数/已支付笔数与金额/退款笔数/最近支付时间）、活跃加油包余额明细
  （档位/总量/已用/过期）。实现：`GET /api/admin/ai/users/:id/quota` 增量返回 `months`
  （`ai_token_usage` 近 N 月行，降序）+ `topupOrders`（orders 表 purpose='topup' 聚合）；
  `AiTopupOrder` 增补 `paidTime`。验证：server 644（配额端点用例扩展）/ admin-ui 48（+2：
  弹层渲染与空态）/ typecheck + build 全绿。
- **P9.1c 已交付（2026-10-15，客户端购买闭环；P9.1 全量收口）**：用户侧下单
  `POST /api/ai/topup-orders`（console + CSRF + 限流 10/h + 支付开关/渠道 fail-closed 503；
  同人同 SKU 同渠道 pending 复用 P1b 语义；金额以库内 SKU 为准）；支付回调在 paid 推进后
  **按 `order.purpose` 分发**（topup → `AiTopupService.fulfillInTx` grants 入账 + paid→fulfilled
  同事务；plan 路径逐字不变，billing 经组合根注入不破模块边界）；db-ui 新增「AI 加油包」购买页
  （`/ai-topup`：档位卡片 + 微信扫码/支付宝跳转 + 轮询至入账）+ 账户页 AI 双段配额卡片与购买入口
  + 订单页用途显示；扩展 Chat 配额条双段文案（`wv.ai.quota.dual`）+「购买加油包」按钮
  （openConsole 白名单 `/db/ai-topup` → openExternal）；`serverProxyProvider` 快照透传双段字段
  （旧服务端回退兼容）。验证：server 617（+7）/db-ui 128（+4）/vscode-ext 1750/db-host 23
  全绿 + tsc 干净。
- **P9.1b 已交付（2026-10-15，管理后台）**：加油包运营闭环——新增 `consoleAiTopup` 路由
  （console-only + requireAdmin + CSRF + 幂等回执 + 限流）：`GET /api/admin/ai/skus`（全量）、
  `PATCH /api/admin/ai/skus/:code`（改价/停启用，reason 必填）、`POST /api/admin/ai/topup-orders`
  （手工建单，**金额二次确认** expectedAmountCents≠当前价 → 422 AMOUNT_MISMATCH）、
  `/:orderNo/fulfill`（paid→fulfilled 幂等重试）、`/:orderNo/refund`（撤销额度）、
  `GET /api/admin/ai/users/:userId/quota`（双段快照 + grants 明细）；审计 6 类事件随业务同事务
  （admin.ai.*）。`AiTopupService` 拆 `*InTx` 变体并入调用方事务；`Order` 实体补
  purpose/skuCode、planCode 放宽 NULL、channel 扩 manual；**通用订单退款拒绝 topup 订单**
  （防「订单已退款+额度仍活」矛盾账）；admin-ui 新增「AI 加油包」页（四段：档位目录/手工建单/
  加油包订单/配额查询），订单页增用途过滤与 manual 渠道。admin→ai 模块依赖经接口登记。
  验证：server 610（+11）/admin-ui 36（+5）/db-host 23/vscode-ext 1750 全绿 + tsc 干净。
- **P9.1a 已交付（2026-10-15，服务端核心）**：加油包账本落地——迁移 009（`ai_topup_skus`
  预置 3 档 topup_500k/2m/10m + `ai_quota_grants`（`uq_grants_order` 唯一键=入账幂等锚点）+
  `orders` 扩 purpose/sku_code、plan_code 放宽 NULL、channel 扩 'manual'）；`aiTopupService`
  （listSkus/createManualOrder/fulfill/refund/grantBalance，订单 fulfilled 与 grants 入账同事务，
  重放幂等）；`aiQuotaService` 升级**双段 FIFO**（月额度优先、不足按 `expires_time` 升序扣 grants，
  settle 时月段吸收超出分配、grants ≤ 分配扣减）；`GET /api/ai/skus` 上架档位；
  409 配额错误扩 `topupRemaining`。验证：server 599 通过（+14 双段/加油包用例）/tsc 干净；
  真库集成用例（SKU 种子/幂等/FIFO）已备（CI 无库时跳过）。P9.1b（管理后台）/P9.1c（客户端）待做。
- **真机复核修复（2026-10-12）**：AI 请求 401 自动续期并重试一次 —— 新增
  `AuthService.refreshAccessToken`（复用 SyncClient 单飞刷新）+ `ServerProxyProvider.onAuthFailure`
  （仅 401、仅重试一次；续期失败/同 token 不重试；`getUsage` 同语义）+ AiService 注入。
  修复前 access token（15m TTL）过期会直接报 "AI proxy authentication failed (HTTP 401)"。
  测试 +6；仅扩展侧改动，无需服务端重部署。
- **S7k 同步体检/修复（2026-10-14）**：本地实体丢失但同步游标已到最新时自动同步不会重拉（真机：
  验证器条目丢失而云端完好）。新增引擎 `inspectLocalIntegrity`/`repairLocalMissing`——对「远端
  存活 + 本地实体缺失 + 无未决出站变更」的映射**强制重放**（force 绕过版本不新跳过；复用
  applyRecord/unresolved 收敛，分页只读拉取、不动游标）；命令面板「同步体检（完整性检查与修复）」
  （`devbelt.syncDoctor`，`devbelt.sync.ready` 可见）：只读报告→确认→修复→验证器孤儿条目自愈
  归组；手动同步结果新增「本地缺少 N 条云端记录」提示（自动同步仅落诊断日志）；同步结果带
  `localMissing` 计数。**S7k.1**：候选涵盖「本地墓碑（deleted=true）但云端存活」（修复复活），
  云端墓碑侧 force 应用墓碑并删映射（向删除收敛）。**S7k.2**：全同步实体「删除→重新添加」生命周期
  e2e（连接/分组/查询/文件夹 + 验证器三类 + schemaNotes）+ 评审整改（rowLimit 写语句排除 + 行尾
  注释安全、esExec size 钳制、doctor 错误封装、repair 快照漂移校验 + notFound 计数、单元格反斜杠
  转义、runHeadless 单测）。**S7k.3（第二轮评审整改）**：较新本地墓碑（updateTime>revision）视为删除意图、不复活；修复补远端 epoch 对账；同 recordId 取最新版去重 + 早停（修复计数不再虚高）；esExec 结果截断 + suggest/空聚合/size 归一；LIMIT 跳过 FETCH FIRST/TOP 并对对话内执行标注"已自动限制 N 行"；contextDetail 懒加载错误复位 + 切连接重置；recordCodec encode 复用常量。**继续整改**：结果表格外包滚动容器（修 `display:block`/`border-collapse` 冲突）、折叠状态随内容复位、分隔行校验管道行、`sqlChatResult` 先截断后转义 + 截断注记 + 无列名 JSON 回退、医生结果展示 skipped。**三批整改**：代码块运行按钮按引擎上下文显隐（dbType 透传）；Redis 注入逐条串行 + 危险命令确认后继续下一条；多语句回帖标注；`LocalRepairResult` 加 `incomplete`（区分 notFound 来源）+ 补 epoch 变更/快照漂移边界用例。**S7k.4 关系校准**：Sync Doctor 修复时对本地存活实体校验引用（connection.groupId/group.parentId/query.connId+folderId/authenticatorEntry.groupId+tags/schemaNotes.connId），与云端不符则 force 重放校正，`LocalRepairResult.relinked` 回显——修"条目被自愈归错分组"的问题。vscode-ext 1732 / db-host 23 全绿。spec §十四.12 回填。（SQL 重名列按位置渲染未做：rows 为对象键式，需改数据形态。）
- **S7k.5 对账收敛重构 + 一致性检测 + 不变量测试（2026-10-14）**：按「正确与应该」重做客户端对账——`classifyReconcilePlan` 把每条 confirmed 映射归入唯一动作（pending/localDelete/missing/revive/relink），`convergeToCloud` 单一循环 force 收敛到云端（三不变量：幂等/隔离/单写写入 JSDoc 与测试）；`LocalRepairResult` 计为 materialized/relinked/converged；解锁后自动体检告警 + 一键跳同步体检；手动/自动同步发现本地缺失也带一键修复（自动去重 10 分钟）；不变量测试（幂等、隔离、分组名漂移）；**db-ui 网页验证器补全分组 + 标签**（与扩展对齐：`collectAuthenticator`/`groupAuthenticator`/`tagNameMap` + 分组区块/标签徽标渲染）。vscode-ext 1736 / db-host 23 / db-ui 124 全绿。spec §十四.12 回填。
- **S7k.6 一致性干跑校验 + 漂移修复入口（2026-10-14）**：修根因——名字/引用漂移属 `relink` 类，而 `inspectLocalIntegrity` 只计缺失（missing/revive），体检在 `missingTotal=0` 时直接判健康返回，唯一能按云端校准漂移的 `repairLocalMissing` 永不执行（真机表现：分组名漂移 + 条目归错组，长期无提示无人修）。新增 `verifyDrift()` 零写入干跑（与 repair 共用 `classifyReconcilePlan` + 分页扫描，判定一致，`incomplete` fail-open）；`syncDoctor` 门槛改为「缺失 或 漂移」并分别展示明细，仅漂移也进入确认与修复；解锁（无缺失时）与手动 pull/push/立即同步自动干跑校验，检出真实漂移弹「发现 N 处本地与云端不一致」+ 一键修复（不自动改数据）。**跟进补修**：验证器分组/标签此前不在校准目标集内、命名比对仅对连接分组生效——`REF_CARRYING_TYPES` 纳入 `authenticatorGroup`/`authenticatorTag`，命名比对泛化为「载荷带 name 即比对」（验证器条目无 name 自动不适用），修「修复后验证器分组名仍不正确」。vscode-ext 1747 / db-host 23 / db-ui 124 全绿。
- **S7k.7 孤儿墓碑 + 空组清理（2026-10-14）**：`classifyReconcilePlan` 把「较新本地删除且无待推出站」从静默吞掉改为 `orphanDelete` 动作（pull 不生成出站 → 孤儿墓碑=损坏，交给对账收敛）；孤儿空分组（无映射+无出站+无引用+非新建 60s）清理计 `swept`；`LocalIntegrityReport` 暴露 `localDelete`。vscode-ext 1747 / db-host 23 全绿。
- **S7k.8 数据体检面板：发现 → 用户选择（2026-10-14，同步 UX 复盘）**：推倒「提示堆」——此前累计 8+ 条术语化弹窗（映射/漂移/校准/收敛），用户不可读。重做为**决策面板**：引擎 `inspectFindings()` 逐条列出不一致（缺失/命名漂移含「本机 X → 云端 Y」对照/归属漂移含字段对照/本机已删云端仍在/云端已删本机仍在/孤儿空分组/真冲突），`repairFindings(ids)` 只修用户点选的条目（幂等、云端为准、尊重待推出站与真实删除意图）；新增 webview 面板（`SyncDoctorView.vue` + provider，逐条按钮 + 冲突三选一 + 全部按云端修复 + 重新检查）；解锁/手动同步后检测到不一致仅一条白话通知「发现 N 项（查看）」打开面板。**删除**：旧 syncDoctor 弹窗流、syncConflicts QuickPick（文件+命令+词条）、unlock/手动/自动三类提示、doctor 计数长句——提示堆归零；文案全部白话化（`sync.find.*`），字段名经 `sync.field.*` 翻译。vscode-ext 1739 / db-host 23 全绿。
- **S7k.9 方向抉择 + 目标缺失兜底（2026-10-14 晚）**：真机反馈「为什么只有云端覆盖本机」——修复方向交给用户逐条选择：`repairFindings(ids, direction)`，`'local'`（用本机覆盖云端）复用冲突解决 rebase 机制构建 put/delete 出站（baseVersion=云端当前版本，走标准版本链），面板每条发现双方向按钮（命名/归属漂移：按云端更正 / 用本机覆盖云端；本机已删：从云端恢复 / 保持删除（推送云端）；云端已删：删除本机这条 / 恢复到云端），本地方向修复后立即触发一轮同步推送；批量仍只保留「全部按云端修复」。归属漂移的云端目标本机缺失时不再泄漏内部 id（白话「（本机缺失）」），且**兜底产出该目标的缺失发现**（pending 映射被 classify 静默跳过的盲区）+ 二次扫描补云端名称，保证「先恢复分组、再归位条目」的修复顺序自洽。vscode-ext 1743 / db-host 23 全绿。
- **S7k.11 对账域重构（2026-10-14 深夜，用户指令「彻底改动、死代码全删」）**：把 S7k→S7k.10 十轮修补长出的分支森林收敛为**一张状态矩阵**——新模块 `reconcileFindings.ts`（401 行）承载「发现什么」（`classifyActions`/`findingsFromScan`/`diffRecord`/`orphanGroupCandidates`，本机态×云端态→发现类别）与「怎么修」（`OP_TABLE`：类别×方向→原语，退化规则单一位置定义，git 式 `--ours/--theirs/merge` 模型）；`syncEngine` 瘦身为纯机制层（扫描/apply/签名推送/定向推送），`repairFindings` 从三分支变「矩阵解析→执行原语」单循环；结果类型 11 字段收敛为用户可读的 7 字段 `RepairOutcome`（cloud/local/merged/swept/failed/notFound/pending）。**删除**：`inspectLocalIntegrity`/`LocalIntegrityReport`、coordinator `countLocalMissing`+`localMissing` 链、引擎内 detect/reconcileDiff/orphanGroupCandidates/referenceFields/displayValue/REF_CARRYING_TYPES 与三方向分支（syncEngine -470 行）、未用的 `toFindingViews`；顺带修协议违规测试夹具（墓碑不得携密文）。护栏：公共 API 签名不变 + 67 场景测试全保留迁移为回归网（期间捕获并修正批量断言迁移错误与 1 个真实协议校验点）。vscode-ext 1746 / db-host 23 全绿。
- **S7k.12 全量对账（2026-10-15 上午，修「面板谎报一致」）**：根因——检测只看**映射过**的记录，云端存在但本机无映射的记录整体不可见（refs 对未映射目标也跳过），于是「管理后台 3 组 vs 扩展 2 组」面板仍报 0 发现。修复：①检测改为**全量云端扫描**（收集 feed 全部记录最新版）+ `cloudOnlyFindings`（无映射 / 孤儿 pending 且无出站的存活记录 →「云端有，本机没有」，带云端名）；②引用比对改**对称**（本机有引用而云端无也算漂移——覆盖「无分组条目」）；③missing 的**使用本机=删除云端这条**（`mutator.buildCloudDelete`，本机无实体也可构建，定向推送）——三操作语义闭环；④删除二次扫描兜底（全量天然覆盖，净简化）。vscode-ext 1749 / db-host 23 全绿。
- **S7l.1 ES 连接接入同步（2026-10-15 上午，用户指令「全分组/连接/验证器/AI chat 都要同步，不允许跳过」）**：删除两处 fail-closed——`ES_PAYLOAD_FIELDS` 白名单（esProtocol/esPathPrefix/esAuth(含 username)/esPassword/esApiKey/useSSL/rejectUnauthorized/requestTimeout/共用 SSH+TLS 路径字段），encode/decode round-trip + esAuth kind 严格校验 + requestTimeout 上界；`connectionEngineUnsupported` 只兜真正未知引擎（H3 前向兼容保留）；敏感字段走既有 E2EE 密文机制（materialize 已含 esPassword/esApiKey）；删除 `ES_CONNECTIONS_NOT_SYNCABLE`/skip 文案映射/i18n 键；跳过原因改为如实显示原文。vscode-ext 1750 / db-host 23 全绿。
- **S7j AI 生成 SQL 行数上限（LIMIT 10，2026-10-13）**：提示词双入口约束（`SYSTEM_PROMPT` 规则 10 +
  nl2sql 输出契约）——生成的 SELECT 一律附 `LIMIT 10`（用户明确要全量/指定条数时除外）；执行侧机械
  兜底 `ensureSelectRowLimit`（单语句 + SELECT/WITH 开头 + 无 LIMIT/SELECT INTO/行锁 → 追加，
  保守不误改），接入 AI Chat 两条执行路径（面板/对话），防止大结果集全量缓冲导致卡顿/崩溃。
  测试 +5（ai-core 102、vscode-ext 1703 全绿）。spec §十四.11 回填。
- **S7i AI Chat 双 Run + 回帖格式适配（2026-10-13）**：sql/redis/json 代码块统一两个执行入口——
  「在面板运行」（SQL 复用查询面板并改为 AI 面板**平级 tab**；Redis 打开控制台注入执行；ES 打开
  DSL tab 注入 index/body 执行）与「在对话中运行」（结果回帖到消息流）：SQL → **Markdown 表格**
  （≤50 行，单元格单行化/转义/截断；写语句=完成+耗时；错误=错误信息）；ES → **按结果类型的
  pretty JSON**（hits/aggregations/suggest/原始 body；错误 `{status,type,reason,rootCause}`）；
  Redis 维持 CLI 文本；toolResult 协议新增 `format`/`lang`（结果 fence 不出现误触执行按钮）。SQL
  对话内执行走 `QueryExecutor.runHeadless`（无面板；确认/只读/生产门禁与历史/审计/DDL 事件同口径）。
  测试 +11（vscode-ext 1699 全绿）。spec §十四.10 回填。
- **S7h 表/列编辑器升级为宽弹层（方案 A，2026-10-13）**：TableNoteDialog（640px）替代侧栏窄编辑器——
  列搜索 + 过滤（全部/未填写/已填写含计数）、DB 注释可展开、说明/样例两栏、每列抓取样例；
  脏数据保护（保存/放弃/取消）、保存按钮仅脏时可用、保存回执 + 最后修改刷新、✎/# 已填徽标；
  侧栏最终两视图（注入的表/会话）。删除旧侧栏编辑器（死代码清理）。
- **S7g 注入范围收敛为弹层（方案 A 定稿，2026-10-13）**：侧栏「注入的表」为本次实际注入只读快照（点表名进表/列说明编辑器）；「注入范围：自动/自定义（N 张）」收敛为该视图头部入口 → 弹层勾选（能力保留、不并列第二张列表）；contextDetail 仅含表+统计，术语/规则原文不再下发展示；清理无用词条/死字段/旧选择视图组件。
  自动模式成为唯一注入模式，host 选择能力休眠保留）；「实际注入的表」点表名即进入表/列说明
  编辑器；术语表/默认规则不再展示原文（命令面板配置）。侧栏三视图：注入的表／表说明／会话。
- **S7f schemaNotes 同步实体 + 面板概念理顺（2026-10-13）**：表/列注记升级为 E2EE 同步实体
  （每连接+库一条记录；connId recordId 引用 + unresolved 收敛；墓碑传播删除；旧格式自动迁移；
  宿主后端复用同一 AiContextStore）；注记编辑器显示最后修改时间；面板命名理顺为
  「选择注入的表」（输入）／「实际注入的表」（输出快照）／「发送给 AI 的上下文」（全景快照）。
  **注意：服务端白名单已加 `schemaNotes`，需重新部署后同步才生效**。测试 +10。
- **S7e 上下文抽屉可读性 + 表/列注记与样例（2026-10-13）**：上下文抽屉四段改 VSCode 风格
  折叠并新增「注入表清单」；无注释的表/列可补临时说明与样例值（`devbelt.ai.schemaNotes.<connId>.<库>`，
  序列化期合并、保存即生效；用户注记不受列注释开关影响，纳入 40K 预算）；样例值用户逐列点击
  抓取（只读 `SELECT DISTINCT … LIMIT 10`、敏感列拒绝）。测试 +7（ai-core 101 / ext 1678 全绿）。
- **修复：F5 调试态同步解锁/账号恢复误报"口令不一致"（2026-10-13）**：Argon2id 派生 worker
  默认继承父进程 `execArgv`，调试态扩展宿主带 `--inspect-brk`，worker 停在等调试器永不回消息 →
  30s 超时被 catch 压成口令错误。修复：`defaultSpawn` 显式 `execArgv: []` + 回归测试；同时解锁
  失败弹窗/Diagnostics 携带真实错误（此前多类失败被压成同一文案）。云端材料与口令经离线复演
  实测健康。
- **S7d 大库 400 修复 + 三级作用域 + 字号（2026-10-12）**：① 修复大库上下文超服务端
  单条 60K 字符上限的 HTTP 400——`serializeSchema` 增 `maxChars`（40K）超预算截断 + 标注；
  ② "连接 → 库 → 表（多选）"三级作用域：表选择抽屉（搜索/复选/全选/清空），持久化
  `devbelt.ai.selectedTables.<connId>.<库>`，勾选即仅注入所选表（exclusive），未勾选 = 自动模式；
  ③ AI 面板字号跟随 VS Code 主题字号（`--vscode-font-size` / `--vscode-editor-font-size`）。
  测试 +8（ai-core 99 / vscode-ext 1675 全绿）。
- **S7c ES DSL 生成与执行（2026-10-12）**：选中 ES 连接时 Chat 面板切换为 ES 专用
  system prompt（意图复述 + ```json 块契约 = `POST /<index>/_search` 请求体；禁索引名/路径/
  破坏性 DSL）；上下文注入选中索引 mapping（≤200 字段、递归 3 层、截断标注）。代码块「执行」
  走 `ai/esExec.ts`：JSON 校验 → 固定只读 `_search` 路径（只读连接不受影响）→ total/took/
  前 3 条 _source 预览 + 聚合存在性提示；结果 toolResult 回帖。测试 +8；spec 增补 §十四。
- **S7b Redis 生成与执行（2026-10-12）**：选中 Redis 连接时 Chat 面板切换为 Redis 专用
  system prompt（意图复述 + ```redis 块契约；禁止 SELECT/连接态命令、禁止编造 key）；上下文注入
  选中逻辑库 keyspace 概览（INFO keyspace + DBSIZE + SCAN 采样 + TYPE 直方图 + 前缀分组）。
  代码块「执行」走 host 执行桥：runExclusive 串行（SELECT 归一 + 整批原子）、SELECT/连接态命令
  阻断、写/危险命令模态确认、只读连接客户端兜底、写命令逐条审计；结果以 toolResult 回帖。测试 +10。
- **S7a 跨引擎作用域选择器（2026-10-12）**：AI 面板支持"选库"（单选切换，持久化
  `devbelt.ai.lastScope.<connId>`）——MySQL/PG 列数据库（过滤系统库）、Redis 列逻辑库
  （INFO keyspace ∪ CONFIG databases ∪ 当前库；cluster 恒 db0）、ES 列索引（_cat/indices）、
  SQLite 隐藏；**连接可以没有默认库**（默认顺序：上次选择 → 连接默认库/当前库 → 第一项）；
  PG 异库由显式选择打开衍生会话；根治无默认库时的 "Schema unavailable"（MySQL 无库不再走
  会报 ER_NO_DB_ERROR 的逐表 `SHOW FULL COLUMNS`；单表失败跳过并标 partial）；修复
  `'MYSQL'`/`'mysql'` 大小写错位导致批量列路径从未生效的潜伏缺陷。测试 +15。
- **真机复核修复 2（2026-10-12）**：AI 上下文会话定位对齐连接键规则 —— 新增
  `peekSqlForConnection`（非 PG/配置库 → 主会话；PG 异库 → 衍生会话且缺失不回退，防串库），
  修复"配置了默认库的 MySQL/SQLite 连接在 AI 面板误报『连接未打开』"（Alt+A / Inline 的
  schema 注入同因受益）；`loadLightSchema` 改为接收已解析会话。单测 +5；仅扩展侧改动。
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