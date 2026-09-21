/**
 * 公开文档中心（`/docs`）：服务端渲染、零构建依赖、**无需登录**。
 *
 * 与 `home.ts` 同一风格（内联 HTML + 严格 CSP），面向用户的产品使用文档；
 * 面向开发者的仓库文档仍在 `docs/`。正文为受信任的静态 HTML，不由用户输入拼装。
 */

export interface DocSection {
  heading: string;
  html: string;
}

export interface DocPage {
  slug: string;
  title: string;
  summary: string;
  sections: DocSection[];
}

export const DOCS: readonly DocPage[] = [
  {
    slug: 'getting-started',
    title: '快速开始',
    summary: '安装扩展、建立第一个连接、运行第一条查询。',
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

function shell(title: string, body: string): string {
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
          <a href="/docs">文档</a>
          <a href="/plans">套餐</a>
          <a href="/login">登录</a>
        </nav>
      </header>
      ${body}
      <footer>DevBelt · 开发者工具套件</footer>
    </div>
  </body>
</html>`;
}

function toc(currentSlug?: string): string {
  const links = DOCS.map(
    (d) => `<a href="/docs/${d.slug}"${d.slug === currentSlug ? ' class="on"' : ''}>${escapeHtml(d.title)}</a>`,
  ).join('\n          ');
  return `<nav class="toc">
          <a href="/docs"${currentSlug === undefined ? ' class="on"' : ''}>文档首页</a>
          ${links}
        </nav>`;
}

/** 文档首页：列出全部文档入口。 */
export function renderDocsIndex(): string {
  const cards = DOCS.map(
    (d) => `<a class="card" href="/docs/${d.slug}"><strong>${escapeHtml(d.title)}</strong><span>${escapeHtml(d.summary)}</span></a>`,
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
  return shell('使用文档', body);
}

/** 单篇文档；未知 slug 返回 null（由路由决定 404）。 */
export function renderDocPage(slug: string): string | null {
  const doc = DOCS.find((d) => d.slug === slug);
  if (!doc) return null;
  const sections = doc.sections
    .map((s) => `<h2>${escapeHtml(s.heading)}</h2>\n          ${s.html}`)
    .join('\n          ');
  const body = `<div class="layout">
        ${toc(doc.slug)}
        <article>
          <h1>${escapeHtml(doc.title)}</h1>
          <p class="summary">${escapeHtml(doc.summary)}</p>
          ${sections}
        </article>
      </div>`;
  return shell(doc.title, body);
}