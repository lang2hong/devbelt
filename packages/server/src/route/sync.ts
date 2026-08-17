import type { FastifyInstance } from 'fastify';
import { authScope } from '../middleware/requireAuth.js';
import { sendError } from '../middleware/errorHandler.js';
import type { SyncService } from '../service/syncService.js';
import type { SectionType } from '../domain/enums.js';

export interface SyncRouteOptions {
  syncService: SyncService;
}

/**
 * 同步路由（HTTP 层）：分节 push/pull + 版本列表 + 回滚。
 * 端到端加密：仅搬运密文，不解析内容。
 *
 * GET    /api/sync?section=xxx       拉取（section 可选，无则全节）
 * PUT    /api/sync                    推送单节 { section, encryptedData, baseVersion }
 * GET    /api/sync/versions?section=xxx  列历史版本
 * POST   /api/sync/rollback           回滚 { section, toVersion }
 */
export async function syncRoutes(app: FastifyInstance, opts: SyncRouteOptions): Promise<void> {
  app.register(authScope, {
    routes: async (child) => {
      child.get('/api/sync', async (req, reply) => {
        const userId = req.user.sub as number;
        const section = (req.query as any).section as SectionType | undefined;
        const deviceId = (req.headers['x-device-id'] as string) ?? undefined;
        try {
          const r = await opts.syncService.pull(userId, section, deviceId);
          reply.send(r);
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.put('/api/sync', async (req, reply) => {
        const userId = req.user.sub as number;
        const { section, encryptedData, baseVersion, itemCount, meta } = req.body as any;
        const deviceId = (req.headers['x-device-id'] as string) ?? undefined;
        try {
          const r = await opts.syncService.push(userId, section, encryptedData, Number(baseVersion), {
            deviceId,
            itemCount: Number(itemCount) || 0,
            meta,
          });
          reply.send(r);
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.get('/api/sync/versions', async (req, reply) => {
        const userId = req.user.sub as number;
        const section = (req.query as any).section as SectionType;
        try {
          const versions = await opts.syncService.listVersions(userId, section);
          reply.send({ versions });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.post('/api/sync/rollback', async (req, reply) => {
        const userId = req.user.sub as number;
        const { section, toVersion } = req.body as any;
        try {
          const r = await opts.syncService.rollback(userId, section, Number(toVersion));
          reply.send(r);
        } catch (e) {
          sendError(reply, e);
        }
      });
    },
  });
}
