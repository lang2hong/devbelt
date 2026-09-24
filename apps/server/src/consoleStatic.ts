import { existsSync, readFileSync } from 'fs';
import path from 'path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { renderHome, renderPlansPage, type HomePlan } from './home.js';
import { renderDocsIndex, renderDocPage } from './docs.js';

/** 公开页/邮件入口/控制台壳的严格 CSP（无第三方、无 eval，只放行构建产物）。 */
// P6-S5b：/db 控制台需在浏览器执行 Argon2id WASM（Web Worker）。放行 wasm-unsafe-eval
// 与 worker-src 'self'；不放开 img-src，也不允许内联/远程脚本。
const PUBLIC_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; worker-src 'self'; base-uri 'none'; " +
  "frame-ancestors 'none'; form-action 'self'; object-src 'none'";

/** 身份页（auth-ui）dist：站点根，`/login`、`/register`、`/verify-email`。 */
function authDistDir(): string {
  return process.env.DEVBELT_DB_AUTH_DIST_DIR || path.resolve(process.cwd(), '../auth-ui/dist');
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
 * 前端静态托管（P2）。
 *
 * 两个构建产物同源托管：
 *   - auth-ui（base `/`）：根身份页 `/login`、`/register`、`/verify-email`，
 *     资源在 `/assets/*`。
 *   - db-ui（base `/db/`）：`/db/` 控制台 SPA（未知子路径回落壳，带扩展名者除外），
 *     `/db/sync-reset` 邮件落地页，资源在 `/db/assets/*`。
 * `/` 暂 302 到 `/login`（P3 换套件首页）。HTML 均 `no-store` + 严格 CSP；
 * hash 资源 immutable 一年缓存；`/api/*` 由 Fastify 显式路由优先。
 */
export interface ConsoleStaticOptions {
  /** 套件首页的套餐数据来源（由组合根注入；缺省则首页不含套餐区）。 */
  getHomePlans?: () => Promise<HomePlan[]>;
  /** 首页登录态判定（由组合根按 refresh cookie 注入；缺省视为未登录）。 */
  isLoggedIn?: (req: FastifyRequest) => Promise<boolean>;
}

export async function registerConsoleStatic(app: FastifyInstance, opts: ConsoleStaticOptions = {}): Promise<void> {
  const authDist = authDistDir();
  const consoleDist = consoleDistDir();
  const adminDist = adminDistDir();
  const authReady = existsSync(authDist);
  const consoleReady = existsSync(consoleDist);
  const adminReady = existsSync(adminDist);

  if (!authReady) app.log.warn(`[static] auth-ui dist not found at ${authDist}; identity pages unavailable`);
  if (!consoleReady) app.log.warn(`[static] db-ui dist not found at ${consoleDist}; console unavailable`);
  if (!adminReady) app.log.warn(`[static] admin-ui dist not found at ${adminDist}; admin console unavailable`);

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

  function sendHtml(reply: FastifyReply, html: string): void {
    reply
      .header('Cache-Control', 'no-store')
      .header('Content-Security-Policy', PUBLIC_CSP)
      .type('text/html')
      .send(html);
  }

  function serveHtml(html: string | null) {
    return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (html == null) return notFound(req, reply);
      sendHtml(reply, html);
    };
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

  /** 公开页（首页/套餐/文档）共用的登录态判定；失败按未登录处理，不阻断渲染。 */
  async function loadLoggedIn(req: FastifyRequest): Promise<boolean> {
    if (!opts.isLoggedIn) return false;
    try {
      return await opts.isLoggedIn(req);
    } catch (err) {
      app.log.warn(`[home] session check failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // 身份页（auth-ui，根路径）
  const authEntries: Array<[string, string]> = [
    ['/verify-email', 'verify-email.html'],
    ['/login', 'login.html'],
    ['/register', 'register.html'],
  ];
  for (const [route, file] of authEntries) {
    app.get(route, serveHtml(authReady ? readHtml(authDist, file) : null));
  }

  // 套件首页（套餐为服务端渲染；数据源失败时降级为不含套餐的页面）
  app.get('/', async (req, reply) => {
    sendHtml(reply, renderHome({ loggedIn: await loadLoggedIn(req) }));
  });

  // 公开套餐页（/plans，无需登录）
  app.get('/plans', async (req, reply) => {
    const [plans, loggedIn] = await Promise.all([loadHomePlans(), loadLoggedIn(req)]);
    sendHtml(reply, renderPlansPage(plans, { loggedIn }));
  });

  // 公开文档中心（/db/docs，无需登录）。注册为静态路由，优先于下方 /db/* SPA fallback。
  app.get('/db/docs', async (req, reply) => {
    sendHtml(reply, renderDocsIndex({ loggedIn: await loadLoggedIn(req) }));
  });
  app.get('/db/docs/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const html = renderDocPage(slug, { loggedIn: await loadLoggedIn(req) });
    if (html == null) return notFound(req, reply);
    sendHtml(reply, html);
  });

  // 控制台（db-ui，`/db` 前缀）
  const shellHtml = consoleReady ? readHtml(consoleDist, 'index.html') : null;
  const syncResetHtml = consoleReady ? readHtml(consoleDist, 'sync-reset.html') : null;

  app.get('/db', async (_req, reply) => {
    reply.redirect('/db/');
  });
  app.get('/db/', serveHtml(shellHtml));
  app.get('/db/sync-reset', serveHtml(syncResetHtml));

  // SPA fallback：客户端路由。带扩展名的路径不落 fallback（避免把不存在的静态资源当页面）。
  app.get('/db/*', async (req, reply) => {
    const url = (req.url ?? '').split('?')[0];
    const rel = url.replace(/^\/db\/?/, '');
    if (/\.[A-Za-z0-9]+$/.test(rel)) {
      return notFound(req, reply);
    }
    return serveHtml(shellHtml)(req, reply);
  });

  // 平台后台（admin-ui，`/admin` 前缀）
  const adminShell = adminReady ? readHtml(adminDist, 'index.html') : null;
  app.get('/admin', async (_req, reply) => {
    reply.redirect('/admin/');
  });
  app.get('/admin/', serveHtml(adminShell));
  app.get('/admin/*', async (req, reply) => {
    const url = (req.url ?? '').split('?')[0];
    const rel = url.replace(/^\/admin\/?/, '');
    if (/\.[A-Za-z0-9]+$/.test(rel)) {
      return notFound(req, reply);
    }
    return serveHtml(adminShell)(req, reply);
  });
}