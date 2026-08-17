import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 管理后台 UI 路由：托管 admin-ui 构建产物（packages/server/public）。
 * - 静态资源以 /admin/ 前缀托管。
 * - /admin 直接返回 index.html（页面公开，数据仍由 /admin/* 的 admin JWT 校验）。
 */
const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../public');

export async function adminUiRoutes(app: FastifyInstance): Promise<void> {
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/admin/',
    index: 'index.html',
  });

  app.get('/admin', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return reply.sendFile('index.html', publicDir);
  });
}