/**
 * 公开文档中心（`/db/docs`）：服务端渲染、零构建依赖、**无需登录**。
 *
 * 与 `home.ts` 同一风格（内联 HTML + 严格 CSP），面向用户的产品使用文档；
 * 面向开发者的仓库文档仍在 `docs/`。正文为受信任的静态 HTML，不由用户输入拼装。
 * 插图为本文件内联 SVG（无外部资源，符合 CSP）。
 */

export interface DocSection {
  heading: string;
  html: string;
}

export interface DocPage {
  slug: string;
  title: string;
  summary: string;
  /** 插图 key（见 FIG），渲染在摘要下方。 */
  figure?: keyof typeof FIG;
  sections: DocSection[];
}

const svg = (label: string, inner: string): string =>
  `<svg class="fig" viewBox="0 0 640 340" role="img" aria-label="${label}" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;

/** 内联 SVG 插图：模拟 VS Code 界面与关键工作流。 */
export const FIG = {
  /** VS Code 窗口：活动栏 + 连接树 + 编辑器。 */
  vscode: svg(
    'VS Code 中的 DB Client 界面',
    `<rect x="1" y="1" width="638" height="338" rx="10" fill="#0f1426" stroke="#2b3350"/>
     <rect x="1" y="1" width="638" height="34" rx="10" fill="#161d33"/>
     <rect x="1" y="27" width="638" height="8" fill="#161d33"/>
     <circle cx="22" cy="18" r="5" fill="#ff5f56"/><circle cx="40" cy="18" r="5" fill="#ffbd2e"/><circle cx="58" cy="18" r="5" fill="#27c93f"/>
     <text x="80" y="22" fill="#8b96b5" font-size="12" font-family="sans-serif">db.sql — DevBelt DB Client</text>
     <rect x="1" y="35" width="56" height="304" fill="#121831"/>
     <rect x="18" y="56" width="22" height="22" rx="4" fill="#3d6bff"/>
     <rect x="22" y="96" width="14" height="14" rx="3" fill="#3a4366"/>
     <rect x="22" y="122" width="14" height="14" rx="3" fill="#3a4366"/>
     <rect x="22" y="148" width="14" height="14" rx="3" fill="#3a4366"/>
     <rect x="57" y="35" width="180" height="304" fill="#141b31"/>
     <text x="70" y="60" fill="#9aa4bf" font-size="12" font-family="sans-serif">DB CLIENT</text>
     <rect x="70" y="74" width="150" height="22" rx="4" fill="#1d2742"/>
     <text x="78" y="89" fill="#cdd4e6" font-size="11" font-family="sans-serif">▾ 本地 MySQL</text>
     <text x="88" y="112" fill="#8b96b5" font-size="11" font-family="sans-serif">▾ shop</text>
     <text x="98" y="133" fill="#cdd4e6" font-size="11" font-family="sans-serif">▦ users</text>
     <text x="98" y="154" fill="#cdd4e6" font-size="11" font-family="sans-serif">▦ orders</text>
     <text x="88" y="175" fill="#8b96b5" font-size="11" font-family="sans-serif">▸ analytics</text>
     <rect x="237" y="35" width="44" height="304" fill="#10162b"/>
     <rect x="245" y="50" width="28" height="18" rx="3" fill="#1d2742"/>
     <rect x="281" y="35" width="358" height="180" fill="#0f1426"/>
     <text x="300" y="64" fill="#8b96b5" font-size="11" font-family="monospace">SELECT id, name FROM users LIMIT 3;</text>
     <text x="300" y="88" fill="#3d6bff" font-size="11" font-family="monospace">SELECT</text><text x="356" y="88" fill="#e6e9f2" font-size="11" font-family="monospace">id, name</text>
     <text x="300" y="112" fill="#3d6bff" font-size="11" font-family="monospace">FROM</text><text x="356" y="112" fill="#e6e9f2" font-size="11" font-family="monospace">users</text>
     <rect x="281" y="215" width="358" height="124" fill="#141b31"/>
     <polygon points="281,215 430,215 470,243 281,243" fill="#1d2742"/>
     <text x="300" y="233" fill="#8b96b5" font-size="11" font-family="sans-serif">结果</text>
     <line x1="281" y1="243" x2="639" y2="243" stroke="#2b3350"/>
     <text x="300" y="265" fill="#8b96b5" font-size="10" font-family="sans-serif">id</text><text x="380" y="265" fill="#8b96b5" font-size="10" font-family="sans-serif">name</text>
     <text x="300" y="290" fill="#cdd4e6" font-size="11" font-family="sans-serif">1</text><text x="380" y="290" fill="#cdd4e6" font-size="11" font-family="sans-serif">Alice</text>
     <text x="300" y="313" fill="#cdd4e6" font-size="11" font-family="sans-serif">2</text><text x="380" y="313" fill="#cdd4e6" font-size="11" font-family="sans-serif">Bob</text>`,
  ),
  /** 连接 + SSH 隧道。 */
  connection: svg(
    '连接与 SSH 隧道',
    `<rect x="1" y="1" width="638" height="338" rx="10" fill="#0f1426" stroke="#2b3350"/>
     <rect x="60" y="130" width="150" height="80" rx="10" fill="#1d2742" stroke="#3d6bff"/>
     <text x="100" y="165" fill="#e6e9f2" font-size="13" font-family="sans-serif">VS Code</text>
     <text x="86" y="188" fill="#9aa4bf" font-size="11" font-family="sans-serif">DB Client</text>
     <rect x="270" y="130" width="150" height="80" rx="10" fill="#1d2742" stroke="#3a4366"/>
     <text x="318" y="165" fill="#e6e9f2" font-size="13" font-family="sans-serif">SSH</text>
     <text x="300" y="188" fill="#9aa4bf" font-size="11" font-family="sans-serif">跳板机 :22</text>
     <rect x="480" y="130" width="120" height="80" rx="10" fill="#1d2742" stroke="#3a4366"/>
     <text x="510" y="165" fill="#e6e9f2" font-size="13" font-family="sans-serif">MySQL</text>
     <text x="512" y="188" fill="#9aa4bf" font-size="11" font-family="sans-serif">RDS :3306</text>
     <line x1="210" y1="170" x2="270" y2="170" stroke="#3d6bff" stroke-width="2"/>
     <line x1="420" y1="170" x2="480" y2="170" stroke="#3d6bff" stroke-width="2"/>
     <text x="60" y="70" fill="#9aa4bf" font-size="12" font-family="sans-serif">凭据存入 VS Code SecretStorage；SSH 主机密钥按指纹校验</text>`,
  ),
  /** 查询编辑与结果网格。 */
  query: svg(
    'SQL 编辑器与结果表格',
    `<rect x="1" y="1" width="638" height="338" rx="10" fill="#0f1426" stroke="#2b3350"/>
     <rect x="20" y="24" width="600" height="90" rx="8" fill="#141b31"/>
     <text x="40" y="56" fill="#3d6bff" font-size="12" font-family="monospace">SELECT</text><text x="100" y="56" fill="#e6e9f2" font-size="12" font-family="monospace">o.id, u.name, o.total</text>
     <text x="40" y="80" fill="#3d6bff" font-size="12" font-family="monospace">FROM</text><text x="100" y="80" fill="#e6e9f2" font-size="12" font-family="monospace">orders o JOIN users u ON u.id = o.user_id</text>
     <text x="40" y="104" fill="#3d6bff" font-size="12" font-family="monospace">WHERE</text><text x="100" y="104" fill="#e6e9f2" font-size="12" font-family="monospace">o.total &gt; 100</text>
     <rect x="20" y="130" width="600" height="186" rx="8" fill="#141b31"/>
     <rect x="20" y="130" width="600" height="30" rx="8" fill="#1d2742"/>
     <text x="44" y="150" fill="#9aa4bf" font-size="11" font-family="sans-serif">id</text><text x="130" y="150" fill="#9aa4bf" font-size="11" font-family="sans-serif">name</text><text x="300" y="150" fill="#9aa4bf" font-size="11" font-family="sans-serif">total</text>
     <line x1="20" y1="160" x2="620" y2="160" stroke="#2b3350"/>
     <text x="44" y="186" fill="#cdd4e6" font-size="12" font-family="sans-serif">1001</text><text x="130" y="186" fill="#cdd4e6" font-size="12" font-family="sans-serif">Alice</text><text x="300" y="186" fill="#cdd4e6" font-size="12" font-family="sans-serif">¥128.00</text>
     <text x="44" y="216" fill="#cdd4e6" font-size="12" font-family="sans-serif">1002</text><text x="130" y="216" fill="#cdd4e6" font-size="12" font-family="sans-serif">Bob</text><text x="300" y="216" fill="#cdd4e6" font-size="12" font-family="sans-serif">¥260.50</text>
     <text x="44" y="246" fill="#cdd4e6" font-size="12" font-family="sans-serif">1003</text><text x="130" y="246" fill="#cdd4e6" font-size="12" font-family="sans-serif">Carol</text><text x="300" y="246" fill="#cdd4e6" font-size="12" font-family="sans-serif">¥99.00</text>`,
  ),
  /** ER 图。 */
  er: svg(
    'ER 图',
    `<rect x="1" y="1" width="638" height="338" rx="10" fill="#0f1426" stroke="#2b3350"/>
     <rect x="60" y="60" width="180" height="96" rx="8" fill="#1d2742" stroke="#3d6bff"/>
     <text x="88" y="86" fill="#e6e9f2" font-size="13" font-family="sans-serif">users 🔑</text>
     <text x="88" y="110" fill="#9aa4bf" font-size="11" font-family="sans-serif">id · name · email</text>
     <text x="88" y="132" fill="#9aa4bf" font-size="11" font-family="sans-serif">created_at</text>
     <rect x="400" y="180" width="180" height="96" rx="8" fill="#1d2742" stroke="#3a4366"/>
     <text x="428" y="206" fill="#e6e9f2" font-size="13" font-family="sans-serif">orders</text>
     <text x="428" y="230" fill="#9aa4bf" font-size="11" font-family="sans-serif">id · user_id · total</text>
     <text x="428" y="252" fill="#9aa4bf" font-size="11" font-family="sans-serif">status</text>
     <line x1="240" y1="120" x2="400" y2="205" stroke="#3d6bff" stroke-width="2"/>
     <text x="286" y="150" fill="#3d6bff" font-size="11" font-family="sans-serif">1 ─ n</text>`,
  ),
  /** E2EE 同步流。 */
  sync: svg(
    '端到端加密同步',
    `<rect x="1" y="1" width="638" height="338" rx="10" fill="#0f1426" stroke="#2b3350"/>
     <rect x="40" y="120" width="140" height="90" rx="10" fill="#1d2742" stroke="#3d6bff"/>
     <text x="70" y="155" fill="#e6e9f2" font-size="13" font-family="sans-serif">设备 A</text>
     <text x="58" y="178" fill="#9aa4bf" font-size="10" font-family="sans-serif">DEK 加密</text>
     <rect x="250" y="120" width="140" height="90" rx="10" fill="#1d2742" stroke="#3a4366"/>
     <text x="286" y="155" fill="#e6e9f2" font-size="13" font-family="sans-serif">服务端</text>
     <text x="268" y="178" fill="#9aa4bf" font-size="10" font-family="sans-serif">仅存密文</text>
     <rect x="460" y="120" width="140" height="90" rx="10" fill="#1d2742" stroke="#3d6bff"/>
     <text x="490" y="155" fill="#e6e9f2" font-size="13" font-family="sans-serif">设备 B</text>
     <text x="478" y="178" fill="#9aa4bf" font-size="10" font-family="sans-serif">DEK 解密</text>
     <line x1="180" y1="150" x2="250" y2="150" stroke="#3d6bff" stroke-width="2"/>
     <line x1="390" y1="150" x2="460" y2="150" stroke="#3d6bff" stroke-width="2"/>
     <text x="186" y="140" fill="#9aa4bf" font-size="10" font-family="sans-serif">AES-GCM</text>
     <text x="396" y="140" fill="#9aa4bf" font-size="10" font-family="sans-serif">AES-GCM</text>
     <text x="40" y="70" fill="#9aa4bf" font-size="12" font-family="sans-serif">连接 / 分组 / 保存查询在客户端加密后同步</text>`,
  ),
} as const;

export const DOCS: readonly DocPage[] = [
  {
    slug: 'getting-started',
    title: '快速开始',
    summary: '安装扩展、建立第一个连接、运行第一条查询。',
    figure: 'vscode',
    sections: [
      {
        heading: '安装',
        html: `<p>DevBelt DB Client 通过 VS Code 扩展发布。安装后在活动栏打开「DB Client」视图即可开始；本地连接（MySQL / PostgreSQL / SQLite）<strong>无需登录</strong>。</p>`,
      },
      {
        heading: '建立连接',
        html: `<ol>
          <li>在「DB Client」视图标题栏点击 <em>新增连接</em>。</li>
          <li>选择数据库类型并填写主机、端口、用户名、密码（可选 SSH 隧道）。</li>
          <li>点击 <em>测试连接</em> 确认后保存；密码等敏感字段存入 VS Code SecretStorage。</li>
        </ol>`,
      },
      {
        heading: '运行查询',
        html: `<p>新建一个 <code>.sql</code> 文件，编辑器右上角选择目标连接后执行；结果在下方表格展示，支持筛选、排序与受控行内编辑。</p>`,
      },
    ],
  },
  {
    slug: 'connections',
    title: '连接管理',
    summary: '连接、分组、SSH 隧道与凭据存储。',
    figure: 'connection',
    sections: [
      {
        heading: '分组与克隆',
        html: `<p>连接可按分组组织；右键连接可克隆、编辑、删除或移动到分组。非敏感的 host/port/database 等存于 globalState，密码、SSH 密码与私钥口令存于 SecretStorage。</p>`,
      },
      {
        heading: 'SSH 隧道',
        html: `<p>支持通过 SSH 跳板访问数据库。首次连接未知主机时会校验 SHA256 指纹（<code>tofu</code> 默认），也可设为 <code>strict</code> 只信任已有 known_hosts；密钥变更或 revoked 一律拒绝。</p>`,
      },
    ],
  },
  {
    slug: 'sql',
    title: 'SQL 编辑器',
    summary: '补全、格式化、执行、取消与 EXPLAIN。',
    figure: 'query',
    sections: [
      {
        heading: '编辑体验',
        html: `<p>提供关键字/对象补全、CodeLens 快捷执行、SQL 格式化与多语句执行；执行中可取消，也可对查询生成 EXPLAIN 计划。</p>`,
      },
      {
        heading: '多结果集',
        html: `<p>一次执行多条语句时，结果以多个标签页展示，便于对照；DDL 执行后会刷新对象树。</p>`,
      },
    ],
  },
  {
    slug: 'data',
    title: '数据操作',
    summary: '结果编辑、数据导入导出与库间传输。',
    sections: [
      {
        heading: '导入导出',
        html: `<p>支持 CSV / JSON / XML / XLSX / SQL 的导入导出；导出可自定义字段与格式，导入前可预览映射。二进制（BLOB/BYTEA/GEOMETRY）以 base64 安全往返。</p>`,
      },
      {
        heading: '受控编辑',
        html: `<p>结果表支持行内编辑，仅对可定位主键的行生效；生产环境保护与只读模式可阻止写入。</p>`,
      },
    ],
  },
  {
    slug: 'schema',
    title: '结构工具',
    summary: '表设计器、DDL、ER 图与 Schema 对比。',
    figure: 'er',
    sections: [
      {
        heading: '表设计器',
        html: `<p>可视化新建/修改表、列、索引、外键、触发器、视图、例程与事件，并生成对应 DDL 预览。</p>`,
      },
      {
        heading: 'ER 图与对比',
        html: `<p>按外键关系生成 ER 图；可对比两个 Schema 并生成同步 SQL，用于迁移与审阅。</p>`,
      },
    ],
  },
  {
    slug: 'sync',
    title: '个人同步',
    summary: '端到端加密地在多设备间同步连接、分组与保存查询。',
    figure: 'sync',
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
    ],
  },
  {
    slug: 'organizations',
    title: '组织协作',
    summary: '共享目录、共享查询与连接模板。',
    sections: [
      {
        heading: '共享资源',
        html: `<p>登录后组织树展示所属组织、目录、共享查询和连接模板。管理员可新建/删除目录与资源；成员为只读。</p>`,
      },
      {
        heading: '连接模板',
        html: `<p>使用组织模板时，密码、SSH、证书等敏感字段只存本机（CredentialVault），不上传服务端。</p>`,
      },
    ],
  },
  {
    slug: 'account',
    title: '账户与套餐',
    summary: '注册登录、设备管理、改密与套餐权益。',
    sections: [
      {
        heading: '账户',
        html: `<p>支持邮箱注册、邮箱验证与登录，令牌自动轮换；可在控制台查看并远程撤销已登录设备。</p>`,
      },
      {
        heading: '套餐',
        html: `<p>个人与组织套餐及配额见 <a href="/plans">套餐页</a>。个人连接同步等能力依权益而定，配额以服务端校验为准。</p>`,
      },
    ],
  },
];

const STYLE = `
      :root { color-scheme: dark; --bg:#0b1020; --panel:#131a30; --line:#232a44; --fg:#e6e9f2; --muted:#9aa4bf; --accent:#3d6bff; }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--bg); color: var(--fg);
        font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; line-height: 1.7; }
      a { color: var(--accent); }
      .wrap { max-width: 1040px; margin: 0 auto; padding: 0 24px; }
      header.top { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 16px; padding: 18px 0;
        background: rgba(11,16,32,.85); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); }
      header.top .brand { font-weight: 700; font-size: 1.1rem; color: var(--fg); text-decoration: none; }
      header.top .spacer { flex: 1; }
      header.top nav a { color: var(--muted); text-decoration: none; margin-left: 18px; font-size: .95rem; }
      header.top nav a:hover { color: var(--fg); }
      .layout { display: grid; grid-template-columns: 220px 1fr; gap: 32px; padding: 32px 0 56px; }
      .toc { position: sticky; top: 76px; align-self: start; border-right: 1px solid var(--line); padding-right: 16px; }
      .toc a { display: block; color: var(--muted); text-decoration: none; padding: 6px 0; font-size: .95rem; }
      .toc a:hover, .toc a.on { color: var(--fg); }
      article h1 { font-size: 1.9rem; margin: 0 0 6px; letter-spacing: -0.02em; }
      article .summary { color: var(--muted); margin: 0 0 20px; }
      article h2 { font-size: 1.2rem; margin: 28px 0 8px; }
      article code { background: var(--panel); border: 1px solid var(--line); border-radius: 5px; padding: 1px 5px; font-size: .9em; }
      article p, article li { color: #cdd4e6; }
      article ol, article ul { padding-left: 22px; }
      .fig { width: 100%; height: auto; margin: 4px 0 24px; border: 1px solid var(--line); border-radius: 12px; background: #0f1426; }
      .cards { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); margin-top: 18px; }
      .card { display: block; padding: 18px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); text-decoration: none; color: inherit; }
      .card:hover { border-color: var(--accent); }
      .card strong { display: block; margin-bottom: 4px; }
      .card span { color: var(--muted); font-size: .92rem; }
      footer { color: var(--muted); font-size: .85rem; padding: 24px 0 40px; border-top: 1px solid var(--line); }
      @media (max-width: 720px) { .layout { grid-template-columns: 1fr; } .toc { position: static; border-right: 0; border-bottom: 1px solid var(--line); padding: 0 0 12px; } }
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

function navAuth(opts: DocsRenderOptions): string {
  return opts.loggedIn
    ? `<a href="/db/">控制台</a>`
    : `<a href="/login">登录</a>`;
}

function shell(title: string, body: string, opts: DocsRenderOptions): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)} · DevBelt 文档</title>
    <meta name="description" content="DevBelt DB Client 使用文档。" />
    <style>${STYLE}    </style>
  </head>
  <body>
    <div class="wrap">
      <header class="top">
        <a class="brand" href="/">DevBelt</a>
        <span class="spacer"></span>
        <nav>
          <a href="/">首页</a>
          <a href="/db/docs">文档</a>
          <a href="/plans">套餐</a>
          ${navAuth(opts)}
        </nav>
      </header>
      ${body}
      <footer>DevBelt</footer>
    </div>
  </body>
</html>`;
}

function toc(currentSlug?: string): string {
  const links = DOCS.map(
    (d) => `<a href="/db/docs/${d.slug}"${d.slug === currentSlug ? ' class="on"' : ''}>${escapeHtml(d.title)}</a>`,
  ).join('\n          ');
  return `<nav class="toc">
          <a href="/db/docs"${currentSlug === undefined ? ' class="on"' : ''}>文档首页</a>
          ${links}
        </nav>`;
}

/** 文档首页：列出全部文档入口。 */
export function renderDocsIndex(opts: DocsRenderOptions = {}): string {
  const cards = DOCS.map(
    (d) => `<a class="card" href="/db/docs/${d.slug}"><strong>${escapeHtml(d.title)}</strong><span>${escapeHtml(d.summary)}</span></a>`,
  ).join('\n          ');
  const body = `<div class="layout">
        ${toc()}
        <article>
          <h1>使用文档</h1>
          <p class="summary">DevBelt DB Client 的产品使用指南。开发者文档见仓库 <code>docs/</code>。</p>
          <div class="cards">
          ${cards}
          </div>
        </article>
      </div>`;
  return shell('使用文档', body, opts);
}

/** 单篇文档；未知 slug 返回 null（由路由决定 404）。 */
export function renderDocPage(slug: string, opts: DocsRenderOptions = {}): string | null {
  const doc = DOCS.find((d) => d.slug === slug);
  if (!doc) return null;
  const figure = doc.figure ? `\n          ${FIG[doc.figure]}` : '';
  const sections = doc.sections
    .map((s) => `<h2>${escapeHtml(s.heading)}</h2>\n          ${s.html}`)
    .join('\n          ');
  const body = `<div class="layout">
        ${toc(doc.slug)}
        <article>
          <h1>${escapeHtml(doc.title)}</h1>
          <p class="summary">${escapeHtml(doc.summary)}</p>${figure}
          ${sections}
        </article>
      </div>`;
  return shell(doc.title, body, opts);
}