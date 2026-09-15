import type { FastifyInstance } from 'fastify';
import { authScope } from '../middleware/requireAuth.js';
import { organizationAuth } from '../middleware/organizationAuth.js';
import { consoleWriteGuard, isConsoleAudience } from '../middleware/consoleWrite.js';
import { sendError } from '../middleware/errorHandler.js';
import type { Queryable } from '../repository/mysql/db.js';
import { createOrganizationBody } from './schemas.js';
import { toOrgDto } from './organizations/dto.js';
import {
  idempotencyMode,
  requestIdOf,
  sessionIdOf,
  type OrganizationRouteOptions,
  type OrgRoutesContext,
} from './organizations/context.js';
import { registerCoreRoutes } from './organizations/core.js';
import { registerMemberRoutes } from './organizations/members.js';
import { registerInvitationRoutes } from './organizations/invitations.js';
import { registerFolderRoutes } from './organizations/folders.js';
import { registerResourceRoutes } from './organizations/resources.js';

export type { OrganizationRouteOptions } from './organizations/context.js';

/**
 * 组织域路由（组合根）。
 *
 * 处理函数按资源拆到 `./organizations/*`（core/members/invitations/folders/resources），
 * 本文件只做两件事：注册认证作用域、把共享依赖 `OrgRoutesContext` 传给各子模块。
 * 授权边界（authScope / organizationAuth）保持不变。
 */
export async function organizationRoutes(app: FastifyInstance, opts: OrganizationRouteOptions): Promise<void> {
  const svc = opts.organizationService;
  const resources = opts.resourceService;
  const ctx: OrgRoutesContext = { svc, resources, opts };

  // 列 / 创建组织：仅需认证
  app.register(authScope, {
    tokenService: opts.tokenService,
    getUser: opts.getUser,
    getSessionActive: opts.getSessionActive,
    aud: ['extension', 'console'],
    scope: ['organization'],
    routes: async (auth) => {
      auth.get('/api/organizations', async (req, reply) => {
        const userId = (req as any).authUserId as number;
        try {
          const orgs = await svc.listOrganizations(userId);
          reply.send({ organizations: orgs.map(toOrgDto) });
        } catch (e) {
          sendError(reply, e);
        }
      });

      auth.post('/api/organizations', { schema: { body: createOrganizationBody } }, async (req, reply) => {
        if (isConsoleAudience(req) && !consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) {
          return reply.code(403).send({ message: 'forbidden', code: 'FORBIDDEN' });
        }
        const userId = (req as any).authUserId as number;
        const { name } = req.body as any;
        try {
          const mode = idempotencyMode(req);
          if (mode.mode === 'direct') {
            const dto = await svc.createOrganization(userId, name);
            opts.auditWriter.write({
              eventType: 'organization.created', result: 'success', actorUserId: userId,
              targetType: 'organization', targetId: String(dto.organizationId), organizationId: dto.organizationId,
              sourceIp: req.ip, requestId: requestIdOf(req),
            });
            reply.code(201).send({ organization: toOrgDto(dto) });
            return;
          }
          const result = await opts.idempotencyService.run({
            actorUserId: userId, sessionId: sessionIdOf(req), method: 'POST', normalizedPath: '/api/organizations',
            idempotencyKey: mode.idempotencyKey, requestBody: req.body,
            // 限流在 createProcessing 之后、business 之前的同一事务内计数（随事务回滚）。
            beforeWrite: (tx) => svc.throttleCreateOrganizationInTx(tx, userId),
            business: async (tx: Queryable) => {
              const dto = await svc.createOrganizationInTx(tx, userId, name);
              await opts.auditWriter.writeInTx(tx, {
                eventType: 'organization.created', result: 'success', actorUserId: userId,
                targetType: 'organization', targetId: String(dto.organizationId), organizationId: dto.organizationId,
                sourceIp: req.ip, requestId: requestIdOf(req),
              });
              return { status: 201, body: { organization: toOrgDto(dto) } };
            },
          });
          reply.code(result.status).send(result.body);
        } catch (e) {
          sendError(reply, e);
        }
      });
    },
  });

  // 组织授权作用域：URL 带 :organizationId，按 permission code 授权
  app.register(organizationAuth, {
    tokenService: opts.tokenService,
    getUser: opts.getUser,
    getSessionActive: opts.getSessionActive,
    scope: ['organization'],
    csrfService: opts.csrfService,
    consoleOrigin: opts.consoleOrigin,
    organizationRepo: opts.organizationRepo,
    membershipRepo: opts.membershipRepo,
    routes: async (org) => {
      await registerCoreRoutes(org, ctx);
      await registerMemberRoutes(org, ctx);
      await registerInvitationRoutes(org, ctx);
      await registerFolderRoutes(org, ctx);
      await registerResourceRoutes(org, ctx);
    },
  });
}