/**
 * 公开套餐页（`/plans`）SSR。
 *
 * - HomePlan/planCard 等工具函数供 Fastify 组合根注入套餐目录时使用；
 * - renderPlansPage 输出完整 HTML（复用品牌设计 token，保持暗色风格）；
 * - 产品官网（首页/英文页）已迁移到独立的 @devbelt/site 包（Vue 3 + Vite SPA），由 consoleStatic.ts 挂载在站点根。
 */

export interface HomePlan {
  code: string;
  name: string;
  kind: 'personal';
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
  if (plan.priceCents <= 0) return '免费';
  const yuan = plan.priceCents / 100;
  const amount = Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2);
  return `¥${amount}`;
}

function formatUnit(plan: HomePlan): string {
  if (plan.priceCents <= 0) return '';
  return plan.unit === 'seat-month' ? '/席·月' : '/月';
}

function planCard(plan: HomePlan): string {
  const highlights = plan.highlights.map((h) => `<li>${escapeHtml(h)}</li>`).join('');
  return `
        <article class="plan">
          <h4>${escapeHtml(plan.name)}</h4>
          <p class="price">${escapeHtml(formatPrice(plan))}<span>${escapeHtml(formatUnit(plan))}</span></p>
          <ul>${highlights}</ul>
          <a class="plan-cta" href="${plan.priceCents <= 0 ? '/register' : '/plans'}">${plan.priceCents <= 0 ? '免费开始' : '查看套餐'}</a>
        </article>`;
}

const CSS = `
  :root { color-scheme: dark; --bg:#0b1020; --bg2:#0e152a; --panel:#131a30; --panel2:#182040; --line:#232a44; --fg:#e6e9f2; --muted:#9aa4bf; --dim:#6b7596; --accent:#3d6bff; --accent2:#6b8bff; }
  * { box-sizing: border-box; }
  body { margin: 0; background: radial-gradient(1200px 600px at 80% -10%, rgba(61,107,255,.18), transparent 60%), var(--bg); color: var(--fg); font-family: -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei","Noto Sans SC","Source Han Sans SC","WenQuanYi Micro Hei",sans-serif; line-height:1.6; }
  a { color: inherit; text-decoration: none; }
  .wrap { max-width: 1040px; margin: 0 auto; padding: 0 24px; }
  header.top { position: sticky; top: 0; display: flex; align-items: center; gap:16px; padding:16px 0; background: rgba(11,16,32,.75); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); border-bottom: 1px solid var(--line); }
  header.top .brand { font-weight:700; font-size:1.1rem; display:flex; align-items:center; gap:8px; }
  .brand-dot { width:10px; height:10px; border-radius:3px; background:linear-gradient(135deg,var(--accent),var(--accent2)); }
  .spacer { flex:1; }
  header.top nav a { color:var(--muted); padding:6px 10px; border-radius:8px; font-size:.92rem; margin-left:4px; }
  header.top nav a:hover { color:var(--fg); background:var(--panel); }
  header.top nav .sep { display:inline-block; width:1px; height:18px; background:var(--line); margin:0 6px; vertical-align:middle; }
  main { padding:32px 0 56px; }
  h1 { font-size: clamp(1.6rem,3vw,2.1rem); margin:0 0 4px; letter-spacing:-0.02em; }
  .sub { color:var(--muted); margin:0 0 28px; max-width:640px; }
  .plans { display:grid; gap:14px; grid-template-columns: repeat(auto-fit, minmax(240px,1fr)); }
  .plan { padding:22px; border:1px solid var(--line); border-radius:14px; background:linear-gradient(180deg,var(--panel),var(--panel2)); display:flex; flex-direction:column; }
  .plan h4 { margin:0 0 8px; font-size:1.1rem; }
  .plan .price { font-size:1.6rem; font-weight:700; margin:0 0 14px; }
  .plan .price span { font-size:.85rem; font-weight:400; color:var(--muted); margin-left:4px; }
  .plan ul { list-style:none; padding:0; margin:0 0 18px; flex:1; }
  .plan li { color:var(--muted); font-size:.92rem; padding:3px 0 3px 16px; position:relative; }
  .plan li::before { content:"✓"; position:absolute; left:0; color:var(--accent); }
  .plan-cta { text-align:center; padding:10px 14px; border:1px solid var(--line); border-radius:9px; font-size:.92rem; color:var(--fg); }
  .plan-cta:hover { border-color:var(--accent); color:var(--accent2); }
  .muted { color: var(--muted); }
  footer { color:var(--dim); font-size:.82rem; }
  footer .legal { border-top:1px solid var(--line); padding:18px 0; margin-top:24px; display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px; }
`;

/**
 * 公开套餐页（`/plans`）：无需登录，服务端渲染套餐目录。
 * 套餐数据由 Fastify 组合根从 billing 套餐目录读取后传入；缺省时降级为提示。
 */
export function renderPlansPage(plans: HomePlan[] | null, opts: { loggedIn?: boolean } = {}): string {
  const personal = plans?.filter((p) => p.kind === 'personal') ?? [];
  const groups =
    personal.length > 0
      ? `<div class="plans">${personal.map(planCard).join('')}</div>`
      : `<p class="muted">套餐信息暂时不可用，请稍后再试。</p>`;
  const navAuth = opts.loggedIn
    ? `<a href="/db/">控制台</a>`
    : `<a href="/login">登录</a><a href="/register" style="color:#fff;background:var(--accent);">免费注册</a>`;

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>同步套餐 · DevBelt</title>
    <meta name="description" content="DevBelt 同步服务个人套餐。连接与查询在本机端到端加密后同步到云端，服务端只保存密文。" />
    <style>${CSS}</style>
  </head>
  <body>
    <div class="wrap">
      <header class="top">
        <a class="brand" href="/"><span class="brand-dot"></span>DevBelt</a>
        <span class="spacer"></span>
        <nav>
          <a href="/">首页</a>
          <a href="/db/docs">文档</a>
          <a href="/plans">套餐</a>
          <span class="sep"></span>
          ${navAuth}
        </nav>
      </header>
      <main>
        <h1>同步套餐</h1>
        <p class="sub">按需选择；连接与查询在本机端到端加密后同步到云端，服务端只保存密文。配额与引擎范围见各档说明。</p>
        ${groups}
      </main>
      <footer>
        <div class="legal">
          <span>© DevBelt · MIT 许可 · v0.4.0</span>
          <span><a href="/">首页</a></span>
        </div>
      </footer>
    </div>
  </body>
</html>`;
}
