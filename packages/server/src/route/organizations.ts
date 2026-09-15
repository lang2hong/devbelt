import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authScope, type GetAuthUser } from '../middleware/requireAuth.js';
import { organizationAuth, type AuthnOrgRequest } from '../middleware/organizationAuth.js';
import type { TokenService } from '../service/tokenService.js';
import type { OrganizationService, InviteOutcome } from '../service/organizationService.js';
import type { OrganizationResourceService } from '../service/organizationResourceService.js';
import type { IOrganizationRepo, IMembershipRepo } from '../repository/interfaces.js';
import type { OrganizationRole, ResourceType } from '../domain/enums.js';
import type { CsrfService } from '../service/csrfService.js';
import type { AuditWriter } from '../service/auditWriter.js';
import type { IdempotencyService } from '../service/idempotencyService.js';
import { validateIdempotencyKey } from '../service/idempotencyService.js';
import type { Queryable } from '../repository/mysql/db.js';
import { consoleWriteGuard, isConsoleAudience } from '../middleware/consoleWrite.js';
import { sendError } from '../middleware/errorHandler.js';
import {
  assignRoleBody,
  createFolderBody,
  createInvitationBody,
  createOrganizationBody,
  createResourceBody,
  folderIdParam,
  invitationIdParam,
  membershipIdParam,
  organizationIdParam,
  resourceIdParam,
  updateFolderBody,
  updateOrganizationBody,
  updateResourceBody,
} from './schemas.js';
import {
  orgDto,
  toFolderDto,
  toInvitationDto,
  toInvitationListItem,
  toOrgDto,
  toResourceDetailDto,
  toResourceSummaryDto,
} from './organizations/dto.js';

export interface OrganizationRouteOptions {
  tokenService: TokenService;
  getUser: GetAuthUser;
  getSessionActive: (sessionId: string) => Promise<boolean>;
  csrfService: CsrfService;
  consoleOrigin: string;
  organizationService: OrganizationService;
  resourceService: OrganizationResourceService;
  organizationRepo: IOrganizationRepo;
  membershipRepo: IMembershipRepo;
  auditWriter: AuditWriter;
  idempotencyService: IdempotencyService;
  /** 邀请邮件发送（提交后副作用；由 app.ts 注入 emailSender）。 */
  sendInvitation: (outcome: InviteOutcome) => Promise<void>;
}

/** 关闭组织回执保留 30 天（§6.1）。 */
const CLOSE_ORG_RETENTION_MS = 30 * 24 * 3600 * 1000;

type IdempotencyMode = { mode: 'direct' } | { mode: 'key'; idempotencyKey: string };

function idempotencyMode(req: FastifyRequest): IdempotencyMode {
  const rawKey = req.headers['idempotency-key'];
  if (isConsoleAudience(req) || rawKey !== undefined) {
    return { mode: 'key', idempotencyKey: validateIdempotencyKey(rawKey) };
  }
  return { mode: 'direct' };
}

function sessionIdOf(req: FastifyRequest): string {
  return (req as unknown as { authSessionId?: string }).authSessionId ?? '';
}

function requestIdOf(req: FastifyRequest): string {
  return (req as unknown as { requestId?: string }).requestId ?? 'unknown';
}

export async function organizationRoutes(app: FastifyInstance, opts: OrganizationRouteOptions): Promise<void> {
  const svc = opts.organizationService;
  const resources = opts.resourceService;

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
      org.get('/api/organizations/:organizationId', { config: { permission: 'organization.read' }, schema: { params: organizationIdParam } }, async (req, reply) => {
        const { authOrganization, authMembershipRole } = req as unknown as AuthnOrgRequest;
        try {
          reply.send({ organization: orgDto(authOrganization, authMembershipRole) });
        } catch (e) {
          sendError(reply, e);
        }
      });

      org.patch('/api/organizations/:organizationId', { config: { permission: 'organization.update' }, schema: { params: organizationIdParam, body: updateOrganizationBody } }, async (req, reply) => {
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
            actorUserId, sessionId: sessionIdOf(req), method: 'PATCH', normalizedPath: `/api/organizations/${organizationId}`,
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

      org.post('/api/organizations/:organizationId/close', { config: { permission: 'organization.close' }, schema: { params: organizationIdParam } }, async (req, reply) => {
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
            actorUserId, sessionId: sessionIdOf(req), method: 'POST', normalizedPath: `/api/organizations/${organizationId}/close`,
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

      // ── 邀请（permission member.invite）──
      org.post('/api/organizations/:organizationId/invitations', { config: { permission: 'member.invite' }, schema: { params: organizationIdParam, body: createInvitationBody } }, async (req, reply) => {
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
            normalizedPath: `/api/organizations/${organizationId}/invitations`,
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

      org.get('/api/organizations/:organizationId/invitations', { config: { permission: 'member.invite' }, schema: { params: organizationIdParam } }, async (req, reply) => {
        const organizationId = (req as any).authOrganizationId as number;
        try {
          const list = await svc.listInvitations(organizationId);
          reply.send({ invitations: list.map(toInvitationListItem) });
        } catch (e) {
          sendError(reply, e);
        }
      });

      org.delete('/api/organizations/:organizationId/invitations/:invitationId', { config: { permission: 'member.invite' }, schema: { params: invitationIdParam } }, async (req, reply) => {
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
            normalizedPath: `/api/organizations/${organizationId}/invitations/${invitationId}`,
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

      // ── 目录（folder.read / folder.manage）──
      org.get('/api/organizations/:organizationId/folders', { config: { permission: 'folder.read' }, schema: { params: organizationIdParam } }, async (req, reply) => {
        const organizationId = (req as any).authOrganizationId as number;
        try {
          const list = await resources.listFolders(organizationId);
          reply.send({ folders: list.map(toFolderDto) });
        } catch (e) {
          sendError(reply, e);
        }
      });

      org.post('/api/organizations/:organizationId/folders', { config: { permission: 'folder.manage', aud: 'extension' }, schema: { params: organizationIdParam, body: createFolderBody } }, async (req, reply) => {
        const organizationId = (req as any).authOrganizationId as number;
        const actorUserId = (req as any).authUserId as number;
        const body = req.body as any;
        try {
          const folder = await resources.createFolder(organizationId, actorUserId, body.name, body.parentId === null ? null : body.parentId ? Number(body.parentId) : undefined);
          reply.code(201).send({ folder: toFolderDto(folder) });
        } catch (e) {
          sendError(reply, e);
        }
      });

      org.patch('/api/organizations/:organizationId/folders/:folderId', { config: { permission: 'folder.manage', aud: 'extension' }, schema: { params: folderIdParam, body: updateFolderBody } }, async (req, reply) => {
        const organizationId = (req as any).authOrganizationId as number;
        const actorUserId = (req as any).authUserId as number;
        const folderId = Number((req.params as any).folderId);
        const body = req.body as any;
        const parentId = body.parentId === null ? null : body.parentId !== undefined ? Number(body.parentId) : undefined;
        try {
          const folder = await resources.updateFolder(organizationId, actorUserId, folderId, { name: body.name, parentId });
          reply.send({ folder: toFolderDto(folder) });
        } catch (e) {
          sendError(reply, e);
        }
      });

      org.delete('/api/organizations/:organizationId/folders/:folderId', { config: { permission: 'folder.manage', aud: 'extension' }, schema: { params: folderIdParam } }, async (req, reply) => {
        const organizationId = (req as any).authOrganizationId as number;
        const actorUserId = (req as any).authUserId as number;
        const folderId = Number((req.params as any).folderId);
        try {
          const r = await resources.deleteFolder(organizationId, actorUserId, folderId);
          reply.send(r);
        } catch (e) {
          sendError(reply, e);
        }
      });

      // ── 资源（resource.read/write/delete）──
      org.get('/api/organizations/:organizationId/resources', { config: { permission: 'resource.read' }, schema: { params: organizationIdParam } }, async (req, reply) => {
        const organizationId = (req as any).authOrganizationId as number;
        try {
          const list = await resources.listResources(organizationId);
          reply.send({ resources: list.map(toResourceSummaryDto) });
        } catch (e) {
          sendError(reply, e);
        }
      });

      org.post('/api/organizations/:organizationId/resources', { config: { permission: 'resource.write', aud: 'extension' }, schema: { params: organizationIdParam, body: createResourceBody } }, async (req, reply) => {
        const organizationId = (req as any).authOrganizationId as number;
        const actorUserId = (req as any).authUserId as number;
        const body = req.body as any;
        const folderId = body.folderId === null ? null : body.folderId !== undefined ? Number(body.folderId) : undefined;
        try {
          const created = await resources.createResource(organizationId, actorUserId, { resourceType: body.resourceType as ResourceType, name: body.name, folderId, content: body.content });
          reply.code(201).send({ resource: toResourceSummaryDto(created) });
        } catch (e) {
          sendError(reply, e);
        }
      });

      org.get('/api/organizations/:organizationId/resources/:resourceId', { config: { permission: 'resource.read', aud: 'extension' }, schema: { params: resourceIdParam } }, async (req, reply) => {
        const organizationId = (req as any).authOrganizationId as number;
        const resourceId = Number((req.params as any).resourceId);
        try {
          const resource = await resources.getResource(organizationId, resourceId);
          reply.send({ resource: toResourceDetailDto(resource) });
        } catch (e) {
          sendError(reply, e);
        }
      });

      org.patch('/api/organizations/:organizationId/resources/:resourceId', { config: { permission: 'resource.write', aud: 'extension' }, schema: { params: resourceIdParam, body: updateResourceBody } }, async (req, reply) => {
        const organizationId = (req as any).authOrganizationId as number;
        const resourceId = Number((req.params as any).resourceId);
        const actorUserId = (req as any).authUserId as number;
        const body = req.body as any;
        const folderId = body.folderId === null ? null : body.folderId !== undefined ? Number(body.folderId) : undefined;
        try {
          const updated = await resources.updateResource(organizationId, actorUserId, resourceId, { baseVersion: body.baseVersion, name: body.name, folderId, content: body.content });
          reply.send({ resource: toResourceSummaryDto(updated) });
        } catch (e) {
          sendError(reply, e);
        }
      });

      org.delete('/api/organizations/:organizationId/resources/:resourceId', { config: { permission: 'resource.delete', aud: 'extension' }, schema: { params: resourceIdParam } }, async (req, reply) => {
        const organizationId = (req as any).authOrganizationId as number;
        const resourceId = Number((req.params as any).resourceId);
        const actorUserId = (req as any).authUserId as number;
        try {
          const r = await resources.deleteResource(organizationId, actorUserId, resourceId);
          reply.send(r);
        } catch (e) {
          sendError(reply, e);
        }
      });
    },
  });
}

