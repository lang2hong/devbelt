import type { FastifyInstance } from 'fastify';
import { authScope, type GetAuthUser, type GetAuthSession } from '../middleware/requireAuth.js';
import { sendError } from '../middleware/errorHandler.js';
import type { OrganizationService } from '../service/organizationService.js';
import type { MemberRole, ResourceType, ResourcePermission } from '../domain/enums.js';

export interface OrganizationRouteOptions {
  organizationService: OrganizationService;
  getUser?: GetAuthUser;
  getSession?: GetAuthSession;
}

/**
 * 组织域路由（HTTP 层）：组织 / 成员 / 共享资源 / 权限 / 组织审计。
 * 全部需认证；写操作由 OrganizationService 校验组织归属。
 */
export async function organizationRoutes(app: FastifyInstance, opts: OrganizationRouteOptions): Promise<void> {
  const svc = opts.organizationService;
  const orgId = (req: any): number => Number((req as any).params.organizationId);
  const membershipId = (req: any): number => Number((req as any).params.membershipId);
  const resourceId = (req: any): number => Number((req as any).params.resourceId);
  const body = (req: any): any => req.body;

  app.register(authScope, {
    getUser: opts.getUser,
    getSession: opts.getSession,
    routes: async (child) => {
      child.get('/api/organizations', async (req, reply) => {
        try {
          const orgs = await svc.listMyOrganizations(req.user.sub as number);
          reply.send({ organizations: orgs });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.post('/api/organizations', async (req, reply) => {
        try {
          const { organization, membership } = await svc.createOrganization(req.user.sub as number, body(req).name);
          reply.code(201).send({ organization, membership });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.get('/api/organizations/:organizationId', async (req, reply) => {
        try {
          reply.send({ organization: await svc.getOrganization(orgId(req), req.user.sub as number) });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.get('/api/organizations/:organizationId/members', async (req, reply) => {
        try {
          reply.send({ members: await svc.listMembers(orgId(req), req.user.sub as number) });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.post('/api/organizations/:organizationId/members', async (req, reply) => {
        try {
          const { userId, role } = body(req);
          const membership = await svc.addMember(orgId(req), Number(userId), role as MemberRole, req.user.sub as number);
          reply.code(201).send({ membership });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.patch('/api/organizations/:organizationId/members/:membershipId', async (req, reply) => {
        try {
          await svc.updateMemberRole(orgId(req), membershipId(req), body(req).role as MemberRole, req.user.sub as number);
          reply.send({ ok: true });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.delete('/api/organizations/:organizationId/members/:membershipId', async (req, reply) => {
        try {
          await svc.removeMember(orgId(req), membershipId(req), req.user.sub as number);
          reply.send({ ok: true });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.get('/api/organizations/:organizationId/resources', async (req, reply) => {
        try {
          const type = (req.query as any).type as ResourceType | undefined;
          reply.send({ resources: await svc.listResources(orgId(req), req.user.sub as number, type) });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.post('/api/organizations/:organizationId/resources', async (req, reply) => {
        try {
          const { resourceType, name, accessScope, encryptedData } = body(req);
          const resource = await svc.createResource(orgId(req), req.user.sub as number, {
            resourceType: resourceType as ResourceType,
            name,
            accessScope,
            encryptedData,
          });
          reply.code(201).send({ resource });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.patch('/api/organizations/:organizationId/resources/:resourceId', async (req, reply) => {
        try {
          await svc.updateResource(orgId(req), resourceId(req), req.user.sub as number, body(req));
          reply.send({ ok: true });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.delete('/api/organizations/:organizationId/resources/:resourceId', async (req, reply) => {
        try {
          await svc.softDeleteResource(orgId(req), resourceId(req), req.user.sub as number);
          reply.send({ ok: true });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.post('/api/organizations/:organizationId/resources/:resourceId/permissions', async (req, reply) => {
        try {
          const { membershipId, permission } = body(req);
          const granted = await svc.grantPermission(
            orgId(req), resourceId(req), Number(membershipId),
            permission as ResourcePermission, req.user.sub as number,
          );
          reply.code(201).send({ permission: granted });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.get('/api/organizations/:organizationId/resources/:resourceId/permissions', async (req, reply) => {
        try {
          reply.send({ permissions: await svc.listPermissions(orgId(req), resourceId(req), req.user.sub as number) });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.get('/api/organizations/:organizationId/audit', async (req, reply) => {
        try {
          const entries = await svc.listAudit(orgId(req), req.user.sub as number, 100, 0);
          reply.send({ entries });
        } catch (e) {
          sendError(reply, e);
        }
      });
    },
  });
}