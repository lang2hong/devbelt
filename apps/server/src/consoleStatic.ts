import { randomBytes } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { renderPlansPage, type HomePlan } from './home.js';
import { renderDocsIndex, renderDocPage } from './docs.js';

/**
 * CSP for public pages / site SPA / auth UI.
 *
 * - self-bundled scripts and styles from /assets/site, /assets (auth-ui), /db/assets, /admin/assets
 * - inline <style> is allowed in the plans/docs SSR pages (style-src 'unsafe-inline')
 * - one inline bootstrap script carries the per-request nonce so the server can inject
 *   `window.__INITIAL_STATE__` without widening script-src to 'unsafe-inline'
 * - images only from this origin + data: URIs (the landing site ships screenshots locally)
 */
export const BASE_CSP =
  "default-src 'self'; " +
  "script-src 'self' 'nonce-%NONCE%'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; base-uri 'none'; " +
  "frame-ancestors 'none'; form-action 'self'; object-src 'none'";

// P6-S5b：仅 db-ui 控制台（`/db/*`）需在浏览器执行 Argon2id WASM（Web Worker）。
// 控制台 shell 里也可能引用文档页内嵌 SVG / data URL；img-src 保持和首页一致。
export const DB_CSP =
  "default-src 'self'; " +
  "script-src 'self' 'nonce-%NONCE%' 'wasm-unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; worker-src 'self'; base-uri 'none'; " +
  "frame-ancestors 'none'; form-action 'self'; object-src 'none'";

/** 身份页（auth-ui）dist：站点根，`/login`、`/register`、`/verify-email`。 */
function authDistDir(): string {
  return process.env.DEVBELT_DB_AUTH_DIST_DIR || path.resolve(process.cwd(), '../auth-ui/dist');
}

/** DevBelt 官网（site）dist：站点根 `/` 的 SPA 落地页。 */
function siteDistDir(): string {
  return process.env.DEVBELT_SITE_DIST_DIR || path.resolve(process.cwd(), '../site/dist');
}

/** DB 控制台（db-ui）dist：`/db/` 下的 SPA 与 `/db/sync-reset`。 */
function consoleDistDir(): string {
  return process.env.DEVBELT_DB_CONSOLE_DIST_DIR || path.resolve(process.cwd(), '../db-ui/dist');
}

/** 平台后台（admin-ui）dist：`/admin/` 下的 SPA。 */
function adminDistDir(): string {
  return process.env.DEVBELT_DB_ADMIN_DIST_DIR || path.resolve(process.cwd(), '../admin-ui/dist');
}

function notFound(_req: FastifyRequest, reply: FastifyReply): void {
  reply.code(404).type('text/plain').send('not found');
}

/**
 * 前端静态托管。
 *
 * 同源托管四个 SPA + 静态资源：
 *   - site（base `/`）：产品官网（`/`、`/en` 等），资源在 `/assets/site/`，截图在 `/screenshots/`。
 *   - auth-ui（base `/`）：身份页 `/login`、`/register`、`/verify-email`，资源在 `/assets/`。
 *   - db-ui（base `/db/`）：控制台 SPA，资源在 `/db/assets/`。
 *   - admin-ui（base `/admin/`）：后台 SPA，资源在 `/admin/assets/`。
 *
 * HTML 均 no-store + 严格 CSP；hash 资源 immutable 一年缓存；`/api/*` 由 Fastify
 * 显式路由优先。首页/套餐/文档页由服务端注入登录态或直接 SSR。
 */
export interface ConsoleStaticOptions {
  /** 套餐数据来源（由组合根注入；缺省则套餐页降级）。 */
  getHomePlans?: () => Promise<HomePlan[]>;
  /** 登录态判定（由组合根按 refresh cookie 注入；缺省视为未登录）。 */
  isLoggedIn?: (req: FastifyRequest) => Promise<boolean>;
}

export async function registerConsoleStatic(app: FastifyInstance, opts: ConsoleStaticOptions = {}): Promise<void> {
  const authDist = authDistDir();
  const siteDist = siteDistDir();
  const consoleDist = consoleDistDir();
  const adminDist = adminDistDir();
  const authReady = existsSync(authDist);
  const siteReady = existsSync(siteDist);
  const consoleReady = existsSync(consoleDist);
  const adminReady = existsSync(adminDist);

  if (!authReady) app.log.warn(`[static] auth-ui dist not found at ${authDist}; identity pages unavailable`);
  if (!siteReady) app.log.warn(`[static] site dist not found at ${siteDist}; marketing homepage unavailable`);
  if (!consoleReady) app.log.warn(`[static] db-ui dist not found at ${consoleDist}; console unavailable`);
  if (!adminReady) app.log.warn(`[static] admin-ui dist not found at ${adminDist}; admin console unavailable`);

  // Hashed static assets (immutable, one-year cache)
  if (authReady) {
    await app.register(fastifyStatic, {
      root: path.join(authDist, 'assets'),
      prefix: '/assets/',
      decorateReply: false,
      index: false,
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    });
  }
  if (siteReady) {
    // site 自己打包出的 JS/CSS 放在 /assets/site/ 子路径，避开 auth-ui 的 /assets/* 冲突
    await app.register(fastifyStatic, {
      root: path.join(siteDist, 'assets', 'site'),
      prefix: '/assets/site/',
      decorateReply: false,
      index: false,
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    });
    // site public/ 下的静态资源（screenshots、icon、logo）直接挂在根
    await app.register(fastifyStatic, {
      root: siteDist,
      prefix: '/',
      decorateReply: false,
      index: false,
      allowedPath: (p) => p.startsWith('/screenshots/') || p === '/icon.png' || p === '/logo.svg' || p === '/favicon.ico',
      setHeaders: (res, _reqPath) => {
        res.setHeader('Cache-Control', 'public, max-age=86400');
      },
    });
  }
  if (consoleReady) {
    await app.register(fastifyStatic, {
      root: path.join(consoleDist, 'assets'),
      prefix: '/db/assets/',
      decorateReply: false,
      index: false,
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    });
  }
  if (adminReady) {
    await app.register(fastifyStatic, {
      root: path.join(adminDist, 'assets'),
      prefix: '/admin/assets/',
      decorateReply: false,
      index: false,
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    });
  }

  function readHtml(dist: string, name: string): string | null {
    try {
      return readFileSync(path.join(dist, name), 'utf8');
    } catch {
      app.log.warn(`[static] ${name} missing in ${dist}`);
      return null;
    }
  }

  function newNonce(): string {
    return randomBytes(16).toString('base64');
  }

  function applyCspNonce(csp: string, nonce: string): string {
    return csp.replace(/%NONCE%/g, nonce);
  }

  function sendHtml(reply: FastifyReply, html: string, csp: string = BASE_CSP): void {
    const nonce = newNonce();
    reply
      .header('Cache-Control', 'no-store')
      .header('Content-Security-Policy', applyCspNonce(csp, nonce))
      .type('text/html')
      .send(html.replace(/%NONCE%/g, nonce));
  }

  function serveHtml(html: string | null, csp: string = BASE_CSP) {
    return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (html == null) return notFound(req, reply);
      sendHtml(reply, html, csp);
    };
  }

  /** 把 `<!--INITIAL_STATE-->` 替换成带 nonce 的 bootstrap inline script。 */
  function injectInitialState(shell: string, state: { loggedIn: boolean }, nonce: string): string {
    const json = JSON.stringify(state);
    const bootstrap = `<script nonce="${nonce}">window.__INITIAL_STATE__=${json};</script>`;
    return shell.replace('<!--INITIAL_STATE-->', bootstrap);
  }

  /** 首页/套餐页共用的套餐数据源（失败降级为不含套餐）。 */
  async function loadHomePlans(): Promise<HomePlan[] | null> {
    if (!opts.getHomePlans) return null;
    try {
      return await opts.getHomePlans();
    } catch (err) {
      app.log.warn(`[home] plan catalog unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** 公开页共用的登录态判定；失败按未登录处理，不阻断渲染。 */
  async function loadLoggedIn(req: FastifyRequest): Promise<boolean> {
    if (!opts.isLoggedIn) return false;
    try {
      return await opts.isLoggedIn(req);
    } catch (err) {
      app.log.warn(`[home] session check failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // ---------- 身份页（auth-ui，根路径） ----------
  const authEntries: Array<[string, string]> = [
    ['/verify-email', 'verify-email.html'],
    ['/login', 'login.html'],
    ['/register', 'register.html'],
  ];
  for (const [route, file] of authEntries) {
    app.get(route, serveHtml(authReady ? readHtml(authDist, file) : null));
  }

  // ---------- 官网 SPA（site，根路径） ----------
  //
  // index.html 在两处被发送：
  //   - 直接访问 `/` 或 `/en`：服务端注入 __INITIAL_STATE__.loggedIn 再返回
  //   - SPA fallback：其他合法客户端路径（带扩展名则视为静态资源走 404）
  const siteShellRaw = siteReady ? readHtml(siteDist, 'index.html') : null;

  const SITE_SEO = {
    zh: {
      lang: 'zh-CN',
      title: 'DevBelt — 在 VS Code 内完成数据库开发',
      description:
        'DevBelt 是一款 VS Code 扩展，把 MySQL、PostgreSQL、SQLite、Redis、Elasticsearch、AI 助手和数据监控整合在同一个编辑器内。',
      locale: 'zh_CN',
    },
    en: {
      lang: 'en',
      title: 'DevBelt — Database development inside VS Code',
      description:
        'DevBelt is a VS Code extension that brings MySQL, PostgreSQL, SQLite, Redis, Elasticsearch, an AI assistant, and data monitoring into one editor.',
      locale: 'en_US',
    },
  } as const;

  function escAttr(input: string): string {
    return input
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * 首屏绝对 URL：优先反向代理转发头（生产 nginx），否则回落到请求自身。
   * OG / Twitter 卡片要求绝对地址，不能写相对路径。
   */
  function originOf(req: FastifyRequest): string {
    const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'http').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost');
    return `${proto}://${host}`;
  }

  /** 生成 title/description/OG/Twitter 卡片（替换 index.html 的 `<!--SEO_META-->`）。 */
  function seoMeta(lang: 'zh' | 'en', req: FastifyRequest, path: string): string {
    const seo = SITE_SEO[lang];
    const origin = originOf(req);
    const url = `${origin}${path}`;
    const image = `${origin}/screenshots/01-sql-workbench.png`;
    const t = escAttr(seo.title);
    const d = escAttr(seo.description);
    return `<title>${t}</title>
    <meta name="description" content="${d}" />
    <meta name="theme-color" content="#0b1020" />
    <link rel="canonical" href="${escAttr(url)}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="DevBelt" />
    <meta property="og:title" content="${t}" />
    <meta property="og:description" content="${d}" />
    <meta property="og:url" content="${escAttr(url)}" />
    <meta property="og:image" content="${escAttr(image)}" />
    <meta property="og:locale" content="${seo.locale}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${t}" />
    <meta name="twitter:description" content="${d}" />
    <meta name="twitter:image" content="${escAttr(image)}" />`;
  }

  /** 按访问路径决定语言（`/en` 前缀为英文，其余中文）。 */
  function langOf(url: string): 'zh' | 'en' {
    return url === '/en' || url.startsWith('/en/') || url.startsWith('/en?') ? 'en' : 'zh';
  }

  async function serveSiteShell(req: FastifyRequest, reply: FastifyReply, injectState = true): Promise<void> {
    if (siteShellRaw == null) return notFound(req, reply);
    const url = (req.url ?? '/').split('?')[0];
    const lang = langOf(req.url ?? '/');
    const seo = SITE_SEO[lang];
    // 服务端补 SEO meta + lang，避免首屏英文标题/无分享卡片；客户端挂载后仍会按路由校正。
    const shell = siteShellRaw
      .replace('<!--SEO_META-->', seoMeta(lang, req, url))
      .replace('<html lang="zh-CN">', `<html lang="${seo.lang}">`);
    if (!injectState) return serveHtml(shell)(req, reply);
    const loggedIn = await loadLoggedIn(req);
    const nonce = newNonce();
    const html = injectInitialState(shell, { loggedIn }, nonce);
    reply
      .header('Cache-Control', 'no-store')
      .header('Content-Security-Policy', applyCspNonce(BASE_CSP, nonce))
      .type('text/html')
      .send(html);
  }

  app.get('/', (req, reply) => serveSiteShell(req, reply));
  app.get('/en', (req, reply) => serveSiteShell(req, reply));

  // ---------- 公开套餐页（SSR，仍由 home.ts 直接输出 HTML） ----------
  app.get('/plans', async (req, reply) => {
    const [plans, loggedIn] = await Promise.all([loadHomePlans(), loadLoggedIn(req)]);
    sendHtml(reply, renderPlansPage(plans, { loggedIn }));
  });

  // ---------- 公开文档中心（SSR，/db/docs） ----------
  app.get('/db/docs', async (req, reply) => {
    sendHtml(reply, renderDocsIndex({ loggedIn: await loadLoggedIn(req) }));
  });
  app.get('/db/docs/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const html = renderDocPage(slug, { loggedIn: await loadLoggedIn(req) });
    if (html == null) return notFound(req, reply);
    sendHtml(reply, html);
  });

  // ---------- 控制台（db-ui，`/db` 前缀） ----------
  const shellHtml = consoleReady ? readHtml(consoleDist, 'index.html') : null;
  const syncResetHtml = consoleReady ? readHtml(consoleDist, 'sync-reset.html') : null;

  app.get('/db', async (_req, reply) => {
    reply.redirect('/db/');
  });
  app.get('/db/', serveHtml(shellHtml, DB_CSP));
  app.get('/db/sync-reset', serveHtml(syncResetHtml, DB_CSP));

  // ---------- 平台后台（admin-ui，`/admin` 前缀） ----------
  const adminShell = adminReady ? readHtml(adminDist, 'index.html') : null;
  app.get('/admin', async (_req, reply) => {
    reply.redirect('/admin/');
  });
  app.get('/admin/', serveHtml(adminShell));

  // ---------- SPA fallback：在各自 prefix 下用封装插件注册 wildcard，避免 fastify 5 禁止同级多 wildcard ----------
  //
  // fastify 5 不允许在同一 prefix 上重复声明 wildcard（例如同时 `GET /*` 和 `GET /db/*`），
  // 这里用 fastify 的封装作用域 + prefix 分别注册。显式路由（`/db/`、`/db/sync-reset` 等）
  // 已经在上面注册，不会被 wildcard 吞掉。
  await app.register(
    async (api) => {
      api.get('/*', async (req, reply) => {
        const url = (req.url ?? '').split('?')[0];
        const rel = url.replace(/^\/db\/?/, '');
        if (/\.[A-Za-z0-9]+$/.test(rel) || !shellHtml) return notFound(req, reply);
        return serveHtml(shellHtml, DB_CSP)(req, reply);
      });
    },
    { prefix: '/db' },
  );
  await app.register(
    async (api) => {
      api.get('/*', async (req, reply) => {
        const url = (req.url ?? '').split('?')[0];
        const rel = url.replace(/^\/admin\/?/, '');
        if (/\.[A-Za-z0-9]+$/.test(rel) || !adminShell) return notFound(req, reply);
        return serveHtml(adminShell)(req, reply);
      });
    },
    { prefix: '/admin' },
  );
  // 注：根 site SPA fallback（`/`、`/en`、客户端路由等无扩展名路径）通过
  // registerErrorHandler 的 setNotFoundHandler 挂载，该函数在 app 启动前已由 bootstrap 注册。
  // 这里把 handler 挂到 app[symbol] 上供 errorHandler 读取；避免再注册一个根 `/*`
  // 与 fastify 5 的 wildcard 限制冲突。
  (app as unknown as { __devbeltSpaFallback__?: (req: FastifyRequest, reply: FastifyReply) => Promise<void> }).__devbeltSpaFallback__ = async (req, reply) => {
    const url = (req.url ?? '').split('?')[0];
    if (url.startsWith('/api/')) return notFound(req, reply);
    const last = url.split('/').pop() ?? '';
    if (last.includes('.') && !last.endsWith('/')) return notFound(req, reply);
    return serveSiteShell(req, reply, false);
  };
}
