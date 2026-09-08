import { existsSync, readFileSync } from 'fs';
import path from 'path';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';

/** 邮件落地点严格 CSP（P3 §5.1）：无第三方、无 eval，只放行构建产物。 */
const EMAIL_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; base-uri 'none'; " +
  "frame-ancestors 'none'; form-action 'self'; object-src 'none'";

function consoleDistDir(): string {
  return process.env.CONSOLE_DIST_DIR || path.resolve(process.cwd(), '../console-ui/dist');
}

/**
 * 邮件落地点/控制台静态托管（P3 §8 的最小切片 1 形态）。
 *
 * - `/assets/*`：serve console-ui 构建出的内容 hash 静态资源（Vite base=/）。
 * - `/verify-email`：serve 独立邮件入口 HTML，附严格 CSP + no-store。
 *
 * `/console/*` SPA fallback、全量全局安全头与缓存策略属切片 3，本片不扩展。
 * 未构建 console-ui 时优雅降级：邮箱页返回 404，不使进程启动失败。
 */
export async function registerConsoleStatic(app: FastifyInstance): Promise<void> {
  const dist = consoleDistDir();
  const emailHtmlPath = path.join(dist, 'verify-email.html');

  if (!existsSync(dist)) {
    app.log.warn(`[console] console-ui dist not found at ${dist}; email pages unavailable`);
    app.get('/verify-email', async (_req, reply) => {
      reply.code(404).type('text/plain').send('console UI not built');
    });
    return;
  }

  await app.register(fastifyStatic, {
    root: path.join(dist, 'assets'),
    prefix: '/assets/',
    decorateReply: false,
    index: false,
  });

  // 邮件入口按需读取（内容随构建产物变化，读一次缓存到内存即可）。
  let emailHtml: string | null = null;
  try {
    emailHtml = readFileSync(emailHtmlPath, 'utf8');
  } catch {
    emailHtml = null;
    app.log.warn(`[console] verify-email.html missing at ${emailHtmlPath}`);
  }

  app.get('/verify-email', async (_req, reply) => {
    if (emailHtml == null) {
      return reply.code(404).type('text/plain').send('not found');
    }
    reply
      .header('Cache-Control', 'no-store')
      .header('Content-Security-Policy', EMAIL_CSP)
      .type('text/html')
      .send(emailHtml);
  });
}