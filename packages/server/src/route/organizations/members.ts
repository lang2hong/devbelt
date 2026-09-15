import type { FastifyInstance } from 'fastify';
import { sendError } from '../../middleware/errorHandler.js';
import type { Queryable } from '../../repository/mysql/db.js';
import type { OrganizationRole } from '../../domain/enums.js';
import { assignRoleBody, membershipIdParam, organizationIdParam } from '../schemas.js';
import { idempotencyMode, requestIdOf, sessionIdOf, type OrgRoutesContext } from './context.js';

/** 成员：列表 / 改角色 / 移除 / 主动退出。 */
export async function registerMemberRoutes(org: FastifyInstance, ctx: OrgRoutesContext): Promise<void> {
  const { svc, opts } = ctx;

  org.get('/api/organizations/:organizationId/members', { config: { permission: 'member.read' }, schema: { params: organizationIdParam } }, async (req, reply) => {
    const organizationId = (req as any).authOrganizationId as number;
    try {
      const members = await svc.listMembers(organizationId);
      reply.send({
        members: members.map((m) => ({
          membershipId: String(m.membershipId),
          displayName: m.displayName ?? null,
          role: m.role,
          status: m.status,
          joinedTime: m.joinedTime ? m.joinedTime.toISOString() : null,
        })),
      });
    } catch (e) {
      sendError(reply, e);
    }
  });

  org.patch('/api/organizations/:organizationId/members/:membershipId', { config: { permission: 'member.role.assign' }, schema: { params: membershipIdParam, body: assignRoleBody } }, async (req, reply) => {
    const organizationId = (req as any).authOrganizationId as number;
    const userId = (req as any).authUserId as number;
    const membershipId = Number((req.params as any).membershipId);
    const { role } = req.body as any;
    try {
      const mode = idempotencyMode(req);
      if (mode.mode === 'direct') {
        const r = await svc.assignRole(organizationId, membershipId, role as OrganizationRole, userId);
        opts.auditWriter.write({
          eventType: 'organization.member.role_changed', result: 'success', actorUserId: userId,
          targetType: 'membership', targetId: String(membershipId), organizationId,
          sourceIp: req.ip, requestId: requestIdOf(req),
        });
        reply.send(r);
        return;
      }
      const result = await opts.idempotencyService.run({
        actorUserId: userId, sessionId: sessionIdOf(req), method: 'PATCH',
        normalizedPath: `/api/organizations/${organizationId}/members/${membershipId}`,
        idempotencyKey: mode.idempotencyKey, requestBody: req.body,
        business: async (tx: Queryable) => {
          const r = await svc.assignRoleInTx(tx, organizationId, membershipId, role as OrganizationRole, userId);
          await opts.auditWriter.writeInTx(tx, {
            eventType: 'organization.member.role_changed', result: 'success', actorUserId: userId,
            targetType: 'membership', targetId: String(membershipId), organizationId,
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

  org.delete('/api/organizations/:organizationId/members/:membershipId', { config: { permission: 'member.remove' }, schema: { params: membershipIdParam } }, async (req, reply) => {
    const organizationId = (req as any).authOrganizationId as number;
    const userId = (req as any).authUserId as number;
    const membershipId = Number((req.params as any).membershipId);
    try {
      const mode = idempotencyMode(req);
      if (mode.mode === 'direct') {
        const r = await svc.removeMember(organizationId, membershipId, userId);
        opts.auditWriter.write({
          eventType: 'organization.member.removed', result: 'success', actorUserId: userId,
          targetType: 'membership', targetId: String(membershipId), organizationId,
          sourceIp: req.ip, requestId: requestIdOf(req),
        });
        reply.send(r);
        return;
      }
      const result = await opts.idempotencyService.run({
        actorUserId: userId, sessionId: sessionIdOf(req), method: 'DELETE',
        normalizedPath: `/api/organizations/${organizationId}/members/${membershipId}`,
        idempotencyKey: mode.idempotencyKey,
        business: async (tx: Queryable) => {
          const r = await svc.removeMemberInTx(tx, organizationId, membershipId, userId);
          await opts.auditWriter.writeInTx(tx, {
            eventType: 'organization.member.removed', result: 'success', actorUserId: userId,
            targetType: 'membership', targetId: String(membershipId), organizationId,
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

  org.post('/api/organizations/:organizationId/leave', { schema: { params: organizationIdParam } }, async (req, reply) => {
    const organizationId = (req as any).authOrganizationId as number;
    const userId = (req as any).authUserId as number;
    try {
      const mode = idempotencyMode(req);
      if (mode.mode === 'direct') {
        const r = await svc.leaveOrganization(organizationId, userId);
        opts.auditWriter.write({
          eventType: 'organization.member.left', result: 'success', actorUserId: userId,
          targetType: 'organization', targetId: String(organizationId), organizationId,
          sourceIp: req.ip, requestId: requestIdOf(req),
        });
        reply.send(r);
        return;
      }
      const result = await opts.idempotencyService.run({
        actorUserId: userId, sessionId: sessionIdOf(req), method: 'POST',
        normalizedPath: `/api/organizations/${organizationId}/leave`,
        idempotencyKey: mode.idempotencyKey,
        business: async (tx: Queryable) => {
          const r = await svc.leaveOrganizationInTx(tx, organizationId, userId);
          await opts.auditWriter.writeInTx(tx, {
            eventType: 'organization.member.left', result: 'success', actorUserId: userId,
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