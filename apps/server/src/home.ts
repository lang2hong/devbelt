/**
 * 套件首页（`/`）：DevBelt 落地页。
 *
 * 介绍 / 工具 / 套餐 / 入口四段。套餐为**服务端渲染**，由 app.ts 从 billing 套餐目录
 * 读取后以结构化 `HomePlan[]` 传入（单一数据源，无需登录，且不含内联 JS，符合严格 CSP）。
 * 有意保持零构建依赖（内联 HTML），后续可替换为独立首页应用。
 */

export interface HomePlan {
  code: string;
  name: string;
  kind: 'personal' | 'organization';
  priceCents: number;
  unit: 'month' | 'seat-month';
  /** 已格式化好的关键特性摘要。 */
  highlights: string[];
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatPrice(plan: HomePlan): string {
  if (plan.priceCents <= 0) return plan.kind === 'personal' ? '免费' : '待定价';
  const yuan = plan.priceCents / 100;
  const amount = Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2);
  return `¥${amount}`;
}

function formatUnit(plan: HomePlan): string {
  if (plan.priceCents <= 0) return plan.kind === 'personal' ? '' : '按席';
  return plan.unit === 'seat-month' ? '/席·月' : '/月';
}

function planCard(plan: HomePlan): string {
  const highlights = plan.highlights
    .map((h) => `<li>${escapeHtml(h)}</li>`)
    .join('');
  return `
        <article class="plan">
          <h4>${escapeHtml(plan.name)}</h4>
          <p class="price">${escapeHtml(formatPrice(plan))}<span>${escapeHtml(formatUnit(plan))}</span></p>
          <ul>${highlights}</ul>
          <a class="plan-cta" href="/register">开始使用</a>
        </article>`;
}

interface HomeTool {
  name: string;
  desc: string;
  /** 外部链接；空表示尚未发布（「待开发」）。 */
  href: string;
  badge: string;
}

const TOOLS: readonly HomeTool[] = [
  {
    name: 'DB Client',
    desc: 'VS Code 数据库客户端：连接 MySQL / PostgreSQL / SQLite，SQL 编辑、结果面板、ER 图、表设计、备份与导入导出。',
    href: 'https://marketplace.visualstudio.com/items?itemName=lang2hong.db-client',
    badge: 'VS Code 扩展',
  },
  {
    name: 'REST NEO',
    desc: 'VS Code REST 客户端：在编辑器内编写并发送 HTTP 请求、管理环境与响应。',
    href: 'https://marketplace.visualstudio.com/items?itemName=lang2hong.rest-client-neo',
    badge: 'VS Code 扩展',
  },
  {
    name: 'l2h-harness',
    desc: '开发中的新工具。',
    href: '',
    badge: '待开发',
  },
];

function toolCard(tool: HomeTool): string {
  const inner = `<strong>${escapeHtml(tool.name)}<span class="badge">${escapeHtml(tool.badge)}</span></strong><span>${escapeHtml(tool.desc)}</span>`;
  return tool.href
    ? `<a class="tool" href="${tool.href}" target="_blank" rel="noopener noreferrer">${inner}</a>`
    : `<div class="tool soon">${inner}</div>`;
}

export function renderHome(plans: HomePlan[] | null): string {
  const personal = plans?.filter((p) => p.kind === 'personal') ?? [];
  const organization = plans?.filter((p) => p.kind === 'organization') ?? [];
  const pricing =
    personal.length + organization.length > 0
      ? `
      <div class="plan-group">
        <h3>个人</h3>
        <div class="plans">${personal.map(planCard).join('')}</div>
      </div>
      <div class="plan-group">
        <h3>组织</h3>
        <div class="plans">${organization.map(planCard).join('')}</div>
      </div>`
      : `<p class="muted">套餐信息暂时不可用，请稍后再试。</p>`;

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DevBelt · 开发者工具套件</title>
    <meta name="description" content="DevBelt：数据库客户端、控制台与端到端加密同步的开发者工具套件。" />
    <style>
      :root { color-scheme: dark; --bg:#0b1020; --panel:#131a30; --line:#232a44; --fg:#e6e9f2; --muted:#9aa4bf; --accent:#3d6bff; }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--bg); color: var(--fg);
        font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; line-height: 1.6; }
      a { color: inherit; }
      .wrap { max-width: 1040px; margin: 0 auto; padding: 0 24px; }
      header.top { display: flex; align-items: center; gap: 16px; padding: 20px 0; }
      header.top .brand { font-weight: 700; font-size: 1.15rem; letter-spacing: -0.01em; }
      header.top .spacer { flex: 1; }
      header.top nav a { color: var(--muted); text-decoration: none; margin-left: 18px; font-size: .95rem; }
      header.top nav a:hover { color: var(--fg); }
      .hero { padding: 56px 0 40px; }
      .hero h1 { font-size: 2.8rem; margin: 0 0 12px; letter-spacing: -0.03em; }
      .hero p { color: var(--muted); font-size: 1.1rem; max-width: 680px; margin: 0 0 28px; }
      .cta { display: flex; gap: 12px; flex-wrap: wrap; }
      .btn { display: inline-block; padding: 11px 20px; border-radius: 10px; text-decoration: none; font-weight: 600; }
      .btn.primary { background: var(--accent); color: #fff; }
      .btn.ghost { border: 1px solid var(--line); color: var(--fg); }
      section { padding: 36px 0; border-top: 1px solid var(--line); }
      section > h2 { font-size: 1.5rem; margin: 0 0 6px; }
      section > p.section-sub { color: var(--muted); margin: 0 0 24px; }
      .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
      .tool { display: block; padding: 20px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); text-decoration: none; color: inherit; }
      a.tool:hover { border-color: var(--accent); }
      .tool strong { display: block; margin-bottom: 6px; }
      .tool span { display: block; color: var(--muted); font-size: .92rem; }
      .tool .badge { display: inline-block; margin-left: 8px; padding: 1px 6px; border: 1px solid var(--line);
        border-radius: 6px; color: var(--accent); font-size: .72rem; vertical-align: middle; }
      .tool.soon { opacity: .6; }
      .plan-group { margin-bottom: 24px; }
      .plan-group h3 { font-size: 1.05rem; color: var(--muted); margin: 0 0 12px; font-weight: 600; }
      .plans { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
      .plan { padding: 22px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); display: flex; flex-direction: column; }
      .plan h4 { margin: 0 0 8px; font-size: 1.1rem; }
      .plan .price { font-size: 1.6rem; font-weight: 700; margin: 0 0 14px; }
      .plan .price span { font-size: .85rem; font-weight: 400; color: var(--muted); margin-left: 4px; }
      .plan ul { list-style: none; padding: 0; margin: 0 0 18px; flex: 1; }
      .plan li { color: var(--muted); font-size: .92rem; padding: 3px 0 3px 16px; position: relative; }
      .plan li::before { content: "✓"; position: absolute; left: 0; color: var(--accent); }
      .plan-cta { text-align: center; padding: 9px 14px; border: 1px solid var(--line); border-radius: 9px; text-decoration: none; font-size: .92rem; }
      .plan-cta:hover { border-color: var(--accent); }
      .muted { color: var(--muted); }
      footer { color: var(--muted); font-size: .85rem; padding: 28px 0 40px; border-top: 1px solid var(--line); }
    </style>
  </head>
  <body>
    <div class="wrap">
      <header class="top">
        <span class="brand">DevBelt</span>
        <span class="spacer"></span>
        <nav>
          <a href="#tools">工具</a>
          <a href="#pricing">套餐</a>
          <a href="/login">登录</a>
          <a href="/register">注册</a>
        </nav>
      </header>

      <div class="hero">
        <h1>开发者工具套件</h1>
        <p>DevBelt 把数据库客户端、Web 控制台与端到端加密同步整合在一起：本地管理连接与查询，跨设备安全同步，组织内共享资源，运营侧统一治理。</p>
        <div class="cta">
          <a class="btn primary" href="/register">免费开始</a>
          <a class="btn ghost" href="/login">已有账户，登录</a>
        </div>
      </div>

      <section id="tools">
        <h2>工具</h2>
        <p class="section-sub">已发布与开发中的工具，更多陆续添加。</p>
        <div class="grid">
          ${TOOLS.map(toolCard).join('\n          ')}
        </div>
      </section>

      <section id="pricing">
        <h2>套餐</h2>
        <p class="section-sub">个人与组织两档，按需选择；配额与引擎范围见各档说明。</p>
        ${pricing}
      </section>

      

      <footer>DevBelt · 开发者工具套件</footer>
    </div>
  </body>
</html>`;
}