import { existsSync, readFileSync } from 'fs';
import path from 'path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';

/** 公开页/邮件入口/控制台壳的严格 CSP（无第三方、无 eval，只放行构建产物）。 */
const PUBLIC_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; base-uri 'none'; " +
  "frame-ancestors 'none'; form-action 'self'; object-src 'none'";

function consoleDistDir(): string {
  return process.env.CONSOLE_DIST_DIR || path.resolve(process.cwd(), '../db-ui/dist');
}

function notFound(_req: FastifyRequest, reply: FastifyReply): void {
  reply.code(404).type('text/plain').send('not found');
}

/**
 * 控制台静态托管（P3 §8，切片 3 完整形态）。
 *
 * 路由优先级：`/api/*`（Fastify 显式路由自然优先）→ 公开/邮件页 → 已存在静态资源
 * （/assets/*）→ `/console/*` SPA fallback → 其余 404。`/console` 恒 302 `/console/`。
 * 带文件扩展名的不存在路径不落 SPA fallback。HTML 均 `no-store` + 严格 CSP；
 * hash 静态资源 immutable 一年缓存。
 */
export async function registerConsoleStatic(app: FastifyInstance): Promise<void> {
  const dist = consoleDistDir();

  if (!existsSync(dist)) {
    app.log.warn(`[console] db-ui dist not found at ${dist}; public pages unavailable`);
    app.get('/verify-email', notFound);
    app.get('/login', notFound);
    app.get('/register', notFound);
    app.get('/accept-invitation', notFound);
    app.get('/sync-reset', notFound);
    app.get('/', notFound);
    app.get('/console/*', notFound);
    return;
  }

  await app.register(fastifyStatic, {
    root: path.join(dist, 'assets'),
    prefix: '/assets/',
    decorateReply: false,
    index: false,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  });

  function readHtml(name: string): string | null {
    try {
      return readFileSync(path.join(dist, name), 'utf8');
    } catch {
      app.log.warn(`[console] ${name} missing in ${dist}`);
      return null;
    }
  }

  function serveHtml(html: string | null) {
    return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (html == null) return notFound(req, reply);
      reply
        .header('Cache-Control', 'no-store')
        .header('Content-Security-Policy', PUBLIC_CSP)
        .type('text/html')
        .send(html);
    };
  }

  const entries: Array<[string, string]> = [
    ['/verify-email', 'verify-email.html'],
    ['/login', 'login.html'],
    ['/register', 'register.html'],
    ['/accept-invitation', 'accept-invitation.html'],
    ['/sync-reset', 'sync-reset.html'],
    ['/', 'index.html'],
  ];
  for (const [route, file] of entries) {
    app.get(route, serveHtml(readHtml(file)));
  }

  const shellHtml = readHtml('index.html');

  app.get('/console', async (_req, reply) => {
    reply.redirect('/console/');
  });

  app.get('/console/', serveHtml(shellHtml));

  // SPA fallback：客户端路由。带扩展名的路径不落 fallback（避免把不存在的静态资源当页面）。
  app.get('/console/*', async (req, reply) => {
    const url = (req.url ?? '').split('?')[0];
    const rel = url.replace(/^\/console\/?/, '');
    if (/\.[A-Za-z0-9]+$/.test(rel)) {
      return notFound(req, reply);
    }
    return serveHtml(shellHtml)(req, reply);
  });
}