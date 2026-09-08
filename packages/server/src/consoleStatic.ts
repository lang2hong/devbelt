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
  return process.env.CONSOLE_DIST_DIR || path.resolve(process.cwd(), '../console-ui/dist');
}

function notFound(_req: FastifyRequest, reply: FastifyReply): void {
  reply.code(404).type('text/plain').send('not found');
}

/**
 * 控制台静态托管（P3 §8 的切片 1/2 形态）。
 *
 * - `/assets/*`：内容 hash 静态资源（Vite base=/）。
 * - 独立公开页：`/verify-email`、`/login`、`/register`。
 * - 控制台壳 `index.html` 落在 `/`（切片 2 登录落地，`/console/*` SPA fallback 属切片 3）。
 * 均 `no-store` + 严格 CSP。未构建 console-ui 时优雅降级为 404。
 */
export async function registerConsoleStatic(app: FastifyInstance): Promise<void> {
  const dist = consoleDistDir();

  if (!existsSync(dist)) {
    app.log.warn(`[console] console-ui dist not found at ${dist}; public pages unavailable`);
    app.get('/verify-email', notFound);
    app.get('/login', notFound);
    app.get('/register', notFound);
    app.get('/', notFound);
    return;
  }

  await app.register(fastifyStatic, {
    root: path.join(dist, 'assets'),
    prefix: '/assets/',
    decorateReply: false,
    index: false,
  });

  function readHtml(name: string): string | null {
    try {
      return readFileSync(path.join(dist, name), 'utf8');
    } catch {
      app.log.warn(`[console] ${name} missing in ${dist}`);
      return null;
    }
  }

  const entries: Array<[string, string]> = [
    ['/verify-email', 'verify-email.html'],
    ['/login', 'login.html'],
    ['/register', 'register.html'],
    ['/', 'index.html'],
    ['/console/', 'index.html'],
  ];

  for (const [route, file] of entries) {
    const html = readHtml(file);
    app.get(route, async (_req, reply) => {
      if (html == null) return notFound(_req, reply);
      reply
        .header('Cache-Control', 'no-store')
        .header('Content-Security-Policy', PUBLIC_CSP)
        .type('text/html')
        .send(html);
    });
  }

  app.get('/console', async (_req, reply) => {
    reply.redirect('/console/');
  });
}