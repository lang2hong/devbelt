import type { FastifyInstance } from 'fastify';
import { authScope, type GetAuthUser } from '../middleware/requireAuth.js';
import { organizationAuth, type AuthnOrgRequest } from '../middleware/organizationAuth.js';
import type { TokenService } from '../service/tokenService.js';
import type { OrganizationService } from '../service/organizationService.js';
import type { OrganizationResourceService } from '../service/organizationResourceService.js';
import type { IOrganizationRepo, IMembershipRepo, InvitationDto } from '../repository/interfaces.js';
import type { OrganizationRole, ResourceType } from '../domain/enums.js';
import type { CsrfService } from '../service/csrfService.js';
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
          const org = await svc.createOrganization(userId, name);
          reply.code(201).send({ organization: toOrgDto(org) });
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
          const r = await svc.updateOrganization(organizationId, actorUserId, name);
          reply.send(r);
        } catch (e) {
          sendError(reply, e);
        }
      });

      org.post('/api/organizations/:organizationId/close', { config: { permission: 'organization.close' }, schema: { params: organizationIdParam } }, async (req, reply) => {
        const organizationId = (req as any).authOrganizationId as number;
        const actorUserId = (req as any).authUserId as number;
        try {
          const r = await svc.closeOrganization(organizationId, actorUserId);
          reply.send(r);
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
          const r = await svc.assignRole(organizationId, membershipId, role as OrganizationRole, userId);
          reply.send(r);
        } catch (e) {
          sendError(reply, e);
        }
      });

      org.delete('/api/organizations/:organizationId/members/:membershipId', { config: { permission: 'member.remove' }, schema: { params: membershipIdParam } }, async (req, reply) => {
        const organizationId = (req as any).authOrganizationId as number;
        const userId = (req as any).authUserId as number;
        const membershipId = Number((req.params as any).membershipId);
        try {
          const r = await svc.removeMember(organizationId, membershipId, userId);
          reply.send(r);
        } catch (e) {
          sendError(reply, e);
        }
      });

      org.post('/api/organizations/:organizationId/leave', { schema: { params: organizationIdParam } }, async (req, reply) => {
        const organizationId = (req as any).authOrganizationId as number;
        const userId = (req as any).authUserId as number;
        try {
          const r = await svc.leaveOrganization(organizationId, userId);
          reply.send(r);
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
          const r = await svc.inviteMember(organizationId, actorUserId, email, role as OrganizationRole | undefined);
          reply.code(201).send({ invitation: toInvitationDto(r) });
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
          const r = await svc.revokeInvitation(organizationId, actorUserId, invitationId);
          reply.send(r);
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

      org.post('/api/organizations/:organizationId/folders', { config: { permission: 'folder.manage' }, schema: { params: organizationIdParam, body: createFolderBody } }, async (req, reply) => {
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

      org.patch('/api/organizations/:organizationId/folders/:folderId', { config: { permission: 'folder.manage' }, schema: { params: folderIdParam, body: updateFolderBody } }, async (req, reply) => {
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

      org.delete('/api/organizations/:organizationId/folders/:folderId', { config: { permission: 'folder.manage' }, schema: { params: folderIdParam } }, async (req, reply) => {
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

      org.post('/api/organizations/:organizationId/resources', { config: { permission: 'resource.write' }, schema: { params: organizationIdParam, body: createResourceBody } }, async (req, reply) => {
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

      org.get('/api/organizations/:organizationId/resources/:resourceId', { config: { permission: 'resource.read' }, schema: { params: resourceIdParam } }, async (req, reply) => {
        const organizationId = (req as any).authOrganizationId as number;
        const resourceId = Number((req.params as any).resourceId);
        try {
          const resource = await resources.getResource(organizationId, resourceId);
          reply.send({ resource: toResourceDetailDto(resource) });
        } catch (e) {
          sendError(reply, e);
        }
      });

      org.patch('/api/organizations/:organizationId/resources/:resourceId', { config: { permission: 'resource.write' }, schema: { params: resourceIdParam, body: updateResourceBody } }, async (req, reply) => {
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

      org.delete('/api/organizations/:organizationId/resources/:resourceId', { config: { permission: 'resource.delete' }, schema: { params: resourceIdParam } }, async (req, reply) => {
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

function toFolderDto(f: { folderId: number; name: string; parentId: number | null }) {
  return { folderId: String(f.folderId), name: f.name, parentId: f.parentId === null ? null : String(f.parentId) };
}

function toResourceSummaryDto(r: { resourceId: number; resourceType: ResourceType; name: string; folderId: number | null; version: number; createdByMembershipId: number; updatedByMembershipId: number | null }) {
  return {
    resourceId: String(r.resourceId),
    resourceType: r.resourceType,
    name: r.name,
    folderId: r.folderId === null ? null : String(r.folderId),
    version: r.version,
    createdByMembershipId: String(r.createdByMembershipId),
    updatedByMembershipId: r.updatedByMembershipId === null ? null : String(r.updatedByMembershipId),
  };
}

function toResourceDetailDto(r: { id: number; organizationId: number; folderId: number | null; resourceType: ResourceType; name: string; content: Record<string, unknown>; version: number; createdByMembershipId: number; updatedByMembershipId: number | null }) {
  return {
    resourceId: String(r.id),
    resourceType: r.resourceType,
    name: r.name,
    folderId: r.folderId === null ? null : String(r.folderId),
    version: r.version,
    content: r.content,
    createdByMembershipId: String(r.createdByMembershipId),
    updatedByMembershipId: r.updatedByMembershipId === null ? null : String(r.updatedByMembershipId),
  };
}

function toInvitationListItem(d: InvitationDto) {
  return {
    invitationId: String(d.invitationId),
    email: d.email,
    role: d.role,
    expiresTime: d.expiresTime.toISOString(),
    invitedTime: d.invitedTime.toISOString(),
  };
}

function toInvitationDto(r: { invitationId: number; email: string; role: OrganizationRole; expiresTime: Date }) {
  return {
    invitationId: String(r.invitationId),
    email: r.email,
    role: r.role,
    expiresTime: r.expiresTime.toISOString(),
  };
}

function toOrgDto(o: { organizationId: number; name: string; status: string; closedTime: Date | null; role: OrganizationRole }) {
  return {
    organizationId: String(o.organizationId),
    name: o.name,
    status: o.status,
    closedTime: o.closedTime ? o.closedTime.toISOString() : null,
    role: o.role,
  };
}

function orgDto(o: { id: number; name: string; status: string; closedTime: Date | null }, role: OrganizationRole) {
  return {
    organizationId: String(o.id),
    name: o.name,
    status: o.status,
    closedTime: o.closedTime ? o.closedTime.toISOString() : null,
    role,
  };
}
