/**
 * 公开文档中心（`/db/docs`）：服务端渲染、零构建依赖、**无需登录**。
 *
 * 与官网（apps/site）同一套设计语言：相同的导航、页脚、配色与卡片样式；
 * 插图使用与首页相同的真实截图（`/screenshots/*.png`），不再内联手绘 SVG。
 * 正文为受信任的静态 HTML，不由用户输入拼装。
 */

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
  /** 卡片图标（2–3 个字符，显示在方块里）。 */
  icon: string;
  /** 文档分组（见 DOC_GROUPS）。 */
  group: string;
  /** 配图（0–2 张），复用官网截图。 */
  shots?: DocShot[];
  sections: DocSection[];
}

/** 文档分组：与官网首页的功能分区一一对应。 */
export const DOC_GROUPS: ReadonlyArray<{ id: string; title: string; desc: string }> = [
  { id: 'sql', title: 'SQL 与数据', desc: '连接、编辑、结果、结构与查询洞察。' },
  { id: 'nosql', title: 'Redis 与 Elasticsearch', desc: '键值缓存与搜索集群。' },
  { id: 'ai', title: 'AI 与监控', desc: 'AI 助手、Agent 模式与定时数据监控。' },
  { id: 'account', title: '账户与同步', desc: '端到端加密同步、账号隔离与套餐。' },
];

const shot = (
  file: string,
  alt: string,
  caption: string,
  width: number,
  height: number,
): DocShot => ({ src: `/screenshots/${file}`, alt, caption, width, height });

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
        heading: '安装',
        html: `<p>DevBelt 通过 VS Code 扩展发布：在 VS Code Marketplace 或 Open VSX 搜索 <em>DevBelt DB Client</em>，也可以直接用命令行安装：</p>
          <pre><code>code --install-extension lang2hong.devbelt-db-client</code></pre>
          <p>安装后在活动栏打开「DevBelt」视图即可开始；本地连接（MySQL / PostgreSQL / SQLite）<strong>无需登录</strong>。</p>`,
      },
      {
        heading: '建立连接',
        html: `<ol>
          <li>在「DevBelt」视图标题栏点击 <em>新增连接</em>。</li>
          <li>选择数据库类型并填写主机、端口、用户名、密码（可选 SSH 隧道）。</li>
          <li>点击 <em>测试连接</em> 确认后保存；密码等敏感字段存入 VS Code SecretStorage。</li>
        </ol>`,
      },
      {
        heading: '运行查询',
        html: `<p>新建一个 <code>.sql</code> 文件，编辑器右上角选择目标连接后执行；结果在下方表格展示，支持筛选、排序与受控行内编辑。查询历史、审计日志与慢查询分析会记录在本地。</p>`,
      },
    ],
  },
  {
    slug: 'connections',
    title: '连接管理',
    summary: '连接、分组、SSH 隧道与凭据存储。',
    icon: 'CN',
    group: 'sql',
    shots: [WORKBENCH('DevBelt 左侧连接树', '连接树支持分组折叠；不同引擎的连接用各自的图标区分。')],
    sections: [
      {
        heading: '分组与克隆',
        html: `<p>连接可按分组组织；右键连接可克隆、编辑、删除或移动到分组。非敏感的 host / port / database 等存于 globalState，密码、SSH 密码与私钥口令存于 SecretStorage。</p>`,
      },
      {
        heading: 'SSH 隧道',
        html: `<p>支持通过 SSH 跳板访问数据库。首次连接未知主机时会校验 SHA256 指纹（<code>tofu</code> 默认），也可设为 <code>strict</code> 只信任已有 known_hosts；密钥变更或 revoked 一律拒绝。Redis / Elasticsearch 连接同样支持 SSH 隧道。</p>`,
      },
      {
        heading: '按账号隔离',
        html: `<p>登录后连接配置按账号隔离（<code>&lt;base&gt;::u.&lt;userId&gt;</code>）；未登录时使用 <code>local</code> 作用域。切换账号会关闭所有会话并重新加载连接树，可一次性把本地连接复制到当前账号。</p>`,
      },
    ],
  },
  {
    slug: 'sql',
    title: 'SQL 编辑器',
    summary: '补全、格式化、执行、取消与 EXPLAIN。',
    icon: 'SQL',
    group: 'sql',
    shots: [WORKBENCH('SQL 编辑器与多结果表格', 'SQL 编辑器、CodeLens 执行、结果表格与分页器。')],
    sections: [
      {
        heading: '编辑体验',
        html: `<p>提供关键字/对象补全、CodeLens 快捷执行、SQL 格式化与多语句执行；执行中可取消，也可对查询生成 EXPLAIN 计划。中文输入法组合期间的 Enter 不会误触发执行或发送。</p>`,
      },
      {
        heading: '多结果集',
        html: `<p>一次执行多条语句时，结果以多个标签页展示，便于对照；DDL 执行后会刷新对象树。结果表格支持列排序、筛选、分页与图表视图（柱状 / 折线 / 面积 / 饼 / 堆叠 / 横向条形）。</p>`,
      },
    ],
  },
  {
    slug: 'data',
    title: '数据操作',
    summary: '结果编辑、数据导入导出与库间传输。',
    icon: 'IO',
    group: 'sql',
    shots: [WORKBENCH('结果表格中的行内编辑', '结果表支持行内编辑，仅对可定位主键的行生效。')],
    sections: [
      {
        heading: '导入导出',
        html: `<p>支持 CSV / JSON / XML / XLSX / SQL 的导入导出；导出可自定义字段与格式，导入前可预览映射。二进制（BLOB / BYTEA / GEOMETRY）以 base64 安全往返。</p>`,
      },
      {
        heading: '受控编辑',
        html: `<p>结果表支持行内编辑，仅对可定位主键的行生效；生产环境保护与只读模式可阻止写入。数据库到数据库的传输按批提交，失败时可从中断处重试。</p>`,
      },
    ],
  },
  {
    slug: 'schema',
    title: '结构工具',
    summary: '表设计器、DDL、ER 图、Schema 对比与数据字典。',
    icon: 'ER',
    group: 'sql',
    shots: [shot('02-er-diagram-focus.png', 'ER 图', 'ER 图按外键关系自动布局，支持拖拽调整与导出 PNG。', 1600, 800)],
    sections: [
      {
        heading: '表设计器',
        html: `<p>可视化新建/修改表、列、索引、外键、触发器、视图、例程与事件，并生成对应 DDL 预览。PostgreSQL 支持多 schema 写入，对象名按 schema 限定。</p>`,
      },
      {
        heading: 'ER 图与对比',
        html: `<p>按外键关系生成 ER 图；可对比两个 Schema 并生成同步 SQL，用于迁移与审阅。PostgreSQL 支持多库浏览，按库懒建会话。</p>`,
      },
      {
        heading: '数据字典',
        html: `<p>库节点 → 数据 → <em>生成数据字典</em>，可选 Markdown 或 HTML 导出；内容包含表、列、类型与注释，<strong>不包含任何连接信息</strong>。</p>`,
      },
    ],
  },
  {
    slug: 'insight',
    title: '查询洞察',
    summary: '可视化 EXPLAIN、AI 解释计划、索引建议、慢查询与 SQL 诊断。',
    icon: 'EX',
    group: 'sql',
    shots: [shot('08-explain-focus.png', 'SQL EXPLAIN 与 AI 解读', 'EXPLAIN 计划树、告警高亮，以及「AI 解释计划」。', 1600, 360)],
    sections: [
      {
        heading: '可视化 EXPLAIN',
        html: `<p>支持 MySQL（<code>FORMAT=JSON</code>）、PostgreSQL（<code>FORMAT JSON</code>）与 SQLite（<code>EXPLAIN QUERY PLAN</code>）：计划树、节点详情、告警高亮（大表全扫描、filesort、临时表、高风险嵌套循环、缺少索引）与原始计划复制。</p>
          <p>只执行普通 <code>EXPLAIN</code>：语句只做规划，<strong>不会真正执行</strong>。</p>`,
      },
      {
        heading: 'AI 解释计划',
        html: `<p>把精简、有上限的计划摘要发到 AI Chat 解读；不会把完整计划或表数据发出去。结果面板的 <em>✦ AI</em> 按钮只预填当前 SQL，不会自动发送。</p>`,
      },
      {
        heading: '索引建议',
        html: `<p>只针对计划中有告警的表：按「等值 → 范围 → 排序」组合列顺序，检查已有索引与主键/唯一键，给出置信度、理由与风险。可复制 DDL，<strong>不会自动执行</strong>。</p>`,
      },
      {
        heading: '慢查询与诊断',
        html: `<p><em>DevBelt: 慢查询分析</em> 按 SQL 模板聚合本地查询历史，可按总/平均/最大耗时或次数排序，显示失败次数，一键打开 SQL 或 EXPLAIN（保留条数见 <code>devbelt.insights.historyLimit</code>）。</p>
          <p><code>.sql</code> 编辑器内会提示缺少 <code>WHERE</code> 的 <code>UPDATE</code>/<code>DELETE</code>、<code>DROP</code>/<code>TRUNCATE</code>/<code>ALTER</code>、<code>NOT IN (子查询)</code>、<code>SELECT *</code> 与方言不符的写法；<code>devbelt.diagnostics.enabled</code> 是总开关，<code>devbelt.diagnostics.rules</code> 按规则调整级别。</p>`,
      },
    ],
  },

  /* --------------------------- Redis 与 Elasticsearch --------------------------- */
  {
    slug: 'redis',
    title: 'Redis',
    summary: '单机 / Cluster / Sentinel、键树、五种数据类型与 Stream 消费组。',
    icon: 'R',
    group: 'nosql',
    shots: [shot('03-redis.png', 'Redis 键浏览器与值编辑器', '键树按分隔符折叠，右侧直接编辑值并查看 TTL。', 1600, 763)],
    sections: [
      {
        heading: '连接',
        html: `<p>支持单机、Cluster 与 Sentinel，含 SSH 隧道与 TLS。Cluster 模式下按 slot 路由命令；Sentinel 会自动发现主从。</p>`,
      },
      {
        heading: '键浏览',
        html: `<p>键浏览器按分隔符折叠成树，SCAN 分页（每次「加载更多」默认 2000 个键，可用 <code>devbelt.redis.keyPageSize</code> 调整），二进制安全键也能正确显示。</p>`,
      },
      {
        heading: '数据类型',
        html: `<p>全部核心类型原生编辑：string、hash、list、set、zset、Stream。Stream 支持消费组、pending 明细、<code>XACK</code> 与 <code>XCLAIM</code>。</p>`,
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
        html: `<p>支持 HTTP/HTTPS、Basic 与 API Key 认证、TLS 与 SSH 隧道。连接测试带超时保护，不会一直转圈。</p>`,
      },
      {
        heading: '集群与索引',
        html: `<p>集群总览、节点列表与索引浏览；可查看 mapping、settings 与 aliases。</p>`,
      },
      {
        heading: '文档与查询',
        html: `<p>文档用 <code>search_after</code> 分页浏览，支持创建、编辑、删除与批量删除。DSL 控制台的结果分页并结构化展示；REST 控制台提供结构化错误、截断提示与在途请求取消。</p>`,
      },
      {
        heading: '安全',
        html: `<p>只读模式 fail-closed（配置缺失时按只读处理），所有写请求写入审计日志。</p>`,
      },
    ],
  },

  /* ------------------------------ AI 与监控 ------------------------------ */
  {
    slug: 'ai',
    title: 'AI 助手',
    summary: 'AI Chat、Schema 上下文、Agent 模式与写操作审批。',
    icon: 'AI',
    group: 'ai',
    shots: [shot('05-ai-chat-focus.png', 'AI Chat 与结果图表', 'AI Chat 支持流式回答、图表与用量明细。', 1342, 800)],
    sections: [
      {
        heading: 'AI Chat',
        html: `<p>流式回答，自动带上相关表结构；自然语言生成 SQL、解释与优化、错误诊断。较早的消息会压缩成摘要而不是直接截断，长对话不会丢上下文。</p>
          <p>支持服务端代理或自带 API Key（BYOK）。AI 偏好与自定义规则端到端加密跨设备同步。</p>`,
      },
      {
        heading: 'Agent 模式',
        html: `<p>默认关闭。在 AI Chat 选好连接后打开输入框下方的「Agent」开关（监控类请求会自动打开）。助手可以逐步查看结构、执行只读 SQL 与普通 <code>EXPLAIN</code>，并受步数 / 工具次数 / 时间预算限制（默认 12 次 / 24 次 / 120 秒，可用 <code>devbelt.ai.agent.*</code> 调整）。</p>`,
      },
      {
        heading: '写操作只能提出',
        html: `<p>DML / DDL 先给出方案；能试执行的先试执行并回滚，只有你在原生弹窗中批准后才会真正执行。<code>devbelt.ai.agent.allowWrites</code>、<code>allowDdl</code>、<code>allowProduction</code> 控制允许提出哪些，每次决策写入本地 JSONL 执行账本。</p>`,
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
        html: `<p>卡片上有条件选择器和间隔选择器：间隔从 5 秒到 1 小时有预设，也可以填任意自定义值（最长 24 小时）。助手建议的条件只是建议，采纳后才生效；<strong>你不点确认就不会创建任何任务</strong>。</p>`,
      },
      {
        heading: '后台任务',
        html: `<p>从 AI Chat 的更多菜单、状态栏或命令打开，按最新优先排序：图表、检查记录、最新新增行、下次检查时间、失败次数，以及暂停 / 恢复 / 立即检查 / 删除、编辑间隔与条件、<em>Ask AI to explain</em>。</p>`,
      },
      {
        heading: '多窗口与账号切换',
        html: `<p>多个 VS Code 窗口同时打开时，监控由单实例持有（文件锁 + 15 秒心跳）。你可以在另一个窗口显式接管，交接时上一窗口的任务会自动暂停，避免重复检查。</p>
          <p>切换账号会暂停所有监控任务，防止把上一个账号的查询跑到新账号的连接上。</p>`,
      },
    ],
  },

  /* ---------------------------- 账户与同步 ---------------------------- */
  {
    slug: 'sync',
    title: '个人同步',
    summary: '端到端加密地在多设备间同步连接、分组、查询与 AI 配置。',
    icon: 'SY',
    group: 'account',
    sections: [
      {
        heading: '原理',
        html: `<p>同步对象在客户端以 DEK（数据加密密钥）做 AES-256-GCM 端到端加密，服务端只保存密文，无法读取明文。登录只认证身份，同步需显式输入同步口令解锁。</p>`,
      },
      {
        heading: '使用',
        html: `<ol>
          <li>登录后在命令面板执行 <em>Initialize Personal Sync</em> 初始化，或 <em>Unlock Personal Sync</em> 解锁。</li>
          <li>默认关闭自动同步（设置 <code>devbelt.sync.autoSync</code>）；开启后本地变更会自动同步，关闭时用「立即同步 / 拉取 / 推送」。</li>
          <li>跨设备冲突会持久化并在解决面板中选择保留本地或远端。</li>
        </ol>`,
      },
      {
        heading: '同步范围',
        html: `<p>连接、分组、保存的查询、AI 偏好与自定义规则。连接密码按账号作用域存放在 VS Code SecretStorage，不进入同步载荷。</p>`,
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
        html: `<p>支持邮箱注册、邮箱验证与登录，令牌自动轮换；可在控制台查看并远程撤销已登录设备。</p>`,
      },
      {
        heading: '账号数据隔离',
        html: `<p>登录后，连接、AI Key、对话历史、审计日志与备份全部按账号隔离存储（<code>&lt;base&gt;::u.&lt;userId&gt;</code>）；退出登录回到 <code>local</code> 作用域。</p>
          <p>切换账号时会关闭所有会话与面板、重新加载连接树、暂停后台任务，并提供一次性把本地数据复制到当前账号的选项（只复制，不移动）。</p>`,
      },
      {
        heading: '套餐',
        html: `<p>个人套餐及配额见 <a href="/plans">套餐页</a>。个人连接同步等能力依权益而定，配额以服务端校验为准。</p>`,
      },
    ],
  },
];

const STYLE = `
      :root {
        color-scheme: dark;
        --bg:#0b1020; --bg2:#0e152a; --panel:#131a30; --panel2:#182040;
        --line:#232a44; --fg:#e6e9f2; --muted:#9aa4bf; --dim:#6b7596;
        --accent:#3d6bff; --accent2:#6b8bff; --ok:#3ad29a;
        --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei",
          "Noto Sans SC", "Source Han Sans SC", "WenQuanYi Micro Hei", "Helvetica Neue", Arial, sans-serif;
        --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      * { box-sizing: border-box; }
      body { margin: 0; background:
          radial-gradient(1200px 600px at 80% -10%, rgba(61,107,255,.18), transparent 60%),
          radial-gradient(900px 500px at -10% 20%, rgba(58,210,154,.10), transparent 60%),
          var(--bg);
        color: var(--fg); font-family: var(--font-sans); line-height: 1.7; -webkit-font-smoothing: antialiased; }
      a { color: var(--accent2); text-decoration: none; }
      a:hover { text-decoration: underline; }
      .wrap { max-width: 1120px; margin: 0 auto; padding: 0 24px; }

      /* header —— 与官网一致 */
      header.top { position: sticky; top: 0; z-index: 20; background: rgba(11,16,32,.75);
        -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); border-bottom: 1px solid var(--line); }
      header.top .inner { display: flex; align-items: center; gap: 16px; padding: 16px 24px; }
      header.top .brand { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 1.1rem;
        letter-spacing: -0.01em; color: var(--fg); }
      header.top .brand:hover { text-decoration: none; }
      .brand-dot { width: 10px; height: 10px; border-radius: 3px; background: linear-gradient(135deg, var(--accent), var(--accent2)); }
      header.top .spacer { flex: 1; }
      header.top nav { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
      header.top nav a { color: var(--muted); padding: 6px 10px; border-radius: 8px; font-size: .92rem; }
      header.top nav a:hover { color: var(--fg); background: var(--panel); text-decoration: none; }
      header.top nav a.on { color: var(--fg); background: var(--panel); }
      header.top nav a.cta { color: #fff; background: var(--accent); }
      header.top nav a.cta:hover { background: var(--accent2); }
      header.top nav .sep { width: 1px; height: 18px; background: var(--line); margin: 0 6px; }

      /* layout */
      .layout { display: grid; grid-template-columns: 240px 1fr; gap: 40px; padding: 36px 0 64px; }
      .toc { position: sticky; top: 76px; align-self: start; }
      .toc > a { display: block; color: var(--muted); padding: 6px 0; font-size: .93rem; border-radius: 6px; }
      .toc > a:hover { color: var(--fg); text-decoration: none; }
      .toc > a.on { color: var(--fg); font-weight: 600; }
      .toc-group { margin-top: 18px; }
      .toc-group h4 { margin: 0 0 6px; font-size: .72rem; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); font-weight: 600; }
      .toc-group a { display: block; color: var(--muted); padding: 5px 0 5px 10px; font-size: .9rem; border-left: 1px solid var(--line); }
      .toc-group a:hover { color: var(--fg); border-left-color: var(--accent2); text-decoration: none; }
      .toc-group a.on { color: var(--fg); border-left-color: var(--accent); }

      /* article */
      article h1 { font-size: clamp(1.6rem, 3vw, 2rem); margin: 0 0 8px; letter-spacing: -0.02em; }
      article .summary { color: var(--muted); margin: 0 0 24px; font-size: 1.02rem; }
      article h2 { font-size: 1.18rem; margin: 34px 0 10px; padding-top: 4px; letter-spacing: -0.01em; }
      article h2::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 2px;
        background: var(--accent); transform: rotate(45deg); margin-right: 10px; vertical-align: 2px; }
      article p, article li { color: #c8cfdf; }
      article ul, article ol { padding-left: 22px; }
      article li { padding: 2px 0; }
      article strong { color: var(--fg); font-weight: 600; }
      article em { color: var(--fg); font-style: normal; background: rgba(61,107,255,.14); padding: 1px 5px; border-radius: 4px; }
      article code { font-family: var(--font-mono); background: var(--panel); border: 1px solid var(--line);
        border-radius: 5px; padding: 1px 6px; font-size: .88em; color: #d6dcf0; }
      article pre { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
        padding: 14px 16px; overflow-x: auto; }
      article pre code { background: none; border: 0; padding: 0; font-size: .88rem; }

      /* screenshots —— 与官网同款边框/圆角/阴影 */
      figure.shot { margin: 6px 0 26px; }
      figure.shot img { display: block; width: 100%; height: auto; border: 1px solid var(--line);
        border-radius: 14px; background: var(--panel); box-shadow: 0 12px 40px -18px rgba(0,0,0,.6); }
      figure.shot figcaption { color: var(--dim); font-size: .84rem; text-align: center; margin-top: 10px; }

      /* index cards —— 与官网 feature 卡同款 */
      .group { margin-bottom: 34px; }
      .group h2 { font-size: 1.1rem; margin: 0 0 4px; }
      .group .gdesc { color: var(--dim); font-size: .9rem; margin: 0 0 14px; }
      .cards { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); }
      .card { display: block; padding: 20px; border: 1px solid var(--line); border-radius: 14px;
        background: linear-gradient(180deg, var(--panel), var(--panel2)); color: inherit;
        transition: border-color .15s ease, transform .05s ease; }
      .card:hover { border-color: var(--accent); text-decoration: none; transform: translateY(-1px); }
      .card h3 { margin: 0 0 8px; font-size: 1rem; display: flex; align-items: center; gap: 8px; }
      .card .icon { width: 28px; height: 28px; border-radius: 8px; background: rgba(61,107,255,.14);
        color: var(--accent2); display: inline-flex; align-items: center; justify-content: center;
        font-size: .72rem; font-weight: 700; flex-shrink: 0; }
      .card p { margin: 0; color: var(--muted); font-size: .9rem; }

      /* footer —— 与官网一致 */
      footer { color: var(--muted); font-size: .88rem; padding: 36px 0 48px; border-top: 1px solid var(--line); }
      footer .fgrid { display: flex; flex-wrap: wrap; gap: 24px 48px; justify-content: space-between; align-items: flex-start; }
      footer .brand-col { min-width: 240px; flex: 1 1 280px; }
      footer .brand { font-weight: 700; font-size: 1.05rem; color: var(--fg); margin-bottom: 6px;
        display: flex; align-items: center; gap: 8px; }
      footer .tagline { margin: 4px 0 0; color: var(--dim); font-size: .86rem; max-width: 320px; }
      footer .ver { font-size: .78rem; color: var(--dim); margin-top: 10px; }
      footer h5 { margin: 0 0 8px; color: var(--dim); font-size: .8rem; text-transform: uppercase;
        letter-spacing: .08em; font-weight: 600; }
      footer ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
      footer ul a { color: var(--muted); font-size: .88rem; }
      footer ul a:hover { color: var(--fg); text-decoration: none; }
      footer .legal { width: 100%; border-top: 1px solid var(--line); padding-top: 18px; margin-top: 24px;
        font-size: .82rem; color: var(--dim); display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; }

      @media (max-width: 860px) {
        .layout { grid-template-columns: 1fr; gap: 24px; padding: 24px 0 48px; }
        .toc { position: static; border-bottom: 1px solid var(--line); padding-bottom: 14px; }
        .toc-group { display: inline-block; margin: 10px 18px 0 0; vertical-align: top; }
        header.top nav a { padding: 5px 8px; font-size: .86rem; }
        header.top nav .sep { display: none; }
      }
      @media (max-width: 600px) {
        .wrap, header.top .inner { padding-left: 18px; padding-right: 18px; }
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
  /** 请求是否已登录（由服务端按 refresh cookie 判定）。登录时 header 改为控制台入口。 */
  loggedIn?: boolean;
}

/** 与官网一致的顶部导航。 */
function header(opts: DocsRenderOptions): string {
  const navAuth = opts.loggedIn
    ? `<a href="/db/">控制台</a>`
    : `<a href="/login">登录</a><a class="cta" href="/register">免费注册</a>`;
  return `<header class="top">
      <div class="wrap inner">
        <a class="brand" href="/"><span class="brand-dot"></span>DevBelt</a>
        <span class="spacer"></span>
        <nav>
          <a href="/#features">功能</a>
          <a href="/#new">0.4.0 新功能</a>
          <a href="/#install">安装</a>
          <a href="/db/docs" class="on">文档</a>
          <a href="/plans">套餐</a>
          <a href="https://github.com/lang2hong/devbelt" target="_blank" rel="noopener noreferrer">GitHub</a>
          <span class="sep"></span>
          <a href="/en">English</a>
          <span class="sep"></span>
          ${navAuth}
        </nav>
      </div>
    </header>`;
}

/** 与官网一致的四列页脚。 */
function footer(): string {
  return `<footer>
      <div class="wrap">
        <div class="fgrid">
          <div class="brand-col">
            <div class="brand"><span class="brand-dot"></span>DevBelt</div>
            <p class="tagline">在 VS Code 内完成数据库开发：SQL、Redis、Elasticsearch、AI 助手与数据监控。</p>
            <div class="ver">v0.4.0 · MIT 许可</div>
          </div>
          <div>
            <h5>产品</h5>
            <ul>
              <li><a href="/#features">功能</a></li>
              <li><a href="/#new">0.4.0 新功能</a></li>
              <li><a href="/plans">同步套餐</a></li>
            </ul>
          </div>
          <div>
            <h5>资源</h5>
            <ul>
              <li><a href="/db/docs">文档</a></li>
              <li><a href="https://github.com/lang2hong/devbelt/blob/main/CHANGELOG.md" target="_blank" rel="noopener noreferrer">更新日志</a></li>
              <li><a href="https://github.com/lang2hong/devbelt" target="_blank" rel="noopener noreferrer">GitHub 仓库</a></li>
            </ul>
          </div>
          <div>
            <h5>下载</h5>
            <ul>
              <li><a href="https://marketplace.visualstudio.com/items?itemName=lang2hong.devbelt-db-client" target="_blank" rel="noopener noreferrer">VS Code Marketplace</a></li>
              <li><a href="https://open-vsx.org/extension/lang2hong/devbelt-db-client" target="_blank" rel="noopener noreferrer">Open VSX</a></li>
            </ul>
          </div>
        </div>
        <div class="legal">
          <span>© DevBelt · MIT 许可</span>
          <span><a href="/en">English</a></span>
        </div>
      </div>
    </footer>`;
}

function shell(title: string, description: string, body: string, opts: DocsRenderOptions): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)} · DevBelt 文档</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="theme-color" content="#0b1020" />
    <style>${STYLE}</style>
  </head>
  <body>
    ${header(opts)}
    <div class="wrap">
      ${body}
    </div>
    ${footer()}
  </body>
</html>`;
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

/** 文档首页：按分组列出全部文档入口。 */
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

  const body = `<div class="layout">
        ${toc()}
        <article>
          <h1>使用文档</h1>
          <p class="summary">DevBelt 的产品使用指南。开发者文档见仓库 <code>docs/</code>，发版记录见 <a href="https://github.com/lang2hong/devbelt/blob/main/CHANGELOG.md" target="_blank" rel="noopener noreferrer">CHANGELOG</a>。</p>
          ${groups}
        </article>
      </div>`;
  return shell('使用文档', 'DevBelt 产品使用文档：连接管理、SQL、结构与数据、Redis、Elasticsearch、AI 助手、数据监控、同步与账户。', body, opts);
}

/** 单篇文档；未知 slug 返回 null（由路由决定 404）。 */
export function renderDocPage(slug: string, opts: DocsRenderOptions = {}): string | null {
  const doc = DOCS.find((d) => d.slug === slug);
  if (!doc) return null;
  const shots = (doc.shots ?? []).map(figureMarkup).join('\n          ');
  const sections = doc.sections
    .map((s) => `<h2>${escapeHtml(s.heading)}</h2>\n          ${s.html}`)
    .join('\n          ');
  const body = `<div class="layout">
        ${toc(doc.slug)}
        <article>
          <h1>${escapeHtml(doc.title)}</h1>
          <p class="summary">${escapeHtml(doc.summary)}</p>
          ${shots}
          ${sections}
        </article>
      </div>`;
  return shell(doc.title, doc.summary, body, opts);
}