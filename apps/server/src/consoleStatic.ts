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

  async function serveSiteShell(req: FastifyRequest, reply: FastifyReply, injectState = true): Promise<void> {
    if (siteShellRaw == null) return notFound(req, reply);
    if (!injectState) return serveHtml(siteShellRaw)(req, reply);
    const loggedIn = await loadLoggedIn(req);
    const nonce = newNonce();
    const html = injectInitialState(
      siteShellRaw
        // index.html 默认 lang="zh-CN"；/en 路径下客户端 vue-router 会切到英文并改 documentElement.lang，
        // 这里额外服务端替换 lang 属性，避免首屏 flash。
        .replace('<html lang="zh-CN">', req.url === '/en' ? '<html lang="en">' : '<html lang="zh-CN">'),
      { loggedIn },
      nonce,
    );
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

  // db-ui SPA fallback 通过 setNotFoundHandler 统一处理，避免和根 site fallback 抢 `/*`。

  // ---------- 平台后台（admin-ui，`/admin` 前缀） ----------
  const adminShell = adminReady ? readHtml(adminDist, 'index.html') : null;
  app.get('/admin', async (_req, reply) => {
    reply.redirect('/admin/');
  });
  app.get('/admin/', serveHtml(adminShell));
  // admin-ui SPA fallback 通过 setNotFoundHandler 统一处理。

  // ---------- 统一 SPA / 资源 404 兜底 ----------
  //
  // 优先级（fastify 静态路由已先匹配）：
  //   1. `/db/**`（除已注册的 /db/、/db/docs、/db/sync-reset、/db/assets/*） → db-ui shell 或 404
  //   2. `/admin/**`（除已注册的 /admin/、/admin/assets/*） → admin-ui shell 或 404
  //   3. `/api/**` → 交由上层路由处理；到这里说明没有匹配，返回 404
  //   4. 其他根路径：带扩展名 → 404；不带扩展名 → site SPA shell（客户端路由决定 404/渲染）
  app.setNotFoundHandler(async (req, reply) => {
    const url = (req.url ?? '').split('?')[0];
    const last = url.split('/').pop() ?? '';
    const hasExt = last.includes('.') && !last.endsWith('/');

    if (url.startsWith('/db/')) {
      if (hasExt || !shellHtml) return notFound(req, reply);
      return serveHtml(shellHtml, DB_CSP)(req, reply);
    }
    if (url.startsWith('/admin/')) {
      if (hasExt || !adminShell) return notFound(req, reply);
      return serveHtml(adminShell)(req, reply);
    }
    if (url.startsWith('/api/')) {
      return notFound(req, reply);
    }
    if (hasExt || !siteShellRaw) return notFound(req, reply);
    return serveSiteShell(req, reply, false);
  });
}
