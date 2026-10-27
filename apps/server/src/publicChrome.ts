/**
 * 公开页共享外壳（header / footer / 设计 token）。
 *
 * 服务端渲染的文档中心与套餐页共用这一份，保证与 apps/site（首页 SPA）视觉一致：
 * 相同的品牌圆点、导航顺序（安装 · 文档 · GitHub · 功能 · 套餐 | 语言 | 登录/控制台）、
 * 四列页脚与颜色变量。修改这里会同时影响文档与套餐页。
 */

export interface ChromeOptions {
  /** 是否已登录（由服务端按 refresh cookie 判定）。 */
  loggedIn?: boolean;
  /** 当前页高亮项。 */
  active?: 'docs' | 'plans' | null;
}

const EXTERNAL = {
  github: 'https://github.com/lang2hong/devbelt',
  changelog: 'https://github.com/lang2hong/devbelt/blob/main/CHANGELOG.md',
  marketplace: 'https://marketplace.visualstudio.com/items?itemName=lang2hong.devbelt-db-client',
  ovsx: 'https://open-vsx.org/extension/lang2hong/devbelt-db-client',
} as const;

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 设计 token + 基础排版 + wrap 容器（页面正文样式各自追加）。 */
export const PUBLIC_CSS = `
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
      body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; background:
          radial-gradient(1200px 600px at 80% -10%, rgba(61,107,255,.18), transparent 60%),
          radial-gradient(900px 500px at -10% 20%, rgba(58,210,154,.10), transparent 60%),
          var(--bg);
        color: var(--fg); font-family: var(--font-sans); line-height: 1.7; -webkit-font-smoothing: antialiased; }
      body > main { flex: 1 0 auto; }
      a { color: var(--accent2); text-decoration: none; }
      a:hover { text-decoration: underline; }
      .wrap { max-width: 1120px; margin: 0 auto; padding: 0 24px; }
      .brand-dot { width: 10px; height: 10px; border-radius: 3px;
        background: linear-gradient(135deg, var(--accent), var(--accent2)); flex-shrink: 0; }
`;

/** header：与 apps/site 的 NavHeader.vue 同款结构/顺序/尺寸。 */
const HEADER_CSS = `
      header.top { position: sticky; top: 0; z-index: 20; background: rgba(11,16,32,.75);
        -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); border-bottom: 1px solid var(--line); }
      header.top .inner { display: flex; align-items: center; gap: 16px; padding: 16px 24px; }
      header.top .brand { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 1.1rem;
        letter-spacing: -0.01em; color: var(--fg); }
      header.top .brand:hover { text-decoration: none; }
      header.top .spacer { flex: 1; }
      header.top nav { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
      header.top nav a, header.top nav .lang { color: var(--muted); padding: 6px 10px; border-radius: 8px;
        font-size: .92rem; background: transparent; border: 0; font-family: inherit; }
      header.top nav a:hover, header.top nav .lang:hover { color: var(--fg); background: var(--panel); text-decoration: none; }
      header.top nav a.primary-link { color: var(--accent2); font-weight: 600; }
      header.top nav a.primary-link:hover { color: #fff; background: var(--accent); }
      header.top nav a.on { color: var(--fg); background: var(--panel); }
      header.top nav a.cta { color: #fff; background: var(--accent); }
      header.top nav a.cta:hover { background: var(--accent2); }
      header.top nav .lang { border: 1px solid var(--line); padding: 5px 10px; cursor: pointer; }
      header.top nav .sep { width: 1px; height: 18px; background: var(--line); margin: 0 6px; }
      @media (max-width: 860px) {
        header.top nav a, header.top nav .lang { padding: 5px 8px; font-size: .86rem; }
        header.top nav .sep { display: none; }
      }
      @media (max-width: 600px) {
        header.top .inner { padding-left: 18px; padding-right: 18px; }
      }
`;

/** footer：与 apps/site 的 SiteFooter.vue 同款四列结构。 */
const FOOTER_CSS = `
      footer.site-footer { color: var(--muted); font-size: .88rem; padding: 36px 0 48px;
        border-top: 1px solid var(--line); margin-top: 32px; }
      footer.site-footer .fgrid { display: flex; flex-wrap: wrap; gap: 24px 48px;
        justify-content: space-between; align-items: flex-start; }
      footer.site-footer .brand-col { min-width: 240px; flex: 1 1 280px; }
      footer.site-footer .brand { font-weight: 700; font-size: 1.05rem; color: var(--fg);
        margin-bottom: 6px; display: flex; align-items: center; gap: 8px; }
      footer.site-footer .tagline { margin: 4px 0 0; color: var(--dim); font-size: .86rem; max-width: 320px; }
      footer.site-footer .ver { font-size: .78rem; color: var(--dim); margin-top: 10px; }
      footer.site-footer h5 { margin: 0 0 8px; color: var(--dim); font-size: .8rem; text-transform: uppercase;
        letter-spacing: .08em; font-weight: 600; }
      footer.site-footer ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
      footer.site-footer ul a { color: var(--muted); font-size: .88rem; }
      footer.site-footer ul a:hover { color: var(--fg); text-decoration: none; }
      footer.site-footer .legal { width: 100%; border-top: 1px solid var(--line); padding-top: 18px;
        margin-top: 24px; font-size: .82rem; color: var(--dim);
        display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
`;

export const CHROME_CSS = HEADER_CSS + FOOTER_CSS;

/**
 * 顶部导航。顺序（与首页一致）：安装 · 文档 · GitHub · 功能 · 套餐 | 语言 | 登录 / 控制台。
 * 安装/功能是首页锚点；文档/套餐是站内页面；GitHub 新窗口打开。
 */
export function renderPublicHeader(opts: ChromeOptions = {}): string {
  const active = opts.active ?? null;
  const auth = opts.loggedIn
    ? `<a class="cta" href="/db/">控制台</a>`
    : `<a href="/login">登录</a>`;
  const on = (id: 'docs' | 'plans') => (active === id ? ' class="on"' : '');
  return `<header class="top">
      <div class="wrap inner">
        <a class="brand" href="/"><span class="brand-dot"></span>DevBelt</a>
        <span class="spacer"></span>
        <nav>
          <a class="primary-link" href="/#install">安装</a>
          <a href="/db/docs"${on('docs')}>文档</a>
          <a href="${EXTERNAL.github}" target="_blank" rel="noopener noreferrer">GitHub</a>
          <a href="/#features">功能</a>
          <a href="/plans"${on('plans')}>套餐</a>
          <span class="sep"></span>
          <a class="lang" href="/en">English</a>
          <span class="sep"></span>
          ${auth}
        </nav>
      </div>
    </header>`;
}

/** 四列页脚（产品 / 资源 / 下载 + 版权）。 */
export function renderPublicFooter(): string {
  return `<footer class="site-footer">
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
              <li><a href="/#install">安装</a></li>
              <li><a href="/plans">套餐</a></li>
            </ul>
          </div>
          <div>
            <h5>资源</h5>
            <ul>
              <li><a href="/db/docs">文档</a></li>
              <li><a href="${EXTERNAL.changelog}" target="_blank" rel="noopener noreferrer">更新日志</a></li>
              <li><a href="${EXTERNAL.github}" target="_blank" rel="noopener noreferrer">GitHub 仓库</a></li>
            </ul>
          </div>
          <div>
            <h5>下载</h5>
            <ul>
              <li><a href="${EXTERNAL.marketplace}" target="_blank" rel="noopener noreferrer">VS Code Marketplace</a></li>
              <li><a href="${EXTERNAL.ovsx}" target="_blank" rel="noopener noreferrer">Open VSX</a></li>
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

/** 完整 HTML 文档骨架（title/description/CSS + header + body + footer）。 */
export function renderPublicPage(input: {
  title: string;
  description: string;
  body: string;
  css?: string;
  chrome?: ChromeOptions;
}): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(input.title)}</title>
    <meta name="description" content="${escapeHtml(input.description)}" />
    <meta name="theme-color" content="#0b1020" />
    <style>${PUBLIC_CSS}${CHROME_CSS}${input.css ?? ''}</style>
  </head>
  <body>
    ${renderPublicHeader(input.chrome ?? {})}
    ${input.body}
    ${renderPublicFooter()}
  </body>
</html>`;
}