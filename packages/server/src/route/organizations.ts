import type { FastifyInstance } from 'fastify';
import { authScope, type GetAuthUser } from '../middleware/requireAuth.js';
import { organizationAuth, type AuthnOrgRequest } from '../middleware/organizationAuth.js';
import type { TokenService } from '../service/tokenService.js';
import type { OrganizationService } from '../service/organizationService.js';
import type { IOrganizationRepo, IMembershipRepo, InvitationDto } from '../repository/interfaces.js';
import type { OrganizationRole } from '../domain/enums.js';
import { sendError } from '../middleware/errorHandler.js';
import {
  assignRoleBody,
  createInvitationBody,
  createOrganizationBody,
  invitationIdParam,
  membershipIdParam,
  organizationIdParam,
  updateOrganizationBody,
} from './schemas.js';

export interface OrganizationRouteOptions {
  tokenService: TokenService;
  getUser: GetAuthUser;
  organizationService: OrganizationService;
  organizationRepo: IOrganizationRepo;
  membershipRepo: IMembershipRepo;
}

export async function organizationRoutes(app: FastifyInstance, opts: OrganizationRouteOptions): Promise<void> {
  const svc = opts.organizationService;

  // 列 / 创建组织：仅需认证
  app.register(authScope, {
    tokenService: opts.tokenService,
    getUser: opts.getUser,
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
        const { name } = req.body as any;
        try {
          const r = await svc.updateOrganization(organizationId, name);
          reply.send(r);
        } catch (e) {
          sendError(reply, e);
        }
      });

      org.post('/api/organizations/:organizationId/close', { config: { permission: 'organization.close' }, schema: { params: organizationIdParam } }, async (req, reply) => {
        const organizationId = (req as any).authOrganizationId as number;
        try {
          const r = await svc.closeOrganization(organizationId);
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

      // ── 邀请（切片 3，permission member.invite）──
      org.post('/api/organizations/:organizationId/invitations', { config: { permission: 'member.invite' }, schema: { params: organizationIdParam, body: createInvitationBody } }, async (req, reply) => {
        const organizationId = (req as any).authOrganizationId as number;
        const actorUserId = (req as any).authUserId as number;
        const actorRole = (req as unknown as AuthnOrgRequest).authMembershipRole;
        const { email, role } = req.body as any;
        try {
          const r = await svc.inviteMember(organizationId, actorUserId, actorRole, email, role as OrganizationRole | undefined);
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
        const invitationId = Number((req.params as any).invitationId);
        try {
          const r = await svc.revokeInvitation(organizationId, invitationId);
          reply.send(r);
        } catch (e) {
          sendError(reply, e);
        }
      });
    },
  });
}

function toInvitationDto(r: { invitationId: number; email: string; role: OrganizationRole; expiresTime: Date }) {
  return {
    invitationId: String(r.invitationId),
    email: r.email,
    role: r.role,
    expiresTime: r.expiresTime.toISOString(),
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