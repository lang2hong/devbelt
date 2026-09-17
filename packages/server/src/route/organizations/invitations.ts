import type { FastifyInstance } from 'fastify';
import { sendError } from '../../middleware/errorHandler.js';
import type { Queryable } from '../../repository/mysql/db.js';
import type { OrganizationRole } from '../../domain/enums.js';
import type { InviteOutcome } from '../../service/organizationService.js';
import { createInvitationBody, invitationIdParam, organizationIdParam } from '../schemas.js';
import { toInvitationDto, toInvitationListItem } from './dto.js';
import { idempotencyMode, requestIdOf, sessionIdOf, type OrgRoutesContext } from './context.js';

/** 邀请：创建 / 列表 / 撤销（permission member.invite）。 */
export async function registerInvitationRoutes(org: FastifyInstance, ctx: OrgRoutesContext): Promise<void> {
  const { svc, opts } = ctx;

  org.post('/api/db/organizations/:organizationId/invitations', { config: { permission: 'member.invite' }, schema: { params: organizationIdParam, body: createInvitationBody } }, async (req, reply) => {
    const organizationId = (req as any).authOrganizationId as number;
    const actorUserId = (req as any).authUserId as number;
    const { email, role } = req.body as any;
    try {
      const mode = idempotencyMode(req);
      if (mode.mode === 'direct') {
        const r = await svc.inviteMember(organizationId, actorUserId, email, role as OrganizationRole | undefined);
        opts.auditWriter.write({
          eventType: 'invitation.create', result: 'success', actorUserId,
          targetType: 'invitation', targetId: String(r.invitationId), organizationId,
          sourceIp: req.ip, requestId: requestIdOf(req),
        });
        reply.code(201).send({ invitation: toInvitationDto(r) });
        return;
      }
      let outcome: InviteOutcome | undefined;
      const result = await opts.idempotencyService.run({
        actorUserId, sessionId: sessionIdOf(req), method: 'POST',
        normalizedPath: `/api/db/organizations/${organizationId}/invitations`,
        idempotencyKey: mode.idempotencyKey, requestBody: req.body,
        business: async (tx: Queryable) => {
          outcome = await svc.inviteMemberInTx(tx, organizationId, actorUserId, email, role as OrganizationRole | undefined);
          await opts.auditWriter.writeInTx(tx, {
            eventType: 'invitation.create', result: 'success', actorUserId,
            targetType: 'invitation', targetId: String(outcome.invitationId), organizationId,
            sourceIp: req.ip, requestId: requestIdOf(req),
          });
          return { status: 201, body: { invitation: toInvitationDto(outcome) } };
        },
      });
      // 仅在首次（非重放）发信；重放不重复发信（§6.1）。
      if (!result.replayed && outcome) await opts.sendInvitation(outcome);
      reply.code(result.status).send(result.body);
    } catch (e) {
      sendError(reply, e);
    }
  });

  org.get('/api/db/organizations/:organizationId/invitations', { config: { permission: 'member.invite' }, schema: { params: organizationIdParam } }, async (req, reply) => {
    const organizationId = (req as any).authOrganizationId as number;
    try {
      const list = await svc.listInvitations(organizationId);
      reply.send({ invitations: list.map(toInvitationListItem) });
    } catch (e) {
      sendError(reply, e);
    }
  });

  org.delete('/api/db/organizations/:organizationId/invitations/:invitationId', { config: { permission: 'member.invite' }, schema: { params: invitationIdParam } }, async (req, reply) => {
    const organizationId = (req as any).authOrganizationId as number;
    const actorUserId = (req as any).authUserId as number;
    const invitationId = Number((req.params as any).invitationId);
    try {
      const mode = idempotencyMode(req);
      if (mode.mode === 'direct') {
        const r = await svc.revokeInvitation(organizationId, actorUserId, invitationId);
        opts.auditWriter.write({
          eventType: 'invitation.revoke', result: 'success', actorUserId,
          targetType: 'invitation', targetId: String(invitationId), organizationId,
          sourceIp: req.ip, requestId: requestIdOf(req),
        });
        reply.send(r);
        return;
      }
      const membershipId = await svc.invitationMembershipId(invitationId, organizationId);
      const result = await opts.idempotencyService.run({
        actorUserId, sessionId: sessionIdOf(req), method: 'DELETE',
        normalizedPath: `/api/db/organizations/${organizationId}/invitations/${invitationId}`,
        idempotencyKey: mode.idempotencyKey,
        business: async (tx: Queryable) => {
          const r = await svc.revokeInvitationInTx(tx, organizationId, actorUserId, invitationId, membershipId);
          await opts.auditWriter.writeInTx(tx, {
            eventType: 'invitation.revoke', result: 'success', actorUserId,
            targetType: 'invitation', targetId: String(invitationId), organizationId,
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