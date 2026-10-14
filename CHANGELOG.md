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