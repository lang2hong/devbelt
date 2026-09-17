import type { FastifyInstance } from 'fastify';
import { sendError } from '../../../../middleware/errorHandler.js';
import type { ResourceType } from '../../../../domain/enums.js';
import { createResourceBody, organizationIdParam, resourceIdParam, updateResourceBody } from '../../../../route/schemas.js';
import { toResourceDetailDto, toResourceSummaryDto } from './dto.js';
import type { OrgRoutesContext } from './context.js';

/** 资源：列表 / 创建 / 详情 / 更新 / 删除（resource.read/write/delete）。 */
export async function registerResourceRoutes(org: FastifyInstance, ctx: OrgRoutesContext): Promise<void> {
  const { resources } = ctx;

  org.get('/api/db/organizations/:organizationId/resources', { config: { permission: 'resource.read' }, schema: { params: organizationIdParam } }, async (req, reply) => {
    const organizationId = (req as any).authOrganizationId as number;
    try {
      const list = await resources.listResources(organizationId);
      reply.send({ resources: list.map(toResourceSummaryDto) });
    } catch (e) {
      sendError(reply, e);
    }
  });

  org.post('/api/db/organizations/:organizationId/resources', { config: { permission: 'resource.write', aud: 'extension' }, schema: { params: organizationIdParam, body: createResourceBody } }, async (req, reply) => {
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

  org.get('/api/db/organizations/:organizationId/resources/:resourceId', { config: { permission: 'resource.read', aud: 'extension' }, schema: { params: resourceIdParam } }, async (req, reply) => {
    const organizationId = (req as any).authOrganizationId as number;
    const resourceId = Number((req.params as any).resourceId);
    try {
      const resource = await resources.getResource(organizationId, resourceId);
      reply.send({ resource: toResourceDetailDto(resource) });
    } catch (e) {
      sendError(reply, e);
    }
  });

  org.patch('/api/db/organizations/:organizationId/resources/:resourceId', { config: { permission: 'resource.write', aud: 'extension' }, schema: { params: resourceIdParam, body: updateResourceBody } }, async (req, reply) => {
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

  org.delete('/api/db/organizations/:organizationId/resources/:resourceId', { config: { permission: 'resource.delete', aud: 'extension' }, schema: { params: resourceIdParam } }, async (req, reply) => {
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
}