/**
 * 公开文档中心（`/db/docs`）：服务端渲染、零构建依赖、**无需登录**。
 *
 * 外壳（header/footer/tokens）来自 `publicChrome.ts`，与首页 SPA 视觉一致。
 * 插图使用官网同一批真实截图（`/screenshots/*.png`）。
 * 内容对应 v0.4.0 的实际能力与设置项，正文为受信任的静态 HTML。
 */

import { renderPublicPage } from './publicChrome.js';

export interface DocShot {
  /** 站点内绝对路径，如 `/screenshots/01-sql-workbench.png`。 */
  src: string;
  /** 图片替代文本。 */
  alt: string;
  /** 图注（显示在图片下方）。 */
  caption: string;
  /** 原始像素宽高，用于预留版面避免布局跳动。 */
  width: number;
  height: number;
}

export interface DocSection {
  heading: string;
  html: string;
}

export interface DocPage {
  slug: string;
  title: string;
  summary: string;
  /** 卡片图标（2 个字符，显示在方块里）。 */
  icon: string;
  /** 文档分组（见 DOC_GROUPS）。 */
  group: string;
  /** 配图（0–2 张），复用官网截图。 */
  shots?: DocShot[];
  sections: DocSection[];
}

/** 文档分组。 */
export const DOC_GROUPS: ReadonlyArray<{ id: string; title: string; desc: string }> = [
  { id: 'sql', title: 'SQL 与数据', desc: '连接、编辑、结果、结构与查询洞察。' },
  { id: 'nosql', title: 'Redis 与 Elasticsearch', desc: '键值缓存与搜索集群。' },
  { id: 'ai', title: 'AI 与自动化', desc: 'AI 助手、Agent 模式、数据监控与 MCP。' },
  { id: 'security', title: '安全与合规', desc: '只读保护、审计日志、2FA 与脱敏导出。' },
  { id: 'account', title: '备份与账户', desc: '备份恢复、端到端加密同步与套餐。' },
  { id: 'reference', title: '参考', desc: '对象搜索、仪表盘、快捷键与常用设置。' },
];

const shot = (file: string, alt: string, caption: string, width: number, height: number): DocShot => ({
  src: `/screenshots/${file}`,
  alt,
  caption,
  width,
  height,
});

const WORKBENCH = (alt: string, caption: string) => shot('01-sql-workbench.png', alt, caption, 1600, 937);

export const DOCS: readonly DocPage[] = [
  /* ------------------------------- SQL 与数据 ------------------------------- */
  {
    slug: 'getting-started',
    title: '快速开始',
    summary: '安装扩展、建立第一个连接、运行第一条查询。',
    icon: 'GO',
    group: 'sql',
    shots: [WORKBENCH('DevBelt SQL 编辑器与结果表格', '装好扩展后：左侧连接树、上方 SQL 编辑器、下方结果表格。')],
    sections: [
      {
        heading: '要求',
        html: `<p>VS Code <strong>1.85.0</strong> 或更新版本。本地数据库（MySQL / PostgreSQL / SQLite）<strong>无需登录</strong>即可使用；Redis、Elasticsearch 与 AI 功能同样可以在未登录状态下本地使用。</p>`,
      },
      {
        heading: '安装',
        html: `<p>在 VS Code Marketplace 或 Open VSX 搜索 <em>DevBelt DB Client</em>，也可以直接用命令行安装：</p>
          <pre><code>code --install-extension lang2hong.devbelt-db-client</code></pre>
          <p>安装后在活动栏打开「DevBelt」视图。</p>`,
      },
      {
        heading: '建立连接',
        html: `<ol>
          <li>在「DevBelt」视图标题栏点击 <em>新增连接</em>。</li>
          <li>选择数据库类型：MySQL、PostgreSQL、SQLite、Redis 或 Elasticsearch。</li>
          <li>填写地址与凭据；需要时打开 SSH 隧道。SQL 类连接可以先点 <em>测试连接</em>。</li>
          <li>保存后连接出现在左侧树里；密码与私钥口令存入 VS Code SecretStorage。</li>
        </ol>`,
      },
      {
        heading: '运行查询',
        html: `<p>新建一个 <code>.sql</code> 文件，在编辑器右上角选择目标连接，按 <code>Ctrl+Enter</code>（macOS <code>Cmd+Enter</code>）执行当前语句。结果在下方表格展示，支持筛选、排序、分页与行内编辑。</p>
          <p>其他常用快捷键见 <a href="/db/docs/reference">快捷键与设置</a>。</p>`,
      },
    ],
  },
  {
    slug: 'connections',
    title: '连接管理',
    summary: '分组、SSH 隧道、凭据存储与各引擎的连接差异。',
    icon: 'CN',
    group: 'sql',
    shots: [WORKBENCH('DevBelt 左侧连接树', '连接树支持分组折叠；不同引擎用各自的图标区分。')],
    sections: [
      {
        heading: '分组与克隆',
        html: `<p>连接可按分组组织；右键连接可克隆、编辑、删除或移动到分组。非敏感的 host / port / database 等存于 globalState，密码、SSH 密码与私钥口令存于 SecretStorage。</p>`,
      },
      {
        heading: 'SQL 引擎',
        html: `<ul>
          <li><strong>MySQL</strong>：主机/端口/用户名/密码，支持连接串。</li>
          <li><strong>PostgreSQL</strong>：支持多 schema 写入、多库浏览（按库懒建会话），对象名按 schema 限定。</li>
          <li><strong>SQLite</strong>：直接打开本地数据库文件。</li>
        </ul>`,
      },
      {
        heading: 'Redis 与 Elasticsearch',
        html: `<ul>
          <li><strong>Redis</strong>：单机、Cluster 与 Sentinel；支持 TLS 与 SSH 隧道。</li>
          <li><strong>Elasticsearch</strong>：HTTP/HTTPS，Basic 或 API Key 认证；支持 TLS 与 SSH 隧道。</li>
        </ul>`,
      },
      {
        heading: 'SSH 隧道',
        html: `<p>首次连接未知主机时校验 SHA256 指纹（<code>tofu</code> 默认：确认后信任）；设为 <code>strict</code> 时只信任 <code>known_hosts</code> 里已有的主机。密钥变更与 <code>@revoked</code> 一律拒绝。</p>`,
      },
      {
        heading: '按账号隔离',
        html: `<p>登录后连接配置按账号隔离（<code>&lt;base&gt;::u.&lt;userId&gt;</code>）；未登录时使用 <code>local</code> 作用域。切换账号会关闭所有会话并重新加载连接树，可选一次性把本地连接复制到当前账号（只复制，不移动）。</p>`,
      },
    ],
  },
  {
    slug: 'sql',
    title: 'SQL 编辑器',
    summary: '补全、格式化、执行、取消、多结果集与内联补全。',
    icon: 'ED',
    group: 'sql',
    shots: [WORKBENCH('SQL 编辑器与多结果表格', 'SQL 编辑器、CodeLens 执行、结果表格与分页器。')],
    sections: [
      {
        heading: '编辑体验',
        html: `<p>关键字与对象补全、CodeLens 快捷执行、SQL 格式化、多语句执行；执行中可随时取消。中文输入法组合期间的 Enter 不会误触发执行。</p>
          <p>内联补全默认关闭；打开 <code>devbelt.ai.enableInlineCompletion</code> 后用 <code>Alt+/</code> 触发。</p>`,
      },
      {
        heading: '多结果集',
        html: `<p>一次执行多条语句时，结果以多个标签页展示，便于对照；DDL 执行后会刷新对象树。</p>`,
      },
      {
        heading: '结果表格',
        html: `<p>支持列排序、筛选、分页、行内编辑与图表视图（柱状 / 折线 / 面积 / 饼 / 堆叠 / 横向条形）。分页器固定在底部，长结果滚动时仍可翻页。</p>`,
      },
      {
        heading: 'EXPLAIN',
        html: `<p><code>Ctrl+Shift+E</code>（macOS <code>Cmd+Shift+E</code>）对当前语句生成执行计划。详见 <a href="/db/docs/insight">查询洞察</a>。</p>`,
      },
    ],
  },
  {
    slug: 'data',
    title: '数据操作',
    summary: '结果编辑、导入导出、库间传输与二进制处理。',
    icon: 'IO',
    group: 'sql',
    shots: [WORKBENCH('结果表格中的行内编辑', '结果表支持行内编辑，仅对可定位主键的行生效。')],
    sections: [
      {
        heading: '导入导出',
        html: `<p>支持 CSV / JSON / XML / XLSX / SQL 的导入导出；导出可自定义字段与格式，导入前可预览字段映射。二进制（BLOB / BYTEA / GEOMETRY）以 base64 安全往返。</p>`,
      },
      {
        heading: '受控编辑',
        html: `<p>结果表支持行内编辑，仅对可定位主键的行生效；生产环境保护与只读模式可阻止写入。所有写入都会进入审计记录。</p>`,
      },
      {
        heading: '库到库传输',
        html: `<p>支持把一个库或表的数据传到另一个连接，按批提交；失败时可从中断处重试。</p>`,
      },
      {
        heading: '脱敏导出',
        html: `<p>导出时可以套用脱敏规则，把手机号、邮箱等敏感列替换为一致化的假值。见 <a href="/db/docs/masking">脱敏导出</a>。</p>`,
      },
    ],
  },
  {
    slug: 'schema',
    title: '结构工具',
    summary: '表设计器、DDL、ER 图、Schema / 数据对比与数据字典。',
    icon: 'ER',
    group: 'sql',
    shots: [shot('02-er-diagram-focus.png', 'ER 图', 'ER 图按外键关系自动布局，支持拖拽调整与导出 PNG。', 1600, 800)],
    sections: [
      {
        heading: '表设计器',
        html: `<p>可视化新建/修改表、列、索引、外键、触发器、视图、例程与事件，并生成 DDL 预览后才执行。PostgreSQL 支持多 schema 写入，对象名按 schema 限定。</p>`,
      },
      {
        heading: 'ER 图',
        html: `<p>按外键关系生成 ER 图，支持按 schema 过滤、拖拽排版与导出 PNG。</p>`,
      },
      {
        heading: '对比与同步',
        html: `<p><em>Schema 对比</em> 生成差异与同步 SQL；<em>数据对比</em> 按主键比较两张表的数据差异。用于迁移前审阅，不会自动执行。</p>`,
      },
      {
        heading: '数据字典',
        html: `<p>库节点 → 数据 → <em>生成数据字典</em>，可导出 Markdown 或 HTML；内容包含表、列、类型与注释，<strong>不包含任何连接信息</strong>。</p>`,
      },
    ],
  },
  {
    slug: 'insight',
    title: '查询洞察',
    summary: '可视化 EXPLAIN、EXPLAIN ANALYZE、AI 解释、索引建议、慢查询与诊断。',
    icon: 'EX',
    group: 'sql',
    shots: [shot('08-explain-focus.png', 'SQL EXPLAIN 与 AI 解读', 'EXPLAIN 计划树、告警高亮，以及「AI 解释计划」。', 1600, 360)],
    sections: [
      {
        heading: '可视化 EXPLAIN',
        html: `<p>支持 MySQL（<code>FORMAT=JSON</code>）、PostgreSQL（<code>FORMAT JSON</code>）与 SQLite（<code>EXPLAIN QUERY PLAN</code>）：计划树、节点详情、告警高亮（大表全扫描、filesort、临时表、高风险嵌套循环、缺少索引）与原始计划复制。</p>
          <p>普通 <code>EXPLAIN</code> 只做规划，<strong>不会真正执行</strong>。</p>`,
      },
      {
        heading: 'EXPLAIN ANALYZE',
        html: `<p>计划面板的<em>执行</em>按钮会在独立的只读会话里运行 <code>EXPLAIN ANALYZE</code>，拿到真实行数与耗时（MySQL / PostgreSQL）。生产连接默认禁止，需要显式打开 <code>devbelt.explain.allowAnalyzeProduction</code>。</p>`,
      },
      {
        heading: 'AI 解释与索引建议',
        html: `<p>把精简、有上限的计划摘要发到 AI Chat 解读，不会发送完整计划或表数据。</p>
          <p>索引建议只针对计划中有告警的表：按「等值 → 范围 → 排序」组合列顺序，检查已有索引与主键/唯一键，给出置信度、理由与风险。可复制 DDL，<strong>不会自动执行</strong>。</p>`,
      },
      {
        heading: '慢查询与 SQL 诊断',
        html: `<p><em>DevBelt: 慢查询分析</em> 按 SQL 模板聚合本地查询历史，可按总/平均/最大耗时或次数排序，显示失败次数，一键打开 SQL 或 EXPLAIN。保留条数见 <code>devbelt.insights.historyLimit</code>。</p>
          <p><code>.sql</code> 编辑器内会提示缺少 <code>WHERE</code> 的 <code>UPDATE</code>/<code>DELETE</code>、<code>DROP</code>/<code>TRUNCATE</code>/<code>ALTER</code>、<code>NOT IN (子查询)</code>、<code>SELECT *</code> 与方言不符的写法。<code>devbelt.diagnostics.enabled</code> 是总开关，<code>devbelt.diagnostics.rules</code> 按规则调整级别。</p>`,
      },
    ],
  },

  /* --------------------------- Redis 与 Elasticsearch --------------------------- */
  {
    slug: 'redis',
    title: 'Redis',
    summary: '单机 / Cluster / Sentinel、键树、数据类型、Stream 与 CLI。',
    icon: 'RD',
    group: 'nosql',
    shots: [shot('03-redis.png', 'Redis 键浏览器与值编辑器', '键树按分隔符折叠，右侧直接编辑值并查看 TTL。', 1600, 763)],
    sections: [
      {
        heading: '连接',
        html: `<p>单机、Cluster 与 Sentinel，含 SSH 隧道与 TLS。Cluster 模式按 slot 路由命令；Sentinel 自动发现主从。</p>`,
      },
      {
        heading: '键浏览',
        html: `<p>键树按分隔符折叠，SCAN 分页（每次「加载更多」默认 2000 个键，可用 <code>devbelt.redis.keyPageSize</code> 调整），二进制安全键也能正确显示。支持按 pattern 批量删除（需要二次确认）。</p>`,
      },
      {
        heading: '数据类型',
        html: `<p>string、hash、list、set、zset、Stream 均可原生编辑。Stream 支持消费组、pending 明细、<code>XACK</code> 与 <code>XCLAIM</code>。</p>`,
      },
      {
        heading: '控制台与安全',
        html: `<p>CLI 控制台、命令日志、慢日志与服务器状态。只读模式与危险命令确认可防止误删；所有命令写入审计日志。</p>`,
      },
    ],
  },
  {
    slug: 'elasticsearch',
    title: 'Elasticsearch',
    summary: '集群浏览、索引与 mapping、DSL / REST 控制台与文档 CRUD。',
    icon: 'ES',
    group: 'nosql',
    shots: [shot('04-elasticsearch.png', 'Elasticsearch 文档浏览与 DSL 控制台', '左侧索引列表，右侧 DSL 查询与分页结果。', 1600, 815)],
    sections: [
      {
        heading: '连接',
        html: `<p>HTTP/HTTPS、Basic 与 API Key 认证、TLS 与 SSH 隧道。连接测试带超时保护，失败时给出明确原因而不是一直转圈。</p>`,
      },
      {
        heading: '集群与索引',
        html: `<p>集群总览、节点列表与索引浏览；可查看 mapping、settings 与 aliases。</p>`,
      },
      {
        heading: '文档与查询',
        html: `<p>文档用 <code>search_after</code> 分页浏览，支持创建、编辑、删除与批量删除。DSL 控制台的结果分页并结构化展示。</p>`,
      },
      {
        heading: 'REST 控制台',
        html: `<p>结构化错误、截断提示与在途请求取消。只读模式 fail-closed（配置缺失时按只读处理），所有写请求写入审计日志。</p>`,
      },
    ],
  },

  /* ------------------------------ AI 与自动化 ------------------------------ */
  {
    slug: 'ai',
    title: 'AI 助手',
    summary: 'AI Chat、数据问答、Agent 模式、写操作审批与 BYOK。',
    icon: 'AI',
    group: 'ai',
    shots: [shot('05-ai-chat-focus.png', 'AI Chat 与结果图表', 'AI Chat 支持流式回答、图表与用量明细。', 1342, 800)],
    sections: [
      {
        heading: 'AI Chat',
        html: `<p>流式回答，自动带上相关表结构；自然语言生成 SQL、解释与优化、错误诊断。较早的消息会压缩成摘要而不是直接截断（近 8 条逐字保留），长对话不丢上下文。</p>
          <p>每次回答显示本次消耗的 credits、耗时与触发时间。支持服务端代理或自带 API Key（<code>devbelt.ai.setApiKey</code>）。AI 偏好与自定义规则端到端加密跨设备同步。</p>`,
      },
      {
        heading: '数据问答',
        html: `<p>可以就表里的数据提问。发送样例数据<strong>默认关闭</strong>，需要显式打开 <code>devbelt.ai.agent.includeSample</code>（或对话中的示例开关），并用 <code>devbelt.ai.dataSampleRows</code> 限制每次发送的行数（默认 10）。</p>`,
      },
      {
        heading: '表设计与内联补全',
        html: `<p>可以生成或审查表结构 DDL（只给方案，执行仍需确认）。内联补全默认关闭，打开 <code>devbelt.ai.enableInlineCompletion</code> 后用 <code>Alt+/</code> 触发。</p>`,
      },
      {
        heading: 'Agent 模式',
        html: `<p>默认关闭。在 AI Chat 选好连接后打开输入框下方的「Agent」开关（监控类请求会自动打开）。助手可以逐步查看结构、执行只读 SQL 与普通 <code>EXPLAIN</code>，并受步数 / 工具次数 / 时间预算限制（默认 12 次 / 24 次 / 120 秒，可用 <code>devbelt.ai.agent.maxSteps</code>、<code>maxToolCalls</code>、<code>timeoutSeconds</code> 调整）。</p>`,
      },
      {
        heading: '写操作只能提出',
        html: `<p>DML / DDL 先给出方案；能试执行的先试执行并回滚，只有你在原生弹窗中批准后才会真正执行。<code>devbelt.ai.agent.allowWrites</code>、<code>allowDdl</code>、<code>allowProduction</code> 控制允许提出哪些，每次决策追加到本地 JSONL 执行账本。</p>`,
      },
      {
        heading: '入口',
        html: `<p>DevBelt 侧栏标题、状态栏，以及查询结果面板的 <em>✦ AI</em> 按钮（只预填当前 SQL，不会自动发送）。</p>`,
      },
    ],
  },
  {
    slug: 'monitoring',
    title: '数据监控',
    summary: '定时只读检查、条件提醒、后台任务与多窗口接管。',
    icon: 'MN',
    group: 'ai',
    shots: [
      shot('06-monitor-proposal.png', 'AI 提出监控任务', 'AI 只能以卡片形式提出任务；间隔与条件由你选择。', 1600, 914),
      shot('07-monitor-tasks-focus.png', '后台任务抽屉', '图表、检查历史、下次检查时间与失败次数。', 1220, 880),
    ],
    sections: [
      {
        heading: '三种检查类型',
        html: `<ul>
          <li><strong>行数</strong>：定时统计表的总行数。</li>
          <li><strong>单值指标</strong>：跑一条只读查询，取一个数值。</li>
          <li><strong>新增行</strong>：基于已有的整型或日期时间列追踪新增记录，按游标去重，可同时记录最新几行的主键。</li>
        </ul>`,
      },
      {
        heading: '创建任务',
        html: `<p>右键表 → 更多… → <em>监控行数…</em>；或者直接告诉 AI Chat 你想监控什么。监控类请求会自动打开 Agent 模式，但助手只能<strong>提出</strong>任务卡。</p>`,
      },
      {
        heading: '条件与间隔由你决定',
        html: `<p>卡片上有条件选择器和间隔选择器：间隔从 5 秒到 1 小时有预设，也可以填任意自定义值（最长 24 小时）。助手建议的条件只是建议，采纳后才生效；<strong>不点确认就不会创建任何任务</strong>。</p>`,
      },
      {
        heading: '后台任务',
        html: `<p>从 AI Chat 的更多菜单、状态栏或命令打开，按最新优先排序：图表、检查记录、最新新增行、下次检查时间、失败次数，以及暂停 / 恢复 / 立即检查 / 删除、编辑间隔与条件、<em>Ask AI to explain</em>。</p>
          <p>相关设置：<code>devbelt.ai.monitor.enabled</code>（总开关）、<code>maxTasks</code>（默认 20）、<code>notifyCooldownMinutes</code>（默认 15）、<code>queryTimeoutSeconds</code>（默认 30）、<code>allowProduction</code>（默认关闭）。</p>`,
      },
      {
        heading: '多窗口与账号切换',
        html: `<p>多个 VS Code 窗口同时打开时，监控由单实例持有（文件锁 + 15 秒心跳）。可以在另一个窗口显式接管，交接时上一窗口的任务会自动暂停，避免重复检查。</p>
          <p>切换账号会暂停所有监控任务，防止把上一个账号的查询跑到新账号的连接上。</p>`,
      },
    ],
  },
  {
    slug: 'mcp',
    title: 'MCP Server',
    summary: '把 DevBelt 的只读查询能力暴露给外部 MCP 客户端。',
    icon: 'MC',
    group: 'ai',
    sections: [
      {
        heading: '是什么',
        html: `<p>DevBelt 内置一个 MCP（Model Context Protocol）Server，基于 Streamable HTTP。打开后，Claude Desktop、IDE 助手等支持 MCP 的客户端可以调用当前连接上的只读工具（查看结构、执行只读查询），用来做数据问答或生成 SQL。</p>`,
      },
      {
        heading: '启用',
        html: `<ol>
          <li>先选好要暴露的连接（<code>devbelt.mcp.connectionId</code>）。</li>
          <li>打开 <code>devbelt.mcp.enabled</code>，或执行命令 <em>DevBelt: Enable MCP Server</em>。</li>
          <li>执行 <em>Copy MCP Client Config</em>，把生成的配置贴到客户端的 MCP 配置里。</li>
        </ol>`,
      },
      {
        heading: '限制与审计',
        html: `<ul>
          <li>只暴露只读操作；不会执行写入。</li>
          <li>默认每分钟 60 次请求（<code>devbelt.mcp.rateLimitPerMinute</code>），单次最多返回 200 行（<code>devbelt.mcp.maxRows</code>）。</li>
          <li>样例数据默认不发送（<code>devbelt.mcp.includeSample</code>）。</li>
          <li>所有调用写入 MCP 审计日志；可以随时 <em>Revoke MCP Client</em> 撤销已授权的客户端。</li>
        </ul>`,
      },
      {
        heading: '关闭',
        html: `<p>执行 <em>DevBelt: Disable MCP Server</em> 或把 <code>devbelt.mcp.enabled</code> 设为 <code>false</code>。禁用后客户端连接立即失效。</p>`,
      },
    ],
  },

  /* ------------------------------- 安全与合规 ------------------------------- */
  {
    slug: 'security',
    title: '安全与审计',
    summary: '只读模式、生产保护、审计日志、SSH 指纹与 2FA。',
    icon: 'SE',
    group: 'security',
    sections: [
      {
        heading: '只读与生产保护',
        html: `<p>连接可以标记为生产环境。生产连接默认禁止写入与 DDL；只读模式会同时拦住结果编辑、导入与传输。Agent 对生产库的写操作需要单独打开 <code>devbelt.ai.agent.allowProduction</code>，且仍然只能"提出"。</p>`,
      },
      {
        heading: '审计日志',
        html: `<p>所有写入（SQL、结果编辑、Redis 写命令、Elasticsearch 写请求、MCP 调用、Agent 决策）都会记录到本地审计日志，包含时间、连接、语句或命令与结果。审计记录随账号隔离存储。</p>`,
      },
      {
        heading: 'SSH 主机密钥',
        html: `<ul>
          <li><code>tofu</code>（默认）：首次连接时确认 SHA256 指纹并信任。</li>
          <li><code>strict</code>：只信任 <code>known_hosts</code> 里已有的主机。</li>
          <li>密钥变更与 <code>@revoked</code> 一律 fail-closed，不提供"忽略一次"。</li>
        </ul>`,
      },
      {
        heading: '凭据存储',
        html: `<p>数据库密码、SSH 密码与私钥口令存放在 VS Code SecretStorage（由操作系统钥匙串保护），不写入 settings.json，也不进入同步载荷。登录后凭据按账号作用域隔离。</p>`,
      },
      {
        heading: '两步验证（2FA / TOTP）',
        html: `<p>内置 Authenticator 管理 TOTP 账户（命令 <code>devbelt.authenticator</code>），条目与密钥按账号隔离，密钥保存在操作系统钥匙串；支持导出备份。开启 2FA 后登录需要验证码。</p>`,
      },
    ],
  },
  {
    slug: 'masking',
    title: '脱敏导出',
    summary: '按列规则导出脱敏数据，保留可用的关联关系。',
    icon: 'MK',
    group: 'security',
    sections: [
      {
        heading: '使用',
        html: `<p>在表或结果上执行 <em>DevBelt: Export Masked</em>，选择规则后导出。输出格式与普通导出相同（CSV / JSON / SQL 等），但敏感列已被替换。</p>`,
      },
      {
        heading: '规则配置',
        html: `<p>默认从工作区根目录的 <code>.devbelt-mask.json</code> 读取规则（<code>devbelt.masking.configPath</code> 可改）。未配置时按内置 PII 规则识别手机号、邮箱、身份证等列。</p>
          <pre><code>{
  "columns": {
    "users.phone": { "type": "phone" },
    "users.email": { "type": "email" },
    "orders.address": { "type": "text", "keepPrefix": 3 }
  },
  "allowUnmasked": ["public.settings.value"]
}</code></pre>`,
      },
      {
        heading: '一致性',
        html: `<p>同一个值在同一份导出里会映射成同一个假值（按 salt 计算），因此外键关联、去重与分组仍然成立；不同导出之间不复用映射。可以用 <code>allowUnmasked</code> 显式放行不需要脱敏的列。</p>`,
      },
      {
        heading: '不会做的事',
        html: `<p>脱敏只影响导出的文件，不修改数据库；也不会把原始值写进日志或审计记录。</p>`,
      },
    ],
  },

  /* ------------------------------- 备份与账户 ------------------------------- */
  {
    slug: 'backup',
    title: '备份与恢复',
    summary: '手动备份、定时备份、恢复与模拟数据生成。',
    icon: 'BK',
    group: 'account',
    sections: [
      {
        heading: '手动备份',
        html: `<p>在库或表节点上执行<em>备份</em>，选择输出目录与格式。备份文件按「连接 / 库 / 时间戳」命名，写入完成后才出现在目录里（先写临时文件再原子重命名）。</p>`,
      },
      {
        heading: '定时备份',
        html: `<p>对某个库配置备份计划：选择周期（小时级）与输出目录。已存在计划时可以<em>立即运行</em>、<em>修改计划</em>或<em>删除计划</em>。计划随账号隔离保存，切换账号会暂停后台任务。</p>`,
      },
      {
        heading: '恢复',
        html: `<p>从备份文件恢复到指定库。恢复前会校验文件头与目标库，避免把备份导进错误的连接。</p>`,
      },
      {
        heading: '模拟数据',
        html: `<p><em>生成模拟数据</em> 按列类型与约束生成测试行，不会破坏已有的主键/唯一键；可指定行数，执行前预览生成的 SQL。</p>`,
      },
    ],
  },
  {
    slug: 'sync',
    title: '个人同步',
    summary: '端到端加密同步连接、查询、认证器与 AI 配置。',
    icon: 'SY',
    group: 'account',
    sections: [
      {
        heading: '原理',
        html: `<p>同步对象在客户端以 DEK（数据加密密钥）做 AES-256-GCM 端到端加密，服务端只保存密文，无法读取明文。登录只认证身份，同步需要显式输入同步口令解锁。</p>`,
      },
      {
        heading: '同步范围',
        html: `<p>默认同步连接、保存的查询、笔记、认证器（2FA）与 AI 模型访问配置，可在 <code>devbelt.sync.items</code> 里逐项关闭。连接密码等凭据不进入同步载荷。</p>`,
      },
      {
        heading: '使用',
        html: `<ol>
          <li>登录后执行 <em>Initialize Personal Sync</em> 初始化，或 <em>Unlock Personal Sync</em> 解锁。</li>
          <li>自动同步默认关闭（<code>devbelt.sync.autoSync</code>）；开启后本地变更自动同步，关闭时用「立即同步 / 拉取 / 推送」。</li>
          <li>跨设备冲突会持久化，在解决面板里选择保留本地或远端。</li>
        </ol>`,
      },
      {
        heading: '口令与恢复',
        html: `<p>可以修改同步口令（<em>Change Sync Password</em>）、销毁云端同步数据（<em>Destroy Sync</em>）或用恢复码在新设备上恢复（<em>Recover Sync</em>）。同步口令丢失后无法解密云端数据，请妥善保存恢复码。</p>`,
      },
    ],
  },
  {
    slug: 'account',
    title: '账户与套餐',
    summary: '注册登录、设备管理、账号数据隔离与套餐权益。',
    icon: 'AC',
    group: 'account',
    sections: [
      {
        heading: '账户',
        html: `<p>支持邮箱注册、邮箱验证与登录，令牌自动轮换；可在控制台查看并远程撤销已登录设备。支持 2FA/TOTP。</p>`,
      },
      {
        heading: '账号数据隔离',
        html: `<p>登录后，连接、AI Key、对话历史、AI 上下文与自定义规则、验证器（2FA）条目、审计日志与备份全部按账号隔离存储（<code>&lt;base&gt;::u.&lt;userId&gt;</code>）；退出登录回到 <code>local</code> 作用域。</p>
          <p>切换账号时会关闭所有会话与面板、重新加载连接树、暂停后台任务，并提供一次性把本地数据复制到当前账号的选项（只复制，不移动）。</p>`,
      },
      {
        heading: '套餐',
        html: `<p>个人套餐与配额见 <a href="/plans">套餐页</a>。个人连接同步等能力依权益而定，配额以服务端校验为准。</p>`,
      },
    ],
  },

  /* --------------------------------- 参考 --------------------------------- */
  {
    slug: 'search',
    title: '对象搜索与仪表盘',
    summary: '跨库对象搜索、服务器状态、查询历史与审计查询。',
    icon: 'SR',
    group: 'reference',
    sections: [
      {
        heading: '对象搜索',
        html: `<p><code>Ctrl+Alt+F</code>（macOS <code>Cmd+Alt+F</code>）在选中的连接里搜索表、视图、例程等对象，按名称与类型过滤。</p>
          <p><code>Ctrl+Alt+C</code>（macOS <code>Cmd+Alt+C</code>）在所有连接里按名称搜索连接本身。</p>`,
      },
      {
        heading: '服务器仪表盘',
        html: `<p><em>DevBelt: Dashboard</em> 显示当前连接的版本、连接数、运行时间、缓存命中率等关键指标；MySQL 与 PostgreSQL 支持度最高。</p>`,
      },
      {
        heading: '查询历史与保存的查询',
        html: `<p>查询历史记录每次执行的语句、耗时与结果行数，可按模板聚合（见<a href="/db/docs/insight">慢查询分析</a>）。保存的查询可以放进文件夹，随连接同步。</p>`,
      },
      {
        heading: '审计查询',
        html: `<p>审计日志按时间倒序展示写入记录；可以按连接、库或语句片段过滤，用于排查"谁改了什么"。</p>`,
      },
    ],
  },
  {
    slug: 'reference',
    title: '快捷键与设置',
    summary: '常用快捷键、关键设置项与系统要求。',
    icon: 'RF',
    group: 'reference',
    sections: [
      {
        heading: '快捷键',
        html: `<table>
          <thead><tr><th>操作</th><th>Windows / Linux</th><th>macOS</th></tr></thead>
          <tbody>
            <tr><td>执行查询或当前语句</td><td><code>Ctrl+Enter</code></td><td><code>Cmd+Enter</code></td></tr>
            <tr><td>在新面板执行</td><td><code>Ctrl+Alt+Enter</code></td><td><code>Cmd+Ctrl+Enter</code></td></tr>
            <tr><td>EXPLAIN</td><td><code>Ctrl+Shift+E</code></td><td><code>Cmd+Shift+E</code></td></tr>
            <tr><td>搜索数据库对象</td><td><code>Ctrl+Alt+F</code></td><td><code>Cmd+Alt+F</code></td></tr>
            <tr><td>搜索连接</td><td><code>Ctrl+Alt+C</code></td><td><code>Cmd+Alt+C</code></td></tr>
            <tr><td>内联补全</td><td><code>Alt+/</code></td><td><code>Option+/</code></td></tr>
          </tbody>
        </table>`,
      },
      {
        heading: '常用设置',
        html: `<table>
          <thead><tr><th>设置</th><th>默认</th><th>说明</th></tr></thead>
          <tbody>
            <tr><td><code>devbelt.sync.autoSync</code></td><td>false</td><td>自动同步开关</td></tr>
            <tr><td><code>devbelt.sync.items</code></td><td>全部开启</td><td>选择同步哪些内容</td></tr>
            <tr><td><code>devbelt.redis.keyPageSize</code></td><td>2000</td><td>键树每次加载的键数量</td></tr>
            <tr><td><code>devbelt.explain.allowAnalyzeProduction</code></td><td>false</td><td>允许在生产连接上跑 EXPLAIN ANALYZE</td></tr>
            <tr><td><code>devbelt.ai.agent.enabled</code></td><td>false</td><td>默认打开 Agent 模式</td></tr>
            <tr><td><code>devbelt.ai.agent.allowWrites</code> / <code>allowDdl</code> / <code>allowProduction</code></td><td>false</td><td>Agent 可以提出哪些写操作</td></tr>
            <tr><td><code>devbelt.ai.agent.maxSteps</code> / <code>maxToolCalls</code> / <code>timeoutSeconds</code></td><td>12 / 24 / 120</td><td>Agent 预算</td></tr>
            <tr><td><code>devbelt.ai.dataSampleRows</code></td><td>10</td><td>发送给 AI 的样例行数</td></tr>
            <tr><td><code>devbelt.ai.enableInlineCompletion</code></td><td>false</td><td>内联补全</td></tr>
            <tr><td><code>devbelt.ai.monitor.maxTasks</code></td><td>20</td><td>监控任务上限</td></tr>
            <tr><td><code>devbelt.mcp.enabled</code></td><td>false</td><td>MCP Server 开关</td></tr>
            <tr><td><code>devbelt.mcp.maxRows</code> / <code>rateLimitPerMinute</code></td><td>200 / 60</td><td>MCP 返回行数与限流</td></tr>
            <tr><td><code>devbelt.masking.configPath</code></td><td>.devbelt-mask.json</td><td>脱敏规则文件</td></tr>
          </tbody>
        </table>`,
      },
      {
        heading: '系统要求',
        html: `<ul>
          <li>VS Code <strong>1.85.0</strong> 或更新版本。</li>
          <li>MySQL 5.7+ / 8.x，PostgreSQL 12+，SQLite 3.x。</li>
          <li>Redis 6+（Cluster / Sentinel 需对应拓扑），Elasticsearch 7.x / 8.x。</li>
          <li>SSH 隧道需要本机可用的 <code>ssh</code> 客户端。</li>
        </ul>`,
      },
    ],
  },
];

const DOCS_CSS = `
      /* ---------- 文档索引：全宽分组卡片 ---------- */
      main.docs { padding: 40px 0 8px; }
      main.docs > .wrap > h1 { font-size: clamp(1.7rem, 3.2vw, 2.1rem); margin: 0 0 8px; letter-spacing: -0.02em; }
      main.docs .lead { color: var(--muted); margin: 0 0 40px; max-width: 760px; }
      .group { margin-bottom: 40px; }
      .group h2 { font-size: 1.15rem; margin: 0 0 4px; display: flex; align-items: center; gap: 10px; }
      .group h2::before { content: ""; width: 8px; height: 8px; border-radius: 2px;
        background: var(--accent); transform: rotate(45deg); }
      .group .gdesc { color: var(--dim); font-size: .9rem; margin: 0 0 16px; padding-left: 18px; }
      .cards { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
      .card { display: block; padding: 20px; border: 1px solid var(--line); border-radius: 14px;
        background: linear-gradient(180deg, var(--panel), var(--panel2)); color: inherit;
        transition: border-color .15s ease, transform .05s ease; }
      .card:hover { border-color: var(--accent); text-decoration: none; transform: translateY(-1px); }
      .card h3 { margin: 0 0 8px; font-size: 1rem; display: flex; align-items: center; gap: 8px; }
      .card .icon { width: 28px; height: 28px; border-radius: 8px; background: rgba(61,107,255,.14);
        color: var(--accent2); display: inline-flex; align-items: center; justify-content: center;
        font-size: .72rem; font-weight: 700; flex-shrink: 0; }
      .card p { margin: 0; color: var(--muted); font-size: .9rem; }

      /* ---------- 单篇：左侧目录 + 正文 ---------- */
      main.article { padding: 36px 0 8px; }
      .layout { display: grid; grid-template-columns: 220px 1fr; gap: 40px; }
      .toc { position: sticky; top: 76px; align-self: start;
        max-height: calc(100vh - 110px); overflow-y: auto; padding-right: 6px;
        scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
      .toc::-webkit-scrollbar { width: 6px; }
      .toc::-webkit-scrollbar-thumb { background: var(--line); border-radius: 3px; }
      .toc > a { display: block; color: var(--muted); padding: 6px 0; font-size: .93rem; }
      .toc > a:hover { color: var(--fg); text-decoration: none; }
      .toc-group { margin-top: 16px; }
      .toc-group h4 { margin: 0 0 6px; font-size: .7rem; letter-spacing: .08em; text-transform: uppercase;
        color: var(--dim); font-weight: 600; }
      .toc-group a { display: block; color: var(--muted); padding: 5px 0 5px 10px; font-size: .9rem;
        border-left: 1px solid var(--line); }
      .toc-group a:hover { color: var(--fg); border-left-color: var(--accent2); text-decoration: none; }
      .toc-group a.on { color: var(--fg); border-left-color: var(--accent); }

      article h1 { font-size: clamp(1.6rem, 3vw, 2rem); margin: 0 0 8px; letter-spacing: -0.02em; }
      article .summary { color: var(--muted); margin: 0 0 24px; font-size: 1.02rem; }
      article h2 { font-size: 1.15rem; margin: 34px 0 10px; letter-spacing: -0.01em;
        display: flex; align-items: center; gap: 10px; }
      article h2::before { content: ""; width: 8px; height: 8px; border-radius: 2px;
        background: var(--accent); transform: rotate(45deg); flex-shrink: 0; }
      article p, article li { color: #c8cfdf; }
      article ul, article ol { padding-left: 22px; }
      article li { padding: 2px 0; }
      article strong { color: var(--fg); font-weight: 600; }
      article em { color: var(--fg); font-style: normal; background: rgba(61,107,255,.14);
        padding: 1px 5px; border-radius: 4px; }
      article code { font-family: var(--font-mono); background: var(--panel); border: 1px solid var(--line);
        border-radius: 5px; padding: 1px 6px; font-size: .88em; color: #d6dcf0; }
      article pre { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
        padding: 14px 16px; overflow-x: auto; }
      article pre code { background: none; border: 0; padding: 0; font-size: .88rem; }
      article table { width: 100%; border-collapse: collapse; margin: 8px 0 4px; font-size: .92rem; }
      article th, article td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
      article th { color: var(--dim); font-weight: 600; font-size: .82rem; text-transform: uppercase; letter-spacing: .04em; }
      article td { color: #c8cfdf; }

      figure.shot { margin: 6px 0 26px; }
      figure.shot img { display: block; width: 100%; height: auto; border: 1px solid var(--line);
        border-radius: 14px; background: var(--panel); box-shadow: 0 12px 40px -18px rgba(0,0,0,.6); }
      figure.shot figcaption { color: var(--dim); font-size: .84rem; text-align: center; margin-top: 10px; }

      @media (max-width: 860px) {
        .layout { grid-template-columns: 1fr; gap: 24px; }
        .toc { position: static; border-bottom: 1px solid var(--line); padding-bottom: 14px; }
        .toc-group { display: inline-block; margin: 10px 18px 0 0; vertical-align: top; }
      }
      @media (max-width: 600px) {
        main.docs { padding: 28px 0 8px; }
        main.article { padding: 24px 0 8px; }
      }
`;

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface DocsRenderOptions {
  /** 请求是否已登录（由服务端按 refresh cookie 判定）。 */
  loggedIn?: boolean;
}

function toc(currentSlug?: string): string {
  const groups = DOC_GROUPS.map((g) => {
    const links = DOCS.filter((d) => d.group === g.id)
      .map(
        (d) =>
          `<a href="/db/docs/${d.slug}"${d.slug === currentSlug ? ' class="on"' : ''}>${escapeHtml(d.title)}</a>`,
      )
      .join('\n            ');
    return `<div class="toc-group">
            <h4>${escapeHtml(g.title)}</h4>
            ${links}
          </div>`;
  }).join('\n          ');
  return `<nav class="toc">
          <a href="/db/docs"${currentSlug === undefined ? ' class="on"' : ''}>文档首页</a>
          ${groups}
        </nav>`;
}

function figureMarkup(s: DocShot): string {
  return `<figure class="shot">
            <img src="${s.src}" alt="${escapeHtml(s.alt)}" loading="lazy" width="${s.width}" height="${s.height}" />
            <figcaption>${escapeHtml(s.caption)}</figcaption>
          </figure>`;
}

/** 文档首页：全宽分组卡片（不显示左侧目录）。 */
export function renderDocsIndex(opts: DocsRenderOptions = {}): string {
  const groups = DOC_GROUPS.map((g) => {
    const cards = DOCS.filter((d) => d.group === g.id)
      .map(
        (d) => `<a class="card" href="/db/docs/${d.slug}">
                <h3><span class="icon">${escapeHtml(d.icon)}</span>${escapeHtml(d.title)}</h3>
                <p>${escapeHtml(d.summary)}</p>
              </a>`,
      )
      .join('\n              ');
    return `<section class="group">
            <h2>${escapeHtml(g.title)}</h2>
            <p class="gdesc">${escapeHtml(g.desc)}</p>
            <div class="cards">
              ${cards}
            </div>
          </section>`;
  }).join('\n          ');

  const body = `<main class="docs">
      <div class="wrap">
        <h1>使用文档</h1>
        <p class="lead">DevBelt 的产品使用指南，对应 v0.4.0。开发者文档见仓库 <code>docs/</code>，发版记录见 <a href="https://github.com/lang2hong/devbelt/blob/main/CHANGELOG.md" target="_blank" rel="noopener noreferrer">CHANGELOG</a>。</p>
        ${groups}
      </div>
    </main>`;
  return renderPublicPage({
    title: '使用文档 · DevBelt 文档',
    description: 'DevBelt 产品使用文档：连接、SQL、结构与数据、Redis、Elasticsearch、AI 助手、数据监控、MCP、安全审计、脱敏导出、备份与同步。',
    body,
    css: DOCS_CSS,
    chrome: { loggedIn: opts.loggedIn, active: 'docs' },
  });
}

/** 单篇文档；未知 slug 返回 null（由路由决定 404）。 */
export function renderDocPage(slug: string, opts: DocsRenderOptions = {}): string | null {
  const doc = DOCS.find((d) => d.slug === slug);
  if (!doc) return null;
  const shots = (doc.shots ?? []).map(figureMarkup).join('\n          ');
  const sections = doc.sections
    .map((s) => `<h2>${escapeHtml(s.heading)}</h2>\n          ${s.html}`)
    .join('\n          ');
  const body = `<main class="article">
      <div class="wrap">
        <div class="layout">
          ${toc(doc.slug)}
          <article>
            <h1>${escapeHtml(doc.title)}</h1>
            <p class="summary">${escapeHtml(doc.summary)}</p>
            ${shots}
            ${sections}
          </article>
        </div>
      </div>
    </main>`;
  return renderPublicPage({
    title: `${doc.title} · DevBelt 文档`,
    description: doc.summary,
    body,
    css: DOCS_CSS,
    chrome: { loggedIn: opts.loggedIn, active: 'docs' },
  });
}