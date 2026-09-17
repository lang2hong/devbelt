import type { FastifyInstance } from 'fastify';
import type { AuthnOrgRequest } from '../../middleware/organizationAuth.js';
import { sendError } from '../../middleware/errorHandler.js';
import type { Queryable } from '../../repository/mysql/db.js';
import { organizationIdParam, updateOrganizationBody } from '../schemas.js';
import { orgDto } from './dto.js';
import {
  CLOSE_ORG_RETENTION_MS,
  idempotencyMode,
  requestIdOf,
  sessionIdOf,
  type OrgRoutesContext,
} from './context.js';

/** 组织核心：读取 / 改名 / 关闭。 */
export async function registerCoreRoutes(org: FastifyInstance, ctx: OrgRoutesContext): Promise<void> {
  const { svc, opts } = ctx;

  org.get('/api/db/organizations/:organizationId', { config: { permission: 'organization.read' }, schema: { params: organizationIdParam } }, async (req, reply) => {
    const { authOrganization, authMembershipRole } = req as unknown as AuthnOrgRequest;
    try {
      reply.send({ organization: orgDto(authOrganization, authMembershipRole) });
    } catch (e) {
      sendError(reply, e);
    }
  });

  org.patch('/api/db/organizations/:organizationId', { config: { permission: 'organization.update' }, schema: { params: organizationIdParam, body: updateOrganizationBody } }, async (req, reply) => {
    const organizationId = (req as any).authOrganizationId as number;
    const actorUserId = (req as any).authUserId as number;
    const { name } = req.body as any;
    try {
      const mode = idempotencyMode(req);
      if (mode.mode === 'direct') {
        const r = await svc.updateOrganization(organizationId, actorUserId, name);
        opts.auditWriter.write({
          eventType: 'organization.renamed', result: 'success', actorUserId,
          targetType: 'organization', targetId: String(organizationId), organizationId,
          sourceIp: req.ip, requestId: requestIdOf(req),
        });
        reply.send(r);
        return;
      }
      const result = await opts.idempotencyService.run({
        actorUserId, sessionId: sessionIdOf(req), method: 'PATCH', normalizedPath: `/api/db/organizations/${organizationId}`,
        idempotencyKey: mode.idempotencyKey, requestBody: req.body,
        business: async (tx: Queryable) => {
          const r = await svc.updateOrganizationInTx(tx, organizationId, actorUserId, name);
          await opts.auditWriter.writeInTx(tx, {
            eventType: 'organization.renamed', result: 'success', actorUserId,
            targetType: 'organization', targetId: String(organizationId), organizationId,
            sourceIp: req.ip, requestId: requestIdOf(req),
          });
          return { status: 200, body: r };
        },
      });
      reply.code(result.status).send(result.body);
    } catch (e) {
      sendError(reply, e);
    }
  });

  org.post('/api/db/organizations/:organizationId/close', { config: { permission: 'organization.close' }, schema: { params: organizationIdParam } }, async (req, reply) => {
    const organizationId = (req as any).authOrganizationId as number;
    const actorUserId = (req as any).authUserId as number;
    try {
      const mode = idempotencyMode(req);
      if (mode.mode === 'direct') {
        const r = await svc.closeOrganization(organizationId, actorUserId);
        opts.auditWriter.write({
          eventType: 'organization.closed', result: 'success', actorUserId,
          targetType: 'organization', targetId: String(organizationId), organizationId,
          sourceIp: req.ip, requestId: requestIdOf(req),
        });
        reply.send(r);
        return;
      }
      const result = await opts.idempotencyService.run({
        actorUserId, sessionId: sessionIdOf(req), method: 'POST', normalizedPath: `/api/db/organizations/${organizationId}/close`,
        idempotencyKey: mode.idempotencyKey, retentionMs: CLOSE_ORG_RETENTION_MS,
        business: async (tx: Queryable) => {
          const r = await svc.closeOrganizationInTx(tx, organizationId, actorUserId);
          await opts.auditWriter.writeInTx(tx, {
            eventType: 'organization.closed', result: 'success', actorUserId,
            targetType: 'organization', targetId: String(organizationId), organizationId,
            sourceIp: req.ip, requestId: requestIdOf(req),
          });
          return { status: 200, body: r };
        },
      });
      reply.code(result.status).send(result.body);
    } catch (e) {
      sendError(reply, e);
    }
  });
}